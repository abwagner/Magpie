import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSecretsProvider, SecretResolutionError } from "../../index.js";

// Mock the execFile module
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

describe("SecretsProvider", () => {
  let provider = createSecretsProvider();

  beforeEach(() => {
    // Fresh provider for each test
    provider = createSecretsProvider();
    provider.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up env vars modified in tests
    delete process.env.TEST_SECRET;
    delete process.env.OP_TEST_SECRET;
    delete process.env.ANOTHER_SECRET;
    delete process.env.OP_ANOTHER_SECRET;
  });

  describe("resolveSync", () => {
    it("resolves a secret from environment variable", () => {
      process.env.TEST_SECRET = "env-value";

      const result = provider.resolveSync("TEST_SECRET");
      expect(result).toBe("env-value");
    });

    it("throws SecretResolutionError when secret not found", () => {
      expect(() => {
        provider.resolveSync("NONEXISTENT_SECRET");
      }).toThrow(SecretResolutionError);
    });

    it("caches the resolved secret", () => {
      process.env.TEST_SECRET = "env-value";

      const result1 = provider.resolveSync("TEST_SECRET");
      // Modify env var; cache should still return original
      process.env.TEST_SECRET = "different-value";
      const result2 = provider.resolveSync("TEST_SECRET");

      expect(result1).toBe("env-value");
      expect(result2).toBe("env-value"); // Cached value
    });

    it("throws descriptive error including key name", () => {
      try {
        provider.resolveSync("MISSING_KEY");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(SecretResolutionError);
        if (error instanceof SecretResolutionError) {
          expect(error.key).toBe("MISSING_KEY");
          expect(error.message).toContain("MISSING_KEY");
        }
      }
    });
  });

  describe("resolve", () => {
    it("falls back to env var when 1Password path not set", async () => {
      process.env.TEST_SECRET = "env-value";
      // Don't set OP_TEST_SECRET

      const result = await provider.resolve("TEST_SECRET");
      expect(result).toBe("env-value");
    });

    it("throws when neither 1Password nor env var resolves the key", async () => {
      // Don't set either OP_* or plain env var

      await expect(provider.resolve("NONEXISTENT")).rejects.toThrow(
        SecretResolutionError
      );
    });

    it("caches env var results", async () => {
      process.env.TEST_SECRET = "env-value";

      const result1 = await provider.resolve("TEST_SECRET");
      process.env.TEST_SECRET = "different";
      const result2 = await provider.resolve("TEST_SECRET");

      expect(result1).toBe("env-value");
      expect(result2).toBe("env-value"); // Still cached
    });
  });

  describe("cache management", () => {
    it("clears all cached entries", async () => {
      process.env.TEST_SECRET = "value1";
      process.env.ANOTHER_SECRET = "value2";

      provider.resolveSync("TEST_SECRET");
      provider.resolveSync("ANOTHER_SECRET");

      provider.clear();

      // After clearing, env-var changes should be visible
      process.env.TEST_SECRET = "new-value1";
      const result = provider.resolveSync("TEST_SECRET");
      expect(result).toBe("new-value1");
    });
  });

  describe("error handling", () => {
    it("captures key in SecretResolutionError", () => {
      const error = new SecretResolutionError("MY_KEY", "test reason");

      expect(error.key).toBe("MY_KEY");
      expect(error.reason).toBe("test reason");
      expect(error.name).toBe("SecretResolutionError");
    });
  });
});
