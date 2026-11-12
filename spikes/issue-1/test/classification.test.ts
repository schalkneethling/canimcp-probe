import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  BOTH_ACCEPT,
  createHarness,
  ENDPOINT,
  jsonPost,
  legacyInitializeBody,
  MODERN_VERSION,
  modernEnvelope,
} from "./helpers.ts";

type Case = { name: string; request: () => Request };

const legacyCases: Case[] = [
  {
    name: "http-method",
    request: () =>
      new Request(ENDPOINT, { method: "GET", headers: { accept: "text/event-stream" } }),
  },
  { name: "initialize", request: () => jsonPost(legacyInitializeBody("2025-06-18", {})) },
  {
    name: "no-claim",
    request: () =>
      jsonPost(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })),
  },
  {
    name: "notification",
    request: () =>
      jsonPost(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })),
  },
  {
    name: "batch",
    request: () => jsonPost(JSON.stringify([{ jsonrpc: "2.0", id: 4, method: "ping" }])),
  },
  {
    name: "response",
    request: () => jsonPost(JSON.stringify({ jsonrpc: "2.0", id: 5, result: {} })),
  },
];

describe("legacy routing reasons", () => {
  it("observes every reason in InboundLegacyRouteReason", async () => {
    const observed: string[] = [];
    for (const testCase of legacyCases) {
      const harness = createHarness();
      const response = await harness.serve(testCase.request());
      await response.text();
      await harness.settle();
      const classification = harness.records[0]?.classification;
      expect(classification?.kind, testCase.name).toBe("legacy");
      if (classification?.kind === "legacy") observed.push(classification.reason);
    }
    // The union in createMcpHandler-D4NN8WsG.d.mts (InboundLegacyRouteReason).
    expect(observed).toEqual([
      "http-method",
      "initialize",
      "no-claim",
      "notification",
      "batch",
      "response",
    ]);
  });
});

function modernPost(body: unknown, headers: Record<string, string>) {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: BOTH_ACCEPT, ...headers },
    body: JSON.stringify(body),
  });
}

const rejectionCases: Case[] = [
  {
    name: "header and _meta version differ",
    request: () =>
      modernPost(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: modernEnvelope(MODERN_VERSION) },
        },
        { "mcp-protocol-version": "2026-01-01", "mcp-method": "tools/list" },
      ),
  },
  {
    name: "envelope missing clientCapabilities",
    request: () =>
      modernPost(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN_VERSION } },
        },
        { "mcp-protocol-version": MODERN_VERSION, "mcp-method": "tools/list" },
      ),
  },
  {
    name: "modern header without an envelope",
    request: () =>
      modernPost(
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        { "mcp-protocol-version": MODERN_VERSION, "mcp-method": "tools/list" },
      ),
  },
  {
    name: "unsupported envelope version",
    request: () =>
      modernPost(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: modernEnvelope("1999-01-01") },
        },
        { "mcp-protocol-version": "1999-01-01", "mcp-method": "tools/list" },
      ),
  },
  {
    name: "MCP-Protocol-Version header missing",
    request: () =>
      modernPost(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: modernEnvelope(MODERN_VERSION) },
        },
        { "mcp-method": "tools/list" },
      ),
  },
  {
    name: "Mcp-Method header missing",
    request: () =>
      modernPost(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: modernEnvelope(MODERN_VERSION) },
        },
        { "mcp-protocol-version": MODERN_VERSION },
      ),
  },
  {
    name: "envelope capabilities of the wrong type",
    request: () =>
      modernPost(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: { ...modernEnvelope(MODERN_VERSION), [CLIENT_CAPABILITIES_META_KEY]: "nope" },
          },
        },
        { "mcp-protocol-version": MODERN_VERSION, "mcp-method": "tools/list" },
      ),
  },
  {
    name: "body that is not a JSON-RPC message",
    request: () => jsonPost("{}"),
  },
  {
    name: "empty batch",
    request: () => jsonPost("[]"),
  },
];

type Row = {
  classification: string;
  era?: string;
  replyStatus: number;
  replyCode: number | null;
};

describe("which rejections come from the classifier and which come later", () => {
  it("separates classifier rejections from reply errors", async () => {
    const table: Record<string, Row> = {};
    for (const testCase of rejectionCases) {
      const harness = createHarness();
      const response = await harness.serve(testCase.request());
      await response.text();
      await harness.settle();
      const record = harness.records[0];
      const classification = record?.classification;
      table[testCase.name] = {
        classification:
          classification?.kind === "reject"
            ? `reject ${classification.code} (${classification.rung}/${classification.cell})`
            : (classification?.kind ?? "missing"),
        ...(classification?.kind === "modern" && { era: classification.era }),
        replyStatus: record?.reply.status ?? 0,
        replyCode: record?.reply.errorCode ?? null,
      };
    }
    // Every row of the table in docs/adr/0001-sdk-strategy.md, evidence 7.
    expect(table).toEqual({
      "header and _meta version differ": {
        classification: "reject -32020 (era-classification/header-body-version-mismatch)",
        replyStatus: 400,
        replyCode: -32020,
      },
      "envelope missing clientCapabilities": {
        classification: "reject -32602 (envelope/envelope-invalid)",
        replyStatus: 400,
        replyCode: -32602,
      },
      "modern header without an envelope": {
        classification: "reject -32602 (envelope/modern-header-without-claim)",
        replyStatus: 400,
        replyCode: -32602,
      },
      // kind "modern" but era "legacy": the claimed version is pre-2026.
      "unsupported envelope version": {
        classification: "modern",
        era: "legacy",
        replyStatus: 400,
        replyCode: -32022,
      },
      "MCP-Protocol-Version header missing": {
        classification: "modern",
        era: "modern",
        replyStatus: 400,
        replyCode: -32020,
      },
      "Mcp-Method header missing": {
        classification: "modern",
        era: "modern",
        replyStatus: 400,
        replyCode: -32020,
      },
      "envelope capabilities of the wrong type": {
        classification: "reject -32602 (envelope/envelope-invalid)",
        replyStatus: 400,
        replyCode: -32602,
      },
      "body that is not a JSON-RPC message": {
        classification: "reject -32600 (jsonrpc-shape/invalid-json-rpc-body)",
        replyStatus: 400,
        replyCode: -32600,
      },
      "empty batch": {
        classification: "reject -32600 (jsonrpc-shape/empty-batch)",
        replyStatus: 400,
        replyCode: -32600,
      },
    });
  });
});
