// Runs the same experiment as test/body.test.ts ("SDK misreads an already-read
// body ...") in Node instead of workerd, to show the runtimes differ.
// Usage: node scripts/clone-after-read-node.ts
import { createMcpHandler, readRequestBody } from "@modelcontextprotocol/server";
import { createSpikeServerFactory } from "../src/server.ts";

const errors: string[] = [];
const handler = createMcpHandler(createSpikeServerFactory(), {
  onerror: (error) => errors.push(`${error.name}: ${error.message}`),
});

for (const body of ['{"jsonrpc":', ""]) {
  errors.length = 0;
  const request = new Request("https://probe.example.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body,
  });
  await readRequestBody(request, 64 * 1024);
  const response = await handler.fetch(request);
  console.log(
    JSON.stringify({
      runtime: `node ${process.version}`,
      body,
      status: response.status,
      reply: await response.json(),
      errors,
    }),
  );
}
