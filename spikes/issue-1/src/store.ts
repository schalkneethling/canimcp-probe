import type { ProbeRecord } from "./probe.ts";

/**
 * MEASUREMENT ONLY: one insert per request into the spike table
 * (migrations/0001_probe_records.sql), returning D1's own meta so the caller
 * can read rows_written. It writes no request content.
 */
export async function insertRecord(
  db: D1Database,
  record: ProbeRecord,
  receivedAt: string,
): Promise<D1Meta> {
  const { classification } = record;
  const era = classification.kind === "modern" ? classification.era : null;
  const result = await db
    .prepare(
      "INSERT INTO probe_records (received_at, classification_kind, classification_era, reply_status) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(receivedAt, classification.kind, era, record.reply.status)
    .run();
  return result.meta;
}
