import { describe, expect, it } from "vitest";
import { SPIKE_TOOL_NAME } from "../src/server.ts";
import {
  createHarness,
  jsonPost,
  legacyInitializeBody,
  legacyToolsCallBody,
  sseMessages,
} from "./helpers.ts";

describe("probe-minted Mcp-Session-Id on the stateless legacy leg", () => {
  it("mints a session id on the legacy InitializeResult and the tool reads it on a follow-up call", async () => {
    const harness = createHarness({ mintSessionId: () => "probe-session-1" });

    const init = await harness.serve(jsonPost(legacyInitializeBody("2025-06-18", {})));
    await init.text();
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBe("probe-session-1");

    const call = await harness.serve(
      jsonPost(legacyToolsCallBody(SPIKE_TOOL_NAME), {
        "mcp-session-id": "probe-session-1",
        "mcp-protocol-version": "2025-06-18",
      }),
    );
    const text = await call.text();
    await harness.settle();

    // The stateless transport skips session validation entirely
    // (validateSession returns early when sessionIdGenerator is undefined,
    // dist/index.mjs line 876), so the foreign id is tolerated.
    expect(call.status).toBe(200);
    const [message] = sseMessages(text) as [{ result: { content: { text: string }[] } }];
    expect(JSON.parse(message.result.content[0]?.text ?? "null")).toEqual({
      era: "legacy",
      sessionId: "probe-session-1",
      envelopeCapabilities: null,
    });

    expect(harness.records.map((record) => record.reply.mintedSessionId)).toEqual([
      "probe-session-1",
      null,
    ]);
    expect(harness.records[1]?.headers.sessionId).toBe("probe-session-1");
    // The SDK never sets its own session id on the stateless leg.
    expect(call.headers.get("mcp-session-id")).toBeNull();
  });

  it("does not mint a session id when initialize fails", async () => {
    const harness = createHarness({ mintSessionId: () => "never" });
    const response = await harness.serve(
      jsonPost(legacyInitializeBody("2025-06-18", {}), { accept: "application/json" }),
    );
    await response.text();
    await harness.settle();

    expect(response.status).toBe(406);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(harness.records[0]?.reply.mintedSessionId).toBeNull();
  });

  it("does not mint a session id when initialize answers an in-band JSON-RPC error with HTTP 200", async () => {
    const harness = createHarness({ mintSessionId: () => "never" });
    // An initialize with no params passes the classifier (reason "initialize")
    // and fails the SDK's own params validation after dispatch.
    const response = await harness.serve(
      jsonPost(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })),
    );
    const text = await response.text();
    await harness.settle();

    expect(response.status).toBe(200);
    const [message] = sseMessages(text) as [{ error: { code: number } }];
    expect(message.error.code).toBe(-32603);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(harness.records[0]?.classification).toEqual({ kind: "legacy", reason: "initialize" });
    expect(harness.records[0]?.reply).toEqual({
      status: 200,
      errorCode: -32603,
      negotiatedProtocolVersion: null,
      mintedSessionId: null,
    });
  });
});
