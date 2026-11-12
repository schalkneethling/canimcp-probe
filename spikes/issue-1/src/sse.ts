import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";

const FIRST_MODERN_PROTOCOL_VERSION = "2026-07-28";

/**
 * Reads the negotiated protocol version out of a legacy `initialize` reply
 * delivered as SSE. The SDK writes each message as `event: message` followed
 * by one `data: <json>` line (WebStandardStreamableHTTPServerTransport
 * .writeSSEEvent, dist/index.mjs lines 669-680), so a line scan is enough.
 */
export function negotiatedVersionFromSse(text: string): string | null {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    let message: unknown;
    try {
      message = JSON.parse(line.slice("data: ".length));
    } catch {
      continue;
    }
    if (typeof message !== "object" || message === null || !("result" in message)) continue;
    const result = message.result;
    if (typeof result === "object" && result !== null && "protocolVersion" in result) {
      const version = result.protocolVersion;
      if (typeof version === "string") return version;
    }
  }
  return null;
}

/**
 * The cheap alternative: compute the answer from the request alone, using the
 * rule in Server._oninitialize (dist/mcp-DIH4cS6P.mjs lines 1338-1344):
 * echo the requested version when it is a supported legacy version, otherwise
 * answer the first supported legacy version.
 *
 * This copies SDK logic, so it can drift on an SDK upgrade. The test in
 * test/sse.test.ts compares it with the SSE body and the SDK instance.
 */
export function predictNegotiatedVersion(requested: string): string | null {
  const legacy = SUPPORTED_PROTOCOL_VERSIONS.filter(
    (version) => version < FIRST_MODERN_PROTOCOL_VERSION,
  );
  return legacy.includes(requested) ? requested : (legacy[0] ?? null);
}
