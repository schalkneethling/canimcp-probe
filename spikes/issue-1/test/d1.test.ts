import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { insertRecord } from "../src/store.ts";
import { createHarness, jsonPost, legacyInitializeBody } from "./helpers.ts";

describe("D1 rows written per request", () => {
  it("one insert into a table with three indexes writes 4 rows (local D1)", async () => {
    const harness = createHarness();
    await (await harness.serve(jsonPost(legacyInitializeBody("2025-06-18", { foo: {} })))).text();
    await harness.settle();
    const [record] = harness.records;
    if (record === undefined) throw new Error("the probe produced no record");

    const meta = await insertRecord(env.DB, record, "2026-11-12T00:00:00.000Z");

    // One table row plus one entry per index whose column the insert writes.
    expect(meta.rows_written).toBe(4);
    expect(meta.changes).toBe(1);

    // The row holds no request content: only the time, the classification
    // and the reply status (migrations/0001_probe_records.sql).
    const row = await env.DB.prepare("SELECT * FROM probe_records WHERE id = ?1")
      .bind(meta.last_row_id)
      .first();
    expect(row).toEqual({
      id: meta.last_row_id,
      received_at: "2026-11-12T00:00:00.000Z",
      classification_kind: "legacy",
      classification_era: null,
      reply_status: 200,
    });
  });

  it("still writes 4 rows when an indexed column is NULL", async () => {
    const harness = createHarness();
    await (await harness.serve(jsonPost(""))).text();
    await harness.settle();
    const [record] = harness.records;
    if (record === undefined) throw new Error("the probe produced no record");

    const meta = await insertRecord(env.DB, record, "2026-11-12T00:00:01.000Z");
    expect(meta.rows_written).toBe(4);
  });
});
