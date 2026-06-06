// ── aisstream Adapter (placeholder) ────────────────────────────────
// aisstream.io publishes ship AIS positions over a JSON WebSocket. The
// data-signals Python pipeline (data-sources/pipelines/aisstream_census.py)
// uses asyncio + websockets to subscribe and run a per-MMSI census state
// machine. Per the migration plan this stays Python, bridged into Magpie
// via NATS (same precedent as databento.ts).
//
// This file reserves the `aisstream` adapter slot in the registry so
// signal manifests can declare `source: aisstream` once the NATS bridge
// is wired. Until then, fetch() returns "not yet migrated" — no signal
// currently consumes aisstream so this is non-blocking.
//
// Implementation plan (future session):
//   1. Move data-signals/data-sources/pipelines/aisstream_census.py into
//      Magpie/sidecars/aisstream/ as a long-running Python
//      service. Publish census events to NATS subject `aisstream.census`.
//   2. Add a docker-compose service for the sidecar (mirrors databento).
//   3. Replace this fetch() with a NATS consumer that reads the subject
//      stream and writes parquets via storage.mergeAndWriteParquetAuto
//      on a schedule.

import type { DataAdapter, DataRequest, DataResult } from "../adapter.js";

export function createAisstreamAdapter(): DataAdapter {
  return {
    id: "aisstream",
    capabilities: { batch: false, streaming: true, maxConcurrent: 1 },
    async fetch(requests: DataRequest[]): Promise<DataResult[]> {
      return requests.map((req) => ({
        request: req,
        ok: false,
        error:
          "aisstream adapter not yet migrated. Python sidecar + NATS bridge pending — see comment in adapters/aisstream.ts.",
      }));
    },
  };
}
