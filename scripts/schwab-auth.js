#!/usr/bin/env node
// ── Schwab OAuth Re-authorization Helper ────────────────────────────────
// Schwab refresh tokens expire every 7 days. When that happens, this
// script runs the full Authorization Code flow for you:
//
//   1. Reads SCHWAB_APP_KEY / SCHWAB_APP_SECRET from .env
//   2. Spins up an HTTPS listener on 127.0.0.1:8182 (matches the
//      callback URL registered in Schwab's developer portal)
//   3. Prints the authorize URL for you to open in a browser
//   4. Catches Schwab's redirect, grabs the one-time auth code
//   5. Exchanges the code for a fresh refresh_token + access_token
//   6. Writes the new refresh token back into your .env
//      (SCHWAB_REFRESH_TOKEN) and prints it for copying elsewhere.
//
// Usage:
//   node scripts/schwab-auth.js
//
// Prerequisites:
//   - SCHWAB_APP_KEY and SCHWAB_APP_SECRET set in .env, from the app
//     you registered at developer.schwab.com.
//
// Notes:
//   - The callback needs HTTPS. We generate a self-signed cert on first
//     run (scripts/.schwab-auth-{key,cert}.pem; gitignored). Your browser
//     will warn you about the cert — click through ("advanced → proceed").
//   - The auth code is single-use and expires in ~30s, so complete the
//     login promptly after clicking the URL.
//   - The refresh token is written into .env; restart the server
//     afterwards to pick it up.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import https from "node:https";
import { URL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ENV_PATH = resolve(ROOT, ".env");
const KEY_PATH = resolve(__dirname, ".schwab-auth-key.pem");
const CERT_PATH = resolve(__dirname, ".schwab-auth-cert.pem");

const REDIRECT_URI = "https://127.0.0.1:8182";
const AUTH_URL_BASE = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";

// ── .env I/O ────────────────────────────────────────────────────────────

function loadEnv() {
  if (!existsSync(ENV_PATH)) {
    throw new Error(`.env not found at ${ENV_PATH}`);
  }
  const lines = readFileSync(ENV_PATH, "utf-8").split("\n");
  const env = {};
  for (const line of lines) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  }
  return env;
}

// ── .env writeback ───────────────────────────────────────────────────────

function updateEnvRefreshToken(newToken) {
  const content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf-8") : "";
  const line = `SCHWAB_REFRESH_TOKEN=${newToken}`;
  let next;
  if (/^SCHWAB_REFRESH_TOKEN=.*$/m.test(content)) {
    next = content.replace(/^SCHWAB_REFRESH_TOKEN=.*$/m, line);
  } else {
    next =
      content === "" || content.endsWith("\n") ? `${content}${line}\n` : `${content}\n${line}\n`;
  }
  writeFileSync(ENV_PATH, next);
}

// ── Self-signed cert bootstrap ──────────────────────────────────────────

function ensureCert() {
  if (existsSync(KEY_PATH) && existsSync(CERT_PATH)) return;
  console.log("→ generating self-signed cert for 127.0.0.1:8182 (one-time)");
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_PATH}" -out "${CERT_PATH}" -days 365 -nodes -subj "/CN=127.0.0.1" 2>/dev/null`,
    { stdio: "inherit" },
  );
}

// ── OAuth code → token exchange ─────────────────────────────────────────

async function exchangeCode(code, appKey, appSecret) {
  const basic = Buffer.from(`${appKey}:${appSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Token exchange failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

// ── HTTPS redirect listener ─────────────────────────────────────────────

function waitForCode() {
  return new Promise((resolvePromise, reject) => {
    const server = https.createServer(
      { key: readFileSync(KEY_PATH), cert: readFileSync(CERT_PATH) },
      (req, res) => {
        const url = new URL(req.url, REDIRECT_URI);
        const code = url.searchParams.get("code");
        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h2>Authorization received — you can close this tab.</h2>");
          server.close();
          resolvePromise(code);
        } else {
          const err = url.searchParams.get("error") ?? "no code in redirect";
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`Error: ${err}`);
          server.close();
          reject(new Error(err));
        }
      },
    );
    server.listen(8182, "127.0.0.1", () => {
      console.log("→ listening on https://127.0.0.1:8182 for Schwab redirect");
    });
    server.on("error", reject);
  });
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();
  const appKey = env.SCHWAB_APP_KEY;
  const appSecret = env.SCHWAB_APP_SECRET;
  if (!appKey || !appSecret) {
    throw new Error("Missing SCHWAB_APP_KEY or SCHWAB_APP_SECRET in .env");
  }

  ensureCert();

  const authUrl = `${AUTH_URL_BASE}?client_id=${encodeURIComponent(appKey)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

  console.log("");
  console.log("Open this URL in your browser and approve the app:");
  console.log("");
  console.log("  " + authUrl);
  console.log("");
  console.log("Your browser will warn about the self-signed cert at 127.0.0.1:8182 —");
  console.log("click through (Advanced → Proceed) to let Schwab's redirect complete.");
  console.log("");

  const code = await waitForCode();
  console.log("✓ auth code received, exchanging for tokens…");

  const tokens = await exchangeCode(code, appKey, appSecret);
  if (!tokens.refresh_token) {
    throw new Error(`No refresh_token in response: ${JSON.stringify(tokens)}`);
  }

  updateEnvRefreshToken(tokens.refresh_token);
  console.log("✓ wrote SCHWAB_REFRESH_TOKEN to .env");
  console.log("  expires in ~7 days — rerun this script when it fails again.");
  console.log("");
  console.log(`  new refresh token: ${tokens.refresh_token}`);
  console.log("");
  console.log("Restart the Magpie server to pick up the new token.");
}

main().catch((e) => {
  console.error("✗", e.message);
  process.exit(1);
});
