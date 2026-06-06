// ── useSessionToken hook ────────────────────────────────────────────
// Placeholder for the existing user-session token referenced in
// QF-112's acceptance. The actual session-token issuance flow is a
// separate piece of work; this hook reads from localStorage so the
// WS layer can already pass `?token=<jwt>` through and the server
// side has something to validate against once the proxy lands.
//
// Today: returns whatever's in `qf.session_token`, or null.
// Tomorrow: replaced by a real OAuth/session integration, with no
// surface change at the call sites.

import { useEffect, useState } from "react";

export const SESSION_TOKEN_STORAGE_KEY = "qf.session_token";

function readToken(): string | null {
  try {
    const raw = window.localStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    // SSR or storage-denied browsers — degrade to null.
    return null;
  }
}

export function useSessionToken(): string | null {
  const [token, setToken] = useState<string | null>(() => readToken());

  useEffect(() => {
    // React to cross-tab storage changes so a logout in tab A
    // immediately invalidates the WS connection in tab B.
    function onStorage(e: StorageEvent) {
      if (e.key !== SESSION_TOKEN_STORAGE_KEY) return;
      setToken(e.newValue && e.newValue.length > 0 ? e.newValue : null);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return token;
}
