// ── Secrets Provider: 1Password-backed with env-var fallback ────────────
//
// Provides a unified interface for resolving secrets from a provider:
// - Primary backend: 1Password CLI (`op read "op://<vault>/<item>/<field>"`)
// - Fallback: environment variables (`process.env[key]`)
// - Caching: TTL-based in-memory cache to avoid repeated CLI invocations
//
// Design per QF-349: a single source of truth for secrets resolution that
// can be swapped at the provider level without changing call sites.
// Migration: existing env-var-bound configs become provider-resolved with
// env-var fallback (nothing breaks if 1Password is unavailable).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────────

export class SecretResolutionError extends Error {
  constructor(
    public key: string,
    public reason: string
  ) {
    super(`Failed to resolve secret '${key}': ${reason}`);
    this.name = "SecretResolutionError";
  }
}

export interface SecretsProvider {
  resolve(key: string): Promise<string>;
  resolveSync(key: string): string;
  clear(): void;
}

// ── Cache ──────────────────────────────────────────────────────────

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached(key: string): string | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key: string, value: string, ttlMs: number = DEFAULT_TTL_MS): void {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

// ── 1Password CLI backend ──────────────────────────────────────────

async function resolve1Password(key: string): Promise<string | null> {
  // The op:// path for a key is configured out-of-band via an `OP_<key>`
  // env var holding `op://<vault>/<item>/<field>`. Absent that mapping we
  // fall through to the plain env-var backend.
  const opPath = process.env[`OP_${key}`];
  if (!opPath) return null;

  try {
    const { stdout } = await execFileAsync("op", ["read", opPath], {
      timeout: 5000,
      encoding: "utf-8",
    });
    return stdout.trim();
  } catch {
    // 1Password CLI absent or the path is invalid — fall through to the
    // env-var backend. The terminal SecretResolutionError reports the
    // overall miss if env also lacks the key.
    return null;
  }
}

// ── Environment variable fallback ──────────────────────────────────

function resolveEnv(key: string): string | null {
  const value = process.env[key];
  return typeof value === "string" ? value : null;
}

// ── Provider implementation ────────────────────────────────────────

export function createSecretsProvider(): SecretsProvider {
  return {
    async resolve(key: string): Promise<string> {
      // Check cache first
      const cached = getCached(key);
      if (cached !== null) {
        return cached;
      }

      // Try 1Password first
      const from1pw = await resolve1Password(key);
      if (from1pw) {
        setCached(key, from1pw);
        return from1pw;
      }

      // Fall back to environment variable
      const fromEnv = resolveEnv(key);
      if (fromEnv) {
        setCached(key, fromEnv);
        return fromEnv;
      }

      // Neither source resolved the key
      throw new SecretResolutionError(
        key,
        `not found in 1Password (OP_${key}) or environment (${key})`
      );
    },

    resolveSync(key: string): string {
      // Synchronous resolution: only env-var fallback available
      // (1Password CLI requires async spawning)
      const cached = getCached(key);
      if (cached !== null) {
        return cached;
      }

      const value = resolveEnv(key);
      if (value) {
        setCached(key, value);
        return value;
      }

      throw new SecretResolutionError(
        key,
        `not found in environment (${key}) — 1Password requires async resolution`
      );
    },

    clear(): void {
      cache.clear();
    },
  };
}

// ── Singleton instance ─────────────────────────────────────────────

let instance: SecretsProvider | null = null;

export function getSecretsProvider(): SecretsProvider {
  if (!instance) {
    instance = createSecretsProvider();
  }
  return instance;
}
