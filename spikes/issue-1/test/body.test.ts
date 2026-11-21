import { readRequestBody } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { PROBE_MAX_BODY_BYTES } from "../src/probe.ts";
import { BOTH_ACCEPT, createHarness, ENDPOINT, headersOf, jsonPost } from "./helpers.ts";

const CAP = 64 * 1024;

function withContentLength(size: number): Request {
  const body = "x".repeat(size);
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: BOTH_ACCEPT,
      "content-length": String(size),
    },
    body,
  });
}

/** A streamed body with no Content-Length header, delivered in 4 KiB chunks. */
function chunked(size: number): Request {
  const chunk = new TextEncoder().encode("x".repeat(4096));
  let remaining = size;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const length = Math.min(remaining, chunk.byteLength);
      controller.enqueue(chunk.slice(0, length));
      remaining -= length;
    },
  });
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: BOTH_ACCEPT },
    body: stream,
    duplex: "half",
  } as RequestInit);
}

describe("readRequestBody under a 64 KiB cap", () => {
  it("uses the same cap as the probe", () => {
    expect(PROBE_MAX_BODY_BYTES).toBe(CAP);
  });

  it("readRequestBody refuses 64 KiB + 1 with a Content-Length header, without reading or throwing", async () => {
    const request = withContentLength(CAP + 1);
    expect(request.headers.get("content-length")).toBe(String(CAP + 1));

    const result = await readRequestBody(request, CAP);

    expect(result).toEqual({ tooLarge: true });
    // Refused from the header alone (dist/index.mjs line 276): the body is untouched.
    expect(request.bodyUsed).toBe(false);
  });

  it("readRequestBody refuses 64 KiB + 1 sent chunked with no Content-Length, without throwing", async () => {
    const request = chunked(CAP + 1);
    expect(request.headers.get("content-length")).toBeNull();

    const result = await readRequestBody(request, CAP);

    expect(result).toEqual({ tooLarge: true });
    // Refused while streaming (dist/index.mjs line 290): the body was consumed.
    expect(request.bodyUsed).toBe(true);
  });

  it("readRequestBody accepts exactly 64 KiB, with and without Content-Length", async () => {
    for (const request of [withContentLength(CAP), chunked(CAP)]) {
      const result = await readRequestBody(request, CAP);
      expect(result.tooLarge).toBe(false);
      expect(result.tooLarge === false && result.text.length).toBe(CAP);
    }
  });

  it("probe answers 413 itself for both framings and never calls the SDK", async () => {
    for (const request of [withContentLength(CAP + 1), chunked(CAP + 1)]) {
      const harness = createHarness();
      const response = await harness.serve(request);
      await harness.settle();

      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000 },
      });
      expect(harness.instances).toHaveLength(0);
      expect(harness.records[0]?.classification).toEqual({ kind: "unparsed", why: "too-large" });
    }
  });
});

describe("a body that was already read when handler.fetch gets no parsedBody", () => {
  const bodies = [
    ["truncated JSON", '{"jsonrpc":'],
    ["an empty body", ""],
    ["a valid JSON-RPC request", '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'],
  ] as const;

  for (const [label, body] of bodies) {
    it(`after readRequestBody, workerd answers -32700 as if the body were empty (${label})`, async () => {
      const harness = createHarness();
      const request = jsonPost(body);
      await readRequestBody(request, CAP);
      expect(request.bodyUsed).toBe(true);

      // classifyEntryRequest calls request.clone() when parsedBody is
      // undefined (dist/index.mjs line 1173). The Fetch standard says cloning
      // a used body throws a TypeError, and Node does throw (see
      // scripts/clone-after-read-node.ts, which gets a 500). After
      // readRequestBody has released its reader, workerd does not throw: the
      // clone and the original both read as empty, so the SDK takes the
      // "no-json-body" path (line 1469), builds a legacy server instance, and
      // answers as if the client had sent nothing, even for valid JSON.
      expect(() => request.clone()).not.toThrow();
      const response = await harness.handler.fetch(request);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: Invalid JSON" },
      });
      expect(harness.errors).toEqual([]);
      expect(harness.instances.map((instance) => instance.ctx.era)).toEqual(["legacy"]);
    });

    it(`after request.text(), workerd answers 500 because the stream stays locked (${label})`, async () => {
      const harness = createHarness();
      const request = jsonPost(body);
      await request.text();

      expect(() => request.clone()).toThrow();
      const response = await harness.handler.fetch(request);

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Internal server error" },
      });
      expect(harness.errors.map((error) => error.message)).toEqual([
        expect.stringContaining("This ReadableStream is currently locked to a reader"),
      ]);
      expect(harness.instances).toHaveLength(0);
    });
  }

  for (const [label, body] of bodies.slice(0, 2)) {
    it(`probe answers -32700 itself without calling the SDK (${label})`, async () => {
      const harness = createHarness();

      const response = await harness.serve(jsonPost(body));
      await harness.settle();

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      expect(harness.instances).toHaveLength(0);
      expect(harness.errors).toHaveLength(0);
      expect(harness.records[0]?.rawBody).toBe(body);
      expect(harness.records[0]?.classification).toEqual({
        kind: "unparsed",
        why: body === "" ? "empty-body" : "invalid-json",
      });
    });
  }

  it("control case: when the SDK reads an unparseable body itself, the legacy transport answers 400 -32700", async () => {
    // Without the probe in front, the SDK routes an unparseable POST to the
    // legacy leg (dist/index.mjs lines 1469-1470), whose transport answers.
    const harness = createHarness();
    const response = await harness.handler.fetch(jsonPost('{"jsonrpc":'));
    expect(response.status).toBe(400);
    expect(headersOf(response)).toEqual({ "content-type": "application/json" });
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error: Invalid JSON" },
    });
  });
});
