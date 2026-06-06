/**
 * NATS test helper — connects to a real NATS server (Docker).
 * Requires: docker compose up -d nats
 */
import {
  connect,
  NatsConnection,
  JetStreamManager,
  JetStreamClient,
  RetentionPolicy,
  DiscardPolicy,
  StorageType,
} from "nats";

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";

let sharedConnection: NatsConnection | null = null;

export async function getNatsConnection(): Promise<NatsConnection> {
  if (sharedConnection && !sharedConnection.isClosed()) {
    return sharedConnection;
  }
  sharedConnection = await connect({ servers: NATS_URL });
  return sharedConnection;
}

export async function getJetStream(): Promise<{ jsm: JetStreamManager; js: JetStreamClient }> {
  const nc = await getNatsConnection();
  const jsm = await nc.jetstreamManager();
  const js = nc.jetstream();
  return { jsm, js };
}

/**
 * Ensure the SIGNALS stream exists for testing.
 * Deletes and recreates to get a clean state.
 */
export async function resetSignalsStream(): Promise<void> {
  const { jsm } = await getJetStream();
  try {
    await jsm.streams.delete("SIGNALS");
  } catch {
    // Stream doesn't exist yet — fine
  }
  await jsm.streams.add({
    name: "SIGNALS",
    subjects: ["signals.>"],
    retention: RetentionPolicy.Limits,
    discard: DiscardPolicy.Old,
    max_age: 7 * 24 * 60 * 60 * 1_000_000_000, // 7 days in nanos
    max_bytes: 50 * 1024 * 1024, // 50MB for tests (not 50GB)
    storage: StorageType.Memory, // memory storage for speed in tests
    num_replicas: 1,
    duplicate_window: 2 * 60 * 1_000_000_000, // 2 min in nanos
  });
}

/**
 * Drain and close the shared NATS connection.
 */
export async function closeNats(): Promise<void> {
  if (sharedConnection && !sharedConnection.isClosed()) {
    await sharedConnection.drain();
    sharedConnection = null;
  }
}
