import { describe, expect, it } from "vitest";
import { SPIKE_TOOL_NAME } from "../src/server.ts";
import {
  createHarness,
  jsonPost,
  legacyInitializeBody,
  MODERN_VERSION,
  modernEnvelope,
  modernRequest,
  sseMessages,
} from "./helpers.ts";

const UNKNOWN_KEYS = {
  foo: {},
  roots: { listChanged: true, zzz: 1 },
  experimental: { bar: { q: 1 } },
  extensions: { baz: {} },
};

describe("raw capture in front of the SDK", () => {
  it("legacy initialize keeps unknown capability keys in the record only", async () => {
    const harness = createHarness();
    const body = legacyInitializeBody("2025-06-18", { roots: { listChanged: true }, foo: {} });

    const response = await harness.serve(jsonPost(body));
    const text = await response.text();
    await harness.settle();

    // A valid InitializeResult, delivered over SSE by the legacy leg.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const [message] = sseMessages(text) as [{ id: number; result: Record<string, unknown> }];
    expect(message.id).toBe(1);
    expect(message.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "canimcp-probe-spike", version: "0.0.0" },
      capabilities: { tools: expect.any(Object) },
    });

    // The probe's own record holds "foo" verbatim.
    const [record] = harness.records;
    expect(record?.rawBody).toBe(body);
    expect(record?.declared.clientCapabilities).toEqual({ roots: { listChanged: true }, foo: {} });
    expect(record?.classification).toEqual({
      kind: "legacy",
      reason: "initialize",
      requestedVersion: "2025-06-18",
    });
    expect(record?.reply).toMatchObject({
      status: 200,
      errorCode: null,
      negotiatedProtocolVersion: "2025-06-18",
    });

    // The SDK instance never saw it: zod's z.object strips unknown keys
    // (ClientCapabilitiesSchema$1 in dist/src-Cqbh3MYc.mjs).
    const [instance] = harness.instances;
    expect(instance?.ctx.era).toBe("legacy");
    const sdkCapabilities = instance?.server.server.getClientCapabilities();
    expect(sdkCapabilities).toEqual({ roots: { listChanged: true } });
    expect(sdkCapabilities).not.toHaveProperty("foo");
  });

  it("does not mutate the parsedBody object it is given", async () => {
    const harness = createHarness();
    const body = legacyInitializeBody("2025-06-18", { foo: { nested: [1, 2] } });

    await (await harness.serve(jsonPost(body))).text();
    await harness.settle();

    // declared.* are references into the object passed as parsedBody, so
    // they would show any mutation the SDK made to it.
    const [record] = harness.records;
    expect(record?.declared.clientCapabilities).toEqual({ foo: { nested: [1, 2] } });
  });

  it("modern request naming an unsupported version is answered -32022", async () => {
    const harness = createHarness();
    const request = modernRequest(
      "tools/list",
      {},
      { metaVersion: "1999-01-01", headerVersion: "1999-01-01" },
    );

    const response = await harness.serve(request);
    const payload = (await response.json()) as {
      error: { code: number; data: { supported: string[]; requested: string } };
    };
    await harness.settle();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe(-32022);
    expect(payload.error.data.supported).toContain(MODERN_VERSION);
    expect(payload.error.data.requested).toBe("1999-01-01");

    const [record] = harness.records;
    expect(record?.declared.envelopeProtocolVersion).toBe("1999-01-01");
    expect(record?.headers.protocolVersion).toBe("1999-01-01");
    // The classifier routes it as modern (it carries an envelope claim); the
    // -32022 comes later, from createMcpHandler's serveModern, so it lands in
    // the reply, not in the classification.
    expect(record?.classification).toEqual({
      kind: "modern",
      messageKind: "request",
      era: "legacy",
      revision: "1999-01-01",
    });
    expect(record?.reply.errorCode).toBe(-32022);
  });

  it("header and _meta version mismatch is answered -32020", async () => {
    const harness = createHarness();
    const request = modernRequest(
      "tools/list",
      {},
      { metaVersion: MODERN_VERSION, headerVersion: "2026-01-01" },
    );

    const response = await harness.serve(request);
    const payload = (await response.json()) as { error: { code: number; data: unknown } };
    await harness.settle();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe(-32020);
    expect(payload.error.data).toEqual({
      mismatch: { header: "2026-01-01", body: expect.stringContaining(MODERN_VERSION) },
    });

    const [record] = harness.records;
    expect(record?.headers.protocolVersion).toBe("2026-01-01");
    expect(record?.declared.envelopeProtocolVersion).toBe(MODERN_VERSION);
    // This cell is produced by classifyInboundRequest itself.
    expect(record?.classification).toEqual({
      kind: "reject",
      rung: "era-classification",
      cell: "header-body-version-mismatch",
      code: -32020,
      httpStatus: 400,
    });
    expect(record?.reply.errorCode).toBe(-32020);
  });

  it("serves a modern tools/call and records the envelope", async () => {
    const harness = createHarness();
    const request = modernRequest(
      "tools/call",
      { name: "spike_echo", arguments: {} },
      { metaVersion: MODERN_VERSION, headerVersion: MODERN_VERSION },
    );

    const response = await harness.serve(request);
    const payload = (await response.json()) as { result: { content: { text: string }[] } };
    await harness.settle();

    expect(response.status).toBe(200);
    expect(JSON.parse(payload.result.content[0]?.text ?? "null")).toEqual({
      era: "modern",
      sessionId: null,
      envelopeCapabilities: {},
    });
    const [record] = harness.records;
    expect(record?.classification).toEqual({
      kind: "modern",
      messageKind: "request",
      era: "modern",
      revision: MODERN_VERSION,
    });
    expect(record?.declared.clientInfo).toEqual({ name: "spike-client", version: "1.2.3" });
    expect(record?.reply).toMatchObject({ status: 200, errorCode: null });
  });

  it("legacy era: stripping is top-level only; nested record and loose schemas keep unknown keys", async () => {
    const harness = createHarness();
    const capabilities = {
      foo: {},
      roots: { listChanged: true, zzz: 1 },
      experimental: { bar: { q: 1 } },
      tasks: { list: {}, requests: { tools: { call: {}, other: {} }, extra: {} } },
    };
    await (await harness.serve(jsonPost(legacyInitializeBody("2025-06-18", capabilities)))).text();
    await harness.settle();

    // ClientCapabilitiesSchema$1 (dist/src-Cqbh3MYc.mjs lines 811-821) is a
    // z.object, so unknown top-level keys and unknown keys inside `roots` (a
    // z.object too) are dropped. `experimental` is a z.record and `tasks` a
    // z.looseObject, so their contents survive.
    expect(harness.instances[0]?.server.server.getClientCapabilities()).toEqual({
      roots: { listChanged: true },
      experimental: { bar: { q: 1 } },
      tasks: { list: {}, requests: { tools: { call: {}, other: {} }, extra: {} } },
    });
    expect(harness.records[0]?.declared.clientCapabilities).toEqual(capabilities);
  });

  it("modern era: the SDK keeps unknown capability keys, because the envelope is surfaced as received", async () => {
    const harness = createHarness();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: SPIKE_TOOL_NAME,
        arguments: {},
        _meta: modernEnvelope(MODERN_VERSION, UNKNOWN_KEYS),
      },
    });
    const response = await harness.serve(
      jsonPost(body, {
        "mcp-protocol-version": MODERN_VERSION,
        "mcp-method": "tools/call",
        "mcp-name": SPIKE_TOOL_NAME,
      }),
    );
    const payload = (await response.json()) as { result: { content: { text: string }[] } };
    await harness.settle();

    // createMcpHandler seeds client identity from the raw request _meta
    // (dist/index.mjs lines 1364-1365, 1420-1423), and ctx.mcpReq.envelope is
    // "surfaced as received" (createMcpHandler-D4NN8WsG.d.mts line 2135).
    expect(JSON.parse(payload.result.content[0]?.text ?? "null")).toMatchObject({
      envelopeCapabilities: UNKNOWN_KEYS,
    });
    expect(harness.instances[0]?.server.server.getClientCapabilities()).toEqual(UNKNOWN_KEYS);
    expect(harness.records[0]?.declared.clientCapabilities).toEqual(UNKNOWN_KEYS);
  });
});
