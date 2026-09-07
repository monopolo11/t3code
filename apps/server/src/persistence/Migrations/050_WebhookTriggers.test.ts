import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.effect("adds webhook storage after the active thread order migration", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 49 });
    assert.deepEqual(yield* runMigrations(), [[50, "WebhookTriggers"]]);

    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
    assert.ok(columns.some((column) => column.name === "branch_pull_request_json"));
    assert.ok(columns.some((column) => column.name === "active_order_key"));
    yield* sql`INSERT INTO webhook_triggers (id, config_json) VALUES ('trigger', '{}')`;
    yield* sql`INSERT INTO webhook_deliveries (id, trigger_id, thread_id, job_json, created_at)
      VALUES ('delivery', 'trigger', 'thread', '{}', '2026-09-06T00:00:00.000Z')`;
    const deliveries = yield* sql<{
      readonly status: string;
    }>`SELECT status FROM webhook_deliveries`;
    assert.equal(deliveries[0]?.status, "pending");
    assert.deepEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
