// See bench/harness.ts: local workerd, whole-millisecond WALL time.
// Run: npm run bench:workerd (each bench file runs in its own Vitest process,
// so "cold" means the first request after the isolate loaded the SDK).
import { it } from "vitest";
import { legacyInitialize, legacyToolsCall, modernToolsCall } from "../scripts/requests.ts";
import { sseReadCost } from "../scripts/sse-cost.ts";
import { report, serve } from "./harness.ts";

const RUNS = 100;

it("times the probe in local workerd (wall time)", async () => {
  const coldModern = (await serve(modernToolsCall(-1), false)).wallMs;
  const results: Record<string, unknown> = { coldModernToolsCallWallMs: coldModern };
  let initText = "";
  for (const withD1 of [false, true]) {
    const modern: number[] = [];
    for (let i = 0; i < RUNS; i++) modern.push((await serve(modernToolsCall(i), withD1)).wallMs);
    const pairs: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const init = await serve(legacyInitialize(i), withD1);
      initText = init.text;
      const call = await serve(legacyToolsCall(i, init.sessionId), withD1);
      pairs.push(init.wallMs + call.wallMs);
    }
    results[withD1 ? "warmWithD1" : "warmWithoutD1"] = {
      modernToolsCall: report(modern),
      legacyPair: report(pairs),
    };
  }
  results["sseFullReadWallMs"] = await sseReadCost(initText, RUNS * 10, () => performance.now());
  console.log(
    JSON.stringify({
      label: "LOCAL workerd WALL ms per request (whole-ms clock; indicative only)",
      results,
    }),
  );
});
