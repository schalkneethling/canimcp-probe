import { createMcpHandler } from "@modelcontextprotocol/server";
import { probeFetch } from "./probe.ts";
import { createSpikeServerFactory } from "./server.ts";
import { insertRecord } from "./store.ts";

// One handler per isolate: createMcpHandler builds a fresh McpServer per
// request through the factory, so nothing request-specific lives here.
// Error messages can embed client-supplied strings (for example the method
// name), so only the error class is logged.
const handler = createMcpHandler(createSpikeServerFactory(), {
  onerror: (error) => console.warn(JSON.stringify({ sdkError: error.name })),
});

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname, hostname } = new URL(request.url);
    // /mcp records nothing; /mcp-d1 adds one D1 insert per request. The two
    // paths exist so the CPU runs can compare "with" and "without" D1.
    if (pathname === "/mcp" || pathname === "/mcp-d1") {
      const writeToD1 = pathname === "/mcp-d1";
      return probeFetch(request, {
        handler,
        waitUntil: (promise) => ctx.waitUntil(promise),
        mintSessionId: () => crypto.randomUUID(),
        onRecord: async (record) => {
          if (!writeToD1) return;
          const meta = await insertRecord(env.DB, record, new Date().toISOString());
          console.log(JSON.stringify({ d1RowsWritten: meta.rows_written }));
        },
      });
    }
    if (pathname === "/__runtime" && LOCAL_HOSTNAMES.has(hostname)) {
      // LOCAL ONLY: lets scripts/compat-matrix.sh confirm which Node.js
      // compatibility mode `wrangler dev` started with. On a deployed Worker
      // the hostname is never local, so the path falls through to the static
      // assets and answers 404.
      return Response.json({
        process: typeof globalThis.process,
        buffer: typeof globalThis.Buffer,
      });
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller): Promise<void> {
    // Only proves the cron trigger is wired; the real job is a later issue.
    console.log(JSON.stringify({ cron: controller.cron, scheduledTime: controller.scheduledTime }));
  },
} satisfies ExportedHandler<Env>;
