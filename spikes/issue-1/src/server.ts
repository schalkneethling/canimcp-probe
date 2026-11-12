import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  type McpRequestContext,
} from "@modelcontextprotocol/server";

export const SPIKE_TOOL_NAME = "spike_echo";

/**
 * Builds the per-request McpServer the SDK handler asks for. The same factory
 * backs both eras, as createMcpHandler's documentation asks
 * (node_modules/@modelcontextprotocol/server/dist/index.mjs, createMcpHandler
 * JSDoc: "Use ONE factory for both legs").
 *
 * `onInstance` lets a test hold on to the instance the SDK serves, so it can
 * ask what the SDK itself saw (for example, the client capabilities after
 * zod parsing).
 */
export function createSpikeServerFactory(
  onInstance?: (server: McpServer, ctx: McpRequestContext) => void,
) {
  return (ctx: McpRequestContext): McpServer => {
    const server = new McpServer({ name: "canimcp-probe-spike", version: "0.0.0" });

    server.registerTool(
      SPIKE_TOOL_NAME,
      {
        description:
          "Reports the era, the Mcp-Session-Id header, and the envelope capabilities the SDK exposes to tools.",
      },
      (toolCtx) => {
        // ServerContext.http.req is the original Request
        // (createMcpHandler-D4NN8WsG.d.mts, ServerContext "http.req").
        const sessionId = toolCtx.http?.req?.headers.get("mcp-session-id") ?? null;
        // ctx.mcpReq.envelope is the modern per-request envelope, "surfaced as
        // received" (createMcpHandler-D4NN8WsG.d.mts line 2135); absent on legacy.
        // The published type of RequestMetaEnvelope is `{}`
        // (createMcpHandler-D4NN8WsG.d.mts line 378), so it is widened here.
        const envelope = toolCtx.mcpReq.envelope as Record<string, unknown> | undefined;
        const envelopeCapabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? null;
        const payload = { era: ctx.era, sessionId, envelopeCapabilities };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
        };
      },
    );

    onInstance?.(server, ctx);
    return server;
  };
}
