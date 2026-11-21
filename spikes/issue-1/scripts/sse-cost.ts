import { negotiatedVersionFromSse } from "../src/sse.ts";

/**
 * The full cost of the probe reading the negotiated version from an SSE
 * reply: tee() the body, read both branches to the end (the client's branch
 * stands in for the bytes sent to the client), and scan the probe's copy.
 * The baseline reads one untouched body, which is what the client costs
 * anyway, so `perReplyMs` is the probe's extra cost.
 *
 * `clock` returns milliseconds: process CPU time in Node, performance.now()
 * in workerd.
 */
export async function sseReadCost(sseText: string, iterations: number, clock: () => number) {
  const bodyOf = () => new Response(sseText, { headers: { "content-type": "text/event-stream" } });

  let start = clock();
  for (let i = 0; i < iterations; i++) await bodyOf().text();
  const baselineMs = clock() - start;

  start = clock();
  for (let i = 0; i < iterations; i++) {
    const response = bodyOf();
    if (response.body === null) throw new Error("no body");
    const [forClient, forProbe] = response.body.tee();
    const [, probeText] = await Promise.all([
      new Response(forClient).text(),
      new Response(forProbe).text(),
    ]);
    negotiatedVersionFromSse(probeText);
  }
  const teeReadScanMs = clock() - start;

  start = clock();
  for (let i = 0; i < iterations; i++) negotiatedVersionFromSse(sseText);
  const scanOnlyMs = clock() - start;

  const per = (total: number) => Math.round((total / iterations) * 10_000) / 10_000;
  return {
    iterations,
    sseBytes: sseText.length,
    baselineReadPerReplyMs: per(baselineMs),
    teeReadScanPerReplyMs: per(teeReadScanMs),
    extraPerReplyMs: per(teeReadScanMs - baselineMs),
    scanOnlyPerReplyMs: per(scanOnlyMs),
  };
}
