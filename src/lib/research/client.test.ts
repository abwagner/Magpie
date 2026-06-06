// Tests for the orchestrator HTTP client. Uses a stub fetch passed
// into the per-call FetchOptions so we don't have to mock global
// fetch.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ORCHESTRATOR_URL,
  ResearchApiError,
  getJob,
  healthz,
  listJobs,
  orchestratorUrl,
  submitJob,
} from "./client.js";
import type { JobAccepted, JobList, JobStatus, JobSubmission } from "../../types/research.js";

function ok<T>(body: T): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  }) as unknown as typeof fetch;
}

function err(status: number, body: unknown = {}): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("orchestratorUrl", () => {
  it("defaults to localhost:8080 when no env override", () => {
    expect(orchestratorUrl()).toBe(DEFAULT_ORCHESTRATOR_URL);
  });
});

describe("submitJob", () => {
  it("POSTs JSON to /jobs and returns the JobAccepted payload", async () => {
    const sub: JobSubmission = {
      kind: "single",
      config: {
        strategy_id: "x",
        strategy_version: "v1",
        params: {},
        start_date: "2024-01-01",
        end_date: "2024-12-31",
        portfolio: "p",
      },
    };
    const accepted: JobAccepted = {
      job_id: "j1",
      state: "pending",
      submitted_at: "2026-05-15T20:00:00Z",
    };
    const fetchImpl = ok(accepted);
    const got = await submitJob(sub, { fetchImpl });
    expect(got).toEqual(accepted);

    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = mock.mock.calls[0]!;
    expect(url).toBe(`${DEFAULT_ORCHESTRATOR_URL}/jobs`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(sub);
  });

  it("throws ResearchApiError with status + detail on 4xx", async () => {
    const fetchImpl = err(400, { detail: "validation failed: bad date" });
    await expect(
      submitJob(
        {
          kind: "single",
          config: {
            strategy_id: "x",
            strategy_version: "v1",
            params: {},
            start_date: "bad",
            end_date: "bad",
            portfolio: "p",
          },
        },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "ResearchApiError",
      status: 400,
      message: "validation failed: bad date",
    });
  });

  it("falls back to a generic message when the body has no detail", async () => {
    const fetchImpl = err(500, {});
    try {
      await submitJob({} as JobSubmission, { fetchImpl });
      expect.fail("expected rejection");
    } catch (e) {
      const err = e as ResearchApiError;
      expect(err.status).toBe(500);
      expect(err.message).toContain("HTTP 500");
    }
  });
});

describe("listJobs", () => {
  it("GETs /jobs with no query string by default", async () => {
    const fetchImpl = ok<JobList>({ jobs: [] });
    await listJobs(undefined, { fetchImpl });
    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls[0]?.[0]).toBe(`${DEFAULT_ORCHESTRATOR_URL}/jobs`);
  });

  it("appends ?state= when a state filter is supplied", async () => {
    const fetchImpl = ok<JobList>({ jobs: [] });
    await listJobs("running", { fetchImpl });
    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls[0]?.[0]).toBe(`${DEFAULT_ORCHESTRATOR_URL}/jobs?state=running`);
  });

  it("urlencodes weird state values", async () => {
    const fetchImpl = ok<JobList>({ jobs: [] });
    // The type system would normally prevent this; pass through `as`
    // to confirm the URL-encoding still works defensively.
    await listJobs("a b" as "running", { fetchImpl });
    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls[0]?.[0]).toContain("state=a%20b");
  });
});

describe("getJob", () => {
  it("GETs /jobs/{id} and returns JobStatus", async () => {
    const status: JobStatus = {
      job_id: "abc",
      state: "completed",
      submitted_at: "2026-05-15T20:00:00Z",
      result: null,
    };
    const fetchImpl = ok(status);
    const got = await getJob("abc", { fetchImpl });
    expect(got).toEqual(status);
  });

  it("urlencodes the job id", async () => {
    const fetchImpl = ok<JobStatus>({} as JobStatus);
    await getJob("job/with/slash", { fetchImpl });
    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls[0]?.[0]).toContain("job%2Fwith%2Fslash");
  });

  it("raises ResearchApiError with 404 on missing job", async () => {
    const fetchImpl = err(404, { detail: "job xyz not found" });
    await expect(getJob("xyz", { fetchImpl })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("healthz", () => {
  it("returns the live response body", async () => {
    const fetchImpl = ok({ status: "ok", version: "0.0.1" });
    const got = await healthz({ fetchImpl });
    expect(got).toEqual({ status: "ok", version: "0.0.1" });
  });
});
