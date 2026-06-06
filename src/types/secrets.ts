// Settings · System · Secrets — frontend mirror of server/auth/secrets-status.ts.
// Server is authoritative; keep this in sync when adding new categories or
// fields.

export type SecretCategory =
  | "broker-schwab"
  | "broker-ibkr"
  | "market-data"
  | "external-signals"
  | "storage";

export interface SecretStatus {
  name: string;
  env_var: string;
  set: boolean;
  category: SecretCategory;
  instructions?: string;
  expires_at?: string;
  reauth_command?: string;
}

export interface SecretsStatusResponse {
  generated_at: string;
  secrets: SecretStatus[];
}
