/**
 * Silent logger for tests. Captures log calls for assertions.
 */
import type { Logger } from "../../logger.js";

export interface TestLogger extends Logger {
  logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>;
  clear(): void;
}

export function createTestLogger(component = "test"): TestLogger {
  const logs: TestLogger["logs"] = [];

  const log = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    logs.push({ level, msg, fields });
  };

  return {
    logs,
    clear() {
      logs.length = 0;
    },
    trace: log("trace"),
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    child(childComponent: string) {
      return createTestLogger(`${component}.${childComponent}`);
    },
  };
}
