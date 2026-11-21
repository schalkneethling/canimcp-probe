// Sends the CPU-run traffic to a running Worker over HTTP: 100 modern
// tools/call requests and 100 legacy initialize + tools/call pairs, first to
// /mcp (no storage) and then to /mcp-d1 (one D1 insert per request).
//
// Every request is appended to the output file as one JSON line the moment it
// finishes, and a non-2xx answer (for example a cold-start Error 1102) is
// recorded and the run continues, so a failed run still leaves partial data.
// Each scenario ends with a "window" line giving its UTC start and end, which
// scripts/owner-cpu-graphql.ts uses to query the deployed CPU time.
//
// Against `wrangler dev --local` the times are LOCAL wall-clock times, which
// say nothing about deployed CPU time.
//
// Usage: node scripts/bench-http.ts <base-url> [runs=100] [out=.tmp/bench-http.ndjson] [gapMs=65000]
// The gap after each scenario keeps the time windows apart; pass 0 locally.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { summary } from "./percentile.ts";
import { legacyInitialize, legacyToolsCall, modernToolsCall } from "./requests.ts";

const base = process.argv[2];
if (base === undefined) {
  console.error(
    "Usage: node scripts/bench-http.ts <base-url> [runs=100] [out=.tmp/bench-http.ndjson] [gapMs=65000]",
  );
  process.exit(64);
}
const runs = Number(process.argv[3] ?? 100);
const out = process.argv[4] ?? ".tmp/bench-http.ndjson";
const gapMs = Number(process.argv[5] ?? 65_000);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, "");
const write = (line: unknown) => appendFileSync(out, `${JSON.stringify(line)}\n`);

type Outcome = { status: number; wallMs: number; sessionId: string | null };

async function post(
  scenario: string,
  path: string,
  i: number,
  init: { headers: Record<string, string>; body: string },
): Promise<Outcome> {
  const start = performance.now();
  let outcome: Outcome;
  try {
    const response = await fetch(new URL(path, base), { method: "POST", ...init });
    await response.text();
    outcome = {
      status: response.status,
      wallMs: performance.now() - start,
      sessionId: response.headers.get("mcp-session-id"),
    };
  } catch (error) {
    // A network failure is recorded as status 0 rather than ending the run.
    outcome = { status: 0, wallMs: performance.now() - start, sessionId: null };
    write({ scenario, path, i, error: String(error) });
  }
  write({
    scenario,
    path,
    i,
    at: new Date().toISOString(),
    status: outcome.status,
    wallMs: outcome.wallMs,
  });
  return outcome;
}

async function scenario(name: string, path: string, body: (i: number) => Promise<Outcome[]>) {
  const startUtc = new Date().toISOString();
  const outcomes: Outcome[] = [];
  for (let i = 0; i < runs; i++) outcomes.push(...(await body(i)));
  const endUtc = new Date().toISOString();
  const window = {
    window: name,
    path,
    startUtc,
    endUtc,
    requests: outcomes.length,
    non2xx: outcomes.filter((outcome) => outcome.status < 200 || outcome.status > 299).length,
    localWallMs: summary(outcomes.map((outcome) => outcome.wallMs)),
  };
  write(window);
  await new Promise((resolve) => setTimeout(resolve, gapMs));
  return window;
}

const windows = [];
for (const path of ["/mcp", "/mcp-d1"]) {
  windows.push(
    await scenario("modern tools/call", path, async (i) => [
      await post("modern tools/call", path, i, modernToolsCall(i)),
    ]),
  );
  windows.push(
    await scenario("legacy initialize + tools/call", path, async (i) => {
      const init = await post("legacy initialize", path, i, legacyInitialize(i));
      const call = await post("legacy tools/call", path, i, legacyToolsCall(i, init.sessionId));
      return [init, call];
    }),
  );
}

console.log(
  JSON.stringify(
    {
      base,
      runs,
      out,
      note: "wall-clock times measured by this client, not Worker CPU time",
      windows,
    },
    null,
    2,
  ),
);
