// OWNER-RUN STEP 4b, the fallback when the GraphQL metrics in step 4a have
// no p95. Computes p50 and p95 CPU time from exported invocation events, one
// file per time window printed by bench-http.ts. Those events exist only on
// the with-invocation-logs environment, which must be deleted after use.
//
// The exact export shape was not verifiable without an account, so this walks
// the JSON and collects every number stored under a CPU-time key:
//   - "$workers.cpuTimeMs", or a nested { "$workers": { "cpuTimeMs": n } }:
//     the key the Query Builder page uses in its examples
//     (https://developers.cloudflare.com/workers/observability/query-builder/).
//     The Workers Logs page does not name the key.
//   - "cpuTime": TraceItem.cpuTime in the generated worker-configuration.d.ts,
//     which Tail Workers receive.
//   - "CPUTimeMs": the Logpush workers_trace_events field
//     (https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/workers_trace_events/).
// Input may be one JSON document or newline-delimited JSON.
//
// Usage: node scripts/cpu-percentiles.ts <events.json> [more.json ...]
import { readFileSync } from "node:fs";
import { summary } from "./percentile.ts";

const CPU_KEYS = new Set(["$workers.cpuTimeMs", "cpuTimeMs", "cpuTime", "CPUTimeMs"]);

function collect(value: unknown, into: number[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (CPU_KEYS.has(key) && typeof child === "number") into.push(child);
    else collect(child, into);
  }
}

function parse(text: string): unknown[] {
  try {
    return [JSON.parse(text)];
  } catch {
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  }
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: node scripts/cpu-percentiles.ts <events.json> [more.json ...]");
  process.exit(64);
}

for (const file of files) {
  const values: number[] = [];
  for (const document of parse(readFileSync(file, "utf8"))) collect(document, values);
  if (values.length === 0) {
    console.log(
      JSON.stringify({ file, error: "no CPU-time fields found; check the export shape" }),
    );
    continue;
  }
  console.log(JSON.stringify({ file, cpuTimeMs: summary(values) }));
}
