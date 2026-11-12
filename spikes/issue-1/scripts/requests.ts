// Request bodies shared by the benchmark scripts. They match test/helpers.ts.
export const ACCEPT = "application/json, text/event-stream";
export const MODERN_VERSION = "2026-07-28";

export function modernToolsCall(id: number) {
  return {
    headers: {
      "content-type": "application/json",
      accept: ACCEPT,
      "mcp-protocol-version": MODERN_VERSION,
      "mcp-method": "tools/call",
      "mcp-name": "spike_echo",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "spike_echo",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "bench", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  };
}

export function legacyInitialize(id: number) {
  return {
    headers: { "content-type": "application/json", accept: ACCEPT },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: { foo: {} },
        clientInfo: { name: "bench", version: "0" },
      },
    }),
  };
}

export function legacyToolsCall(id: number, sessionId: string | null) {
  return {
    headers: {
      "content-type": "application/json",
      accept: ACCEPT,
      "mcp-protocol-version": "2025-06-18",
      ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "spike_echo", arguments: {} },
    }),
  };
}
