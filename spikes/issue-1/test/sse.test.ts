import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { negotiatedVersionFromSse, predictNegotiatedVersion } from "../src/sse.ts";
import { createHarness, jsonPost, legacyInitializeBody } from "./helpers.ts";

describe("negotiated protocol version on a legacy initialize", () => {
  for (const requested of ["2025-06-18", "2099-01-01"]) {
    it(`all three sources agree when the client asks for ${requested}`, async () => {
      const harness = createHarness();
      const response = await harness.serve(jsonPost(legacyInitializeBody(requested, {})));
      const text = await response.text();
      await harness.settle();

      const fromSse = negotiatedVersionFromSse(text);
      const fromInstance = harness.instances[0]?.server.server.getNegotiatedProtocolVersion();
      const predicted = predictNegotiatedVersion(requested);

      const expected = requested === "2025-06-18" ? "2025-06-18" : LATEST_PROTOCOL_VERSION;
      expect({ fromSse, fromInstance, predicted }).toEqual({
        fromSse: expected,
        fromInstance: expected,
        predicted: expected,
      });
      expect(harness.records[0]?.reply.negotiatedProtocolVersion).toBe(expected);
    });
  }

  it("ignores SSE comment frames and events without a JSON-RPC result", () => {
    const text = [
      ": keepalive",
      "",
      "event: message",
      'data: {"jsonrpc":"2.0","method":"notifications/message","params":{}}',
      "",
      'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26"}}',
      "",
      "",
    ].join("\n");
    expect(negotiatedVersionFromSse(text)).toBe("2025-03-26");
  });

  it("returns null for a body with no result", () => {
    expect(
      negotiatedVersionFromSse(
        'data: {"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"x"}}\n\n',
      ),
    ).toBeNull();
  });

  it("getNegotiatedProtocolVersion is already set when handler.fetch resolves, before the body is read", async () => {
    // Server._oninitialize assigns _negotiatedProtocolVersion synchronously
    // (dist/mcp-DIH4cS6P.mjs lines 1338-1344). The protocol layer runs the
    // handler in a microtask (dist/src-Cqbh3MYc.mjs line 6534), which has run
    // by the time the transport's SSE Response reaches the caller.
    const harness = createHarness();
    const response = await harness.handler.fetch(jsonPost(legacyInitializeBody("2025-06-18", {})));
    expect(harness.instances[0]?.server.server.getNegotiatedProtocolVersion()).toBe("2025-06-18");
    await response.text();
  });
});
