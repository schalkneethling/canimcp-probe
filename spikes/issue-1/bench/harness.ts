// LOCAL, INDICATIVE ONLY, AND WALL TIME, NOT CPU TIME. These runs execute
// inside local workerd (through the Vitest integration) and time each request
// with performance.now(). Local workerd advances that clock during CPU work,
// but only in whole milliseconds, so a single fast request reads as 0 or 1 ms
// and the mean is the more useful number. Await points are in-memory, except
// the D1 insert, whose time includes local SQLite work and I/O wait. Deployed
// CPU time is an owner-run step.
import { createMcpHandler } from "@modelcontextprotocol/server";
import { env } from "cloudflare:workers";
import { probeFetch, type ProbeOptions } from "../src/probe.ts";
import { createSpikeServerFactory } from "../src/server.ts";
import { insertRecord } from "../src/store.ts";
import { summary } from "../scripts/percentile.ts";

export const handler = createMcpHandler(createSpikeServerFactory());

export async function serve(
  init: { headers: Record<string, string>; body: string },
  withD1: boolean,
) {
  const pending: Promise<unknown>[] = [];
  const options: ProbeOptions = {
    handler,
    waitUntil: (promise) => pending.push(promise),
    mintSessionId: () => crypto.randomUUID(),
    onRecord: async (record) => {
      if (withD1) await insertRecord(env.DB, record, new Date().toISOString());
    },
  };
  const start = performance.now();
  const response = await probeFetch(
    new Request("https://probe.example.test/mcp", { method: "POST", ...init }),
    options,
  );
  const text = await response.text();
  await Promise.all(pending);
  return {
    wallMs: performance.now() - start,
    sessionId: response.headers.get("mcp-session-id"),
    text,
  };
}

export function report(samples: number[]) {
  const total = samples.reduce((sum, value) => sum + value, 0);
  return { ...summary(samples), meanWallMs: Math.round((total / samples.length) * 1000) / 1000 };
}
