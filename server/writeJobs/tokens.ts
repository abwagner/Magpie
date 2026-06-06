// ── Write-Job Token Store (M10-1) ─────────────────────────────────
//
// Per-actor bearer tokens for the write-dispatch API. Modelled on
// `server/signals/token-store.ts` — same on-disk JSON, same atomic
// write, same constant-time lookup — but the scoping unit is
// `scopes: string[]` (a list of allowed job kinds) rather than
// `model_ids`. A token with `scopes: ["*"]` is wildcard (any kind).

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface WriteJobTokenEntry {
  /** Stable per-token id (separate from the token value). */
  token_id: string;
  /** Named actor identity recorded on every job this token submits. */
  actor: string;
  /** Allowed kinds. `["*"]` means any kind. */
  scopes: string[];
  /** RFC3339 issuance time. */
  issued_at: string;
  /** Set true after revocation; entry is kept for audit. */
  revoked: boolean;
  /** SHA-256 hex digest of the bearer token. The plaintext token is
   *  returned only by `issue()` and is never persisted. */
  token_hash: string;
}

export interface IssuedWriteJobToken {
  /** Plaintext bearer token — show once, never stored. */
  token: string;
  entry: WriteJobTokenEntry;
}

const TOKEN_BYTES = 32; // 256 bits of entropy
const STORE_VERSION = 1;

export interface WriteJobTokenStore {
  issue(input: { actor: string; scopes: string[] }): Promise<IssuedWriteJobToken>;
  revoke(tokenId: string): Promise<boolean>;
  lookup(presented: string): Promise<WriteJobTokenEntry | null>;
  list(): Promise<WriteJobTokenEntry[]>;
  reload(): Promise<void>;
}

interface StoreFile {
  version: number;
  tokens: WriteJobTokenEntry[];
}

export interface FileWriteJobTokenStoreOptions {
  /** Absolute path to the JSON store. */
  path: string;
  now?: () => Date;
  random?: (n: number) => Buffer;
}

export function createFileWriteJobTokenStore(
  opts: FileWriteJobTokenStoreOptions,
): WriteJobTokenStore {
  const now = opts.now ?? (() => new Date());
  const random = opts.random ?? randomBytes;
  let cache: WriteJobTokenEntry[] | null = null;

  async function read(): Promise<WriteJobTokenEntry[]> {
    if (cache !== null) return cache;
    try {
      const buf = await fs.readFile(opts.path, "utf8");
      const parsed = JSON.parse(buf) as StoreFile;
      if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.tokens)) {
        throw new Error(`write-job token-store: malformed file at ${opts.path}`);
      }
      if (parsed.version !== STORE_VERSION) {
        throw new Error(
          `write-job token-store: unsupported version ${parsed.version} (expected ${STORE_VERSION})`,
        );
      }
      cache = parsed.tokens;
      return cache;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        cache = [];
        return cache;
      }
      throw err;
    }
  }

  async function write(tokens: WriteJobTokenEntry[]): Promise<void> {
    cache = tokens;
    const body: StoreFile = { version: STORE_VERSION, tokens };
    await fs.mkdir(dirname(opts.path), { recursive: true });
    const tmp = `${opts.path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
    await fs.rename(tmp, opts.path);
  }

  return {
    async issue(input) {
      if (!input.actor) {
        throw new Error("write-job token-store.issue: actor is required");
      }
      if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
        throw new Error("write-job token-store.issue: scopes must be a non-empty array");
      }
      const tokens = await read();
      const tokenBytes = random(TOKEN_BYTES);
      const plaintext = tokenBytes.toString("base64url");
      const entry: WriteJobTokenEntry = {
        token_id: random(16).toString("hex"),
        actor: input.actor,
        scopes: [...input.scopes],
        issued_at: now().toISOString(),
        revoked: false,
        token_hash: hashToken(plaintext),
      };
      await write([...tokens, entry]);
      return { token: plaintext, entry };
    },

    async revoke(tokenId) {
      const tokens = await read();
      const idx = tokens.findIndex((t) => t.token_id === tokenId);
      if (idx === -1) return false;
      const existing = tokens[idx]!;
      if (existing.revoked) return true; // idempotent
      const updated = tokens.slice();
      updated[idx] = { ...existing, revoked: true };
      await write(updated);
      return true;
    },

    async lookup(presented) {
      if (!presented) return null;
      const tokens = await read();
      const presentedHash = hashToken(presented);
      for (const entry of tokens) {
        if (entry.revoked) continue;
        if (entry.token_hash.length !== presentedHash.length) continue;
        const a = Buffer.from(entry.token_hash, "hex");
        const b = Buffer.from(presentedHash, "hex");
        if (a.length !== b.length) continue;
        if (timingSafeEqual(a, b)) return entry;
      }
      return null;
    },

    async list() {
      return (await read()).slice();
    },

    async reload() {
      cache = null;
      await read();
    },
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ── In-memory store (for tests) ────────────────────────────────────

export function createMemoryWriteJobTokenStore(): WriteJobTokenStore {
  const tokens: WriteJobTokenEntry[] = [];
  return {
    async issue(input) {
      if (!input.actor) throw new Error("write-job token-store.issue: actor is required");
      if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
        throw new Error("write-job token-store.issue: scopes must be a non-empty array");
      }
      const plaintext = randomBytes(TOKEN_BYTES).toString("base64url");
      const entry: WriteJobTokenEntry = {
        token_id: randomBytes(16).toString("hex"),
        actor: input.actor,
        scopes: [...input.scopes],
        issued_at: new Date().toISOString(),
        revoked: false,
        token_hash: hashToken(plaintext),
      };
      tokens.push(entry);
      return { token: plaintext, entry };
    },
    async revoke(tokenId) {
      const idx = tokens.findIndex((t) => t.token_id === tokenId);
      if (idx === -1) return false;
      tokens[idx] = { ...tokens[idx]!, revoked: true };
      return true;
    },
    async lookup(presented) {
      if (!presented) return null;
      const presentedHash = hashToken(presented);
      for (const entry of tokens) {
        if (entry.revoked) continue;
        if (entry.token_hash === presentedHash) return entry;
      }
      return null;
    },
    async list() {
      return tokens.slice();
    },
    async reload() {
      // no-op
    },
  };
}

export function hasScope(entry: WriteJobTokenEntry, kind: string): boolean {
  return entry.scopes.includes("*") || entry.scopes.includes(kind);
}
