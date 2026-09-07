import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE webhook_triggers (id TEXT PRIMARY KEY, config_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE webhook_deliveries (
    id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    job_json TEXT NOT NULL, command_json TEXT, status TEXT NOT NULL DEFAULT 'pending',
    error TEXT, created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX webhook_deliveries_status ON webhook_deliveries(status, created_at)`;
});
