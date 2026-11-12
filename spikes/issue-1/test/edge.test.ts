import { originValidationResponse } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  createHarness,
  ENDPOINT,
  headersOf,
  jsonPost,
  legacyInitializeBody,
  MODERN_VERSION,
  modernEnvelope,
} from "./helpers.ts";

async function snapshotOf(response: Response) {
  const text = await response.text();
  return {
    status: response.status,
    headers: headersOf(response),
    body: text === "" ? null : JSON.parse(text),
  };
}

describe("Accept handling on the legacy leg", () => {
  // "*/*" is included because the check is a substring test on each media
  // type, not content negotiation, so a wildcard is refused too.
  for (const accept of ["application/json", "text/event-stream", "*/*"]) {
    it(`legacy POST without both media types in Accept is answered 406 (${accept})`, async () => {
      const harness = createHarness();
      const response = await harness.serve(
        jsonPost(legacyInitializeBody("2025-06-18", {}), { accept }),
      );
      const observed = await snapshotOf(response);
      await harness.settle();

      // WebStandardStreamableHTTPServerTransport.handlePostRequest,
      // dist/index.mjs lines 706-709.
      expect(observed).toEqual({
        status: 406,
        headers: { "content-type": "application/json" },
        body: {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32000,
            message:
              "Not Acceptable: Client must accept both application/json and text/event-stream",
          },
        },
      });
      expect(harness.records[0]?.reply).toMatchObject({ status: 406, errorCode: -32000 });
    });
  }

  it("the modern path does not check Accept", async () => {
    // serveModern and PerRequestHTTPServerTransport have no Accept check; the
    // only 406 sites in dist/index.mjs are the legacy transport (lines 532, 707).
    const harness = createHarness();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: modernEnvelope(MODERN_VERSION) },
    });
    const response = await harness.serve(
      jsonPost(body, {
        accept: "text/plain",
        "mcp-protocol-version": MODERN_VERSION,
        "mcp-method": "tools/list",
      }),
    );
    await response.text();
    await harness.settle();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
  });
});

describe("OPTIONS handed to the SDK handler", () => {
  it("OPTIONS preflight reaches the legacy leg and gets 405 with no CORS headers", async () => {
    const harness = createHarness();
    const preflight = new Request(ENDPOINT, {
      method: "OPTIONS",
      headers: { origin: "https://example.test", "access-control-request-method": "POST" },
    });

    const observed = await snapshotOf(await harness.handler.fetch(preflight));

    // classifyInboundRequest routes every non-POST method to legacy with
    // reason "http-method" (dist/src-Cqbh3MYc.mjs line 5283), and the
    // stateless legacy fallback answers any non-POST with 405
    // (dist/index.mjs line 1066), before any transport or Allow header exists.
    expect(observed).toEqual({
      status: 405,
      headers: { "content-type": "application/json" },
      body: { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed." } },
    });
    expect(harness.instances).toHaveLength(0);
  });

  it("OPTIONS without an Origin header gets the same 405", async () => {
    const harness = createHarness();
    const observed = await snapshotOf(
      await harness.handler.fetch(new Request(ENDPOINT, { method: "OPTIONS" })),
    );
    expect(observed.status).toBe(405);
    expect(
      Object.keys(observed.headers).filter((name) => name.startsWith("access-control-")),
    ).toEqual([]);
  });
});

describe("originValidationResponse input form", () => {
  const withOrigin = (origin: string | null) =>
    new Request(ENDPOINT, { method: "POST", headers: origin === null ? {} : { origin } });

  it("accepts bare hostnames, port-agnostic", () => {
    expect(
      originValidationResponse(withOrigin("https://example.test"), ["example.test"]),
    ).toBeUndefined();
    expect(
      originValidationResponse(withOrigin("https://example.test:8443"), ["example.test"]),
    ).toBeUndefined();
    expect(originValidationResponse(withOrigin("http://[::1]:3000"), ["[::1]"])).toBeUndefined();
  });

  it("does not match a full origin string in the allowlist", async () => {
    const rejected = originValidationResponse(withOrigin("https://example.test"), [
      "https://example.test",
    ]);
    expect(rejected?.status).toBe(403);
    expect(await rejected?.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Invalid Origin: example.test" },
    });
  });

  it("lets a missing Origin through and rejects the literal null origin", () => {
    expect(originValidationResponse(withOrigin(null), [])).toBeUndefined();
    expect(originValidationResponse(withOrigin("null"), ["example.test"])?.status).toBe(403);
  });

  it("honours <scheme>://* for non-web schemes, and needs lowercase entries", () => {
    // JSDoc at dist/index.mjs lines 1589-1592; the URL parser lowercases the
    // origin's hostname and the allowlist is compared exactly.
    expect(
      originValidationResponse(withOrigin("moz-extension://4b2a-uuid"), ["moz-extension://*"]),
    ).toBeUndefined();
    expect(
      originValidationResponse(withOrigin("https://example.test"), ["Example.test"])?.status,
    ).toBe(403);
    expect(
      originValidationResponse(withOrigin("https://EXAMPLE.test"), ["example.test"]),
    ).toBeUndefined();
  });

  it("does not honour https://* as a wildcard", () => {
    expect(
      originValidationResponse(withOrigin("https://example.test"), ["https://*"])?.status,
    ).toBe(403);
  });
});

describe("Content-Type is still checked when parsedBody is supplied", () => {
  it("answers 415 for a text/plain POST even though the probe parsed the body", async () => {
    const harness = createHarness();
    const request = new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "text/plain", accept: "application/json, text/event-stream" },
      body: legacyInitializeBody("2025-06-18", {}),
    });
    const response = await harness.serve(request);
    await harness.settle();
    // createMcpHandler's handle(), dist/index.mjs lines 1462-1464.
    expect(response.status).toBe(415);
    expect(harness.records[0]?.reply.errorCode).toBe(-32000);
  });
});
