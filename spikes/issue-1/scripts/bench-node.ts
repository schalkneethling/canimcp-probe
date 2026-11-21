// LOCAL, INDICATIVE ONLY. Measures CPU time per invocation of the probe plus
// the SDK in Node (same V8 engine as workerd, different runtime), using
// process.cpuUsage() around each request. It cannot include D1, because D1
// needs the Workers runtime; D1 waiting is I/O and does not count as CPU on
// Cloudflare (https://developers.cloudflare.com/workers/platform/limits/#cpu-time).
// Usage: node scripts/bench-node.ts [runs=100] [warmup=20] [legacy-first]
import { createMcpHandler, preloadSchemas } from "@modelcontextprotocol/server";
import { probeFetch, type ProbeOptions } from "../src/probe.ts";
import { createSpikeServerFactory } from "../src/server.ts";
import { negotiatedVersionFromSse, predictNegotiatedVersion } from "../src/sse.ts";
import { summary } from "./percentile.ts";
import { sseReadCost } from "./sse-cost.ts";
import { legacyInitialize, legacyToolsCall, modernToolsCall } from "./requests.ts";

const runs = Number(process.argv[2] ?? 100);
const warmup = Number(process.argv[3] ?? 20);
const URL_ = "https://probe.example.test/mcp";

const handler = createMcpHandler(createSpikeServerFactory());

/** CPU milliseconds (user + system) spent serving one request to completion, recording included. */
async function serve(init: {
  headers: Record<string, string>;
  body: string;
}): Promise<{ cpuMs: number; response: Response; text: string }> {
  const pending: Promise<unknown>[] = [];
  const options: ProbeOptions = {
    handler,
    onRecord: () => {},
    waitUntil: (promise) => pending.push(promise),
    mintSessionId: () => crypto.randomUUID(),
  };
  const start = process.cpuUsage();
  const response = await probeFetch(new Request(URL_, { method: "POST", ...init }), options);
  const text = await response.text();
  await Promise.all(pending);
  const used = process.cpuUsage(start);
  return { cpuMs: (used.user + used.system) / 1000, response, text };
}

async function modernRun(count: number) {
  const samples: number[] = [];
  for (let i = 0; i < count; i++) samples.push((await serve(modernToolsCall(i))).cpuMs);
  return samples;
}

async function legacyPairs(count: number) {
  const pairs: number[] = [];
  const initOnly: number[] = [];
  for (let i = 0; i < count; i++) {
    const init = await serve(legacyInitialize(i));
    const call = await serve(legacyToolsCall(i, init.response.headers.get("mcp-session-id")));
    initOnly.push(init.cpuMs);
    pairs.push(init.cpuMs + call.cpuMs);
  }
  return { pairs, initOnly };
}

function sseParseCost(count: number, sseText: string) {
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = process.hrtime.bigint();
    negotiatedVersionFromSse(sseText);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  const predicted: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = process.hrtime.bigint();
    predictNegotiatedVersion("2025-06-18");
    predicted.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return { sseParse: samples, predict: predicted };
}

// The workerd build of the SDK calls preloadSchemas() at module load
// (dist/shimsWorkerd.mjs), so on a Worker this cost lands in startup, not in
// the first request. Node's shim does not, so call it here to match.
const preloadStart = process.cpuUsage();
preloadSchemas();
const preloadUsed = process.cpuUsage(preloadStart);
const preloadMs = (preloadUsed.user + preloadUsed.system) / 1000;

// Pass "legacy-first" to measure a cold legacy initialize instead of a cold
// modern tools/call. Whichever runs second is no longer cold.
const legacyFirst = process.argv[4] === "legacy-first";
const first: Record<string, number> = {};
if (legacyFirst) {
  first["coldLegacyInitialize"] = (await serve(legacyInitialize(-1))).cpuMs;
  first["thenModernToolsCall"] = (await serve(modernToolsCall(-1))).cpuMs;
} else {
  first["coldModernToolsCall"] = (await serve(modernToolsCall(-1))).cpuMs;
  first["thenLegacyInitialize"] = (await serve(legacyInitialize(-1))).cpuMs;
}
await modernRun(warmup);
await legacyPairs(warmup);

const modern = await modernRun(runs);
const legacy = await legacyPairs(runs);
const initText = (await serve(legacyInitialize(0))).text;
const parse = sseParseCost(runs * 10, initText);
const cpuClock = () => {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1000;
};
const fullSseCost = await sseReadCost(initText, runs * 10, cpuClock);

const round = (value: number) => Math.round(value * 1000) / 1000;
const show = (values: number[]) =>
  Object.fromEntries(Object.entries(summary(values)).map(([key, value]) => [key, round(value)]));

console.log(
  JSON.stringify(
    {
      label: "LOCAL Node CPU ms per invocation (indicative only, not a deployed measurement)",
      node: process.version,
      runs,
      warmup,
      preloadSchemasAtStartup: round(preloadMs),
      firstRequestsAfterPreload: Object.fromEntries(
        Object.entries(first).map(([key, value]) => [key, round(value)]),
      ),
      modernToolsCall: show(modern),
      legacyInitializePlusToolsCallPair: show(legacy.pairs),
      legacyInitializeOnly: show(legacy.initOnly),
      sseBodyBytes: initText.length,
      negotiatedVersionFromSseWallMs: show(parse.sseParse),
      predictNegotiatedVersionWallMs: show(parse.predict),
      sseFullReadCpuMs: fullSseCost,
    },
    null,
    2,
  ),
);
