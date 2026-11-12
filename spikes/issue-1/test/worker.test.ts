import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/worker.ts";

async function get(url: string) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(url), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("the /__runtime diagnostic is local-only", () => {
  it("answers on a local hostname", async () => {
    const response = await get("http://127.0.0.1:8787/__runtime");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ process: "object", buffer: "function" });
  });

  it("falls through to the static assets, and so 404, on any other hostname", async () => {
    const response = await get("https://canimcp-probe-spike-1.example.workers.dev/__runtime");
    expect(response.status).toBe(404);
  });
});
