// Settings · Risk · Policies — frontend mirror of
// server/risk/policies.ts. Server is authoritative.

import type { RiskLimits } from "./portfolio.js";

export interface RiskPolicy {
  name: string;
  description?: string;
  limits: RiskLimits;
}

export interface RiskPoliciesConfig {
  version: 1;
  policies: Record<string, RiskPolicy>;
}
