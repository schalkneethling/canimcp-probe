import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  PROTOCOL_VERSION_META_KEY,
  type McpRequestContext,
  type McpServer,
} from "@modelcontextprotocol/server";
import { probeFetch, type ProbeOptions, type ProbeRecord } from "../src/probe.ts";
import { createSpikeServerFactory } from "../src/server.ts";

export const ENDPOINT = "https://probe.example.test/mcp";
export const MODERN_VERSION = "2026-07-28";
export const BOTH_ACCEPT = "application/json, text/event-stream";

export type ServedInstance = { server: McpServer; ctx: McpRequestContext };

/**
 * A probe wired to a real createMcpHandler, with every record, every SDK
 * instance and every waitUntil promise kept for assertions.
 */
export function createHarness(
  overrides: Partial<Pick<ProbeOptions, "mintSessionId" | "maxBodyBytes">> = {},
) {
  const records: ProbeRecord[] = [];
  const instances: ServedInstance[] = [];
  const errors: Error[] = [];
  const pending: Promise<unknown>[] = [];
  const handler = createMcpHandler(
    createSpikeServerFactory((server, ctx) => instances.push({ server, ctx })),
    { onerror: (error) => errors.push(error) },
  );
  const options: ProbeOptions = {
    handler,
    onRecord: (record) => {
      records.push(record);
    },
    waitUntil: (promise) => {
      pending.push(promise);
    },
    ...overrides,
  };
  return {
    handler,
    records,
    instances,
    errors,
    serve: (request: Request) => probeFetch(request, options),
    /** Waits for every recording promise the probe handed to waitUntil. */
    settle: async () => {
      await Promise.all(pending);
    },
  };
}

export function jsonPost(body: string, headers: Record<string, string> = {}): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: BOTH_ACCEPT, ...headers },
    body,
  });
}

export function legacyInitializeBody(
  protocolVersion: string,
  capabilities: Record<string, unknown>,
  id = 1,
) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities,
      clientInfo: { name: "spike-client", version: "1.2.3" },
    },
  });
}

export function legacyToolsCallBody(toolName: string, id = 2) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: toolName, arguments: {} },
  });
}

export function modernEnvelope(
  protocolVersion: string,
  capabilities: Record<string, unknown> = {},
) {
  return {
    [PROTOCOL_VERSION_META_KEY]: protocolVersion,
    [CLIENT_INFO_META_KEY]: { name: "spike-client", version: "1.2.3" },
    [CLIENT_CAPABILITIES_META_KEY]: capabilities,
  };
}

export function modernRequest(
  method: string,
  params: Record<string, unknown>,
  {
    metaVersion,
    headerVersion,
    id = 1,
  }: { metaVersion: string; headerVersion: string; id?: number },
): Request {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: { ...params, _meta: modernEnvelope(metaVersion) },
  });
  const headers: Record<string, string> = {
    "mcp-protocol-version": headerVersion,
    "mcp-method": method,
  };
  if (typeof params["name"] === "string") headers["mcp-name"] = params["name"];
  return jsonPost(body, headers);
}

/** Every JSON-RPC message carried in an SSE body, in order. */
export function sseMessages(text: string): unknown[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

export function headersOf(response: Response): Record<string, string> {
  return Object.fromEntries(response.headers.entries());
}
