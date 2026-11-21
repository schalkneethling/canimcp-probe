import {
  classifyInboundRequest,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  readRequestBody,
  type InboundClassificationOutcome,
  type InboundLegacyRouteReason,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { negotiatedVersionFromSse } from "./sse.ts";

/** The probe's own body cap. The SDK's maxRequestBodySize does not apply to a parsedBody. */
export const PROBE_MAX_BODY_BYTES = 64 * 1024;

/**
 * What the SDK's classifier said, copied without the message body. `unparsed`
 * is the probe's own outcome for a POST it answered itself before classifying.
 *
 * `kind` and `era` answer different questions. `kind` is the route the
 * classifier chose. `era`, present on modern routes only, is the era of the
 * version the envelope claims. A `_meta` naming 1999-01-01 is
 * `kind: "modern"` with `era: "legacy"` (classificationForClaim,
 * dist/src-Cqbh3MYc.mjs lines 5146-5151), which the SDK then answers -32022.
 */
export type ProbeClassification =
  | { kind: "legacy"; reason: InboundLegacyRouteReason; requestedVersion?: string }
  | {
      kind: "modern";
      messageKind: "request" | "notification";
      era: "legacy" | "modern";
      revision?: string;
    }
  | { kind: "reject"; rung: string; cell: string; code: number; httpStatus: number }
  | { kind: "unparsed"; why: "empty-body" | "invalid-json" | "unreadable-body" | "too-large" };

/**
 * MEASUREMENT ONLY. This shape exists so the spike's tests can assert what
 * the probe saw. It is not the storage design, which issue #1 puts out of
 * scope.
 */
export type ProbeRecord = {
  httpMethod: string;
  /**
   * The POST body exactly as received, or null when there was none or it was
   * refused unread. Kept in memory for the tests only; nothing stores it.
   */
  rawBody: string | null;
  headers: {
    protocolVersion: string | null;
    mcpMethod: string | null;
    mcpName: string | null;
    sessionId: string | null;
    origin: string | null;
    accept: string | null;
  };
  /** Fields lifted from the parsed body. They are references into the object handed to the SDK. */
  declared: {
    method: string | null;
    envelopeProtocolVersion: string | null;
    initializeProtocolVersion: string | null;
    clientInfo: unknown;
    clientCapabilities: unknown;
  };
  classification: ProbeClassification;
  /** What the client got back. Errors raised after classification appear only here. */
  reply: {
    status: number;
    errorCode: number | null;
    negotiatedProtocolVersion: string | null;
    mintedSessionId: string | null;
  };
};

export type ProbeOptions = {
  handler: Pick<McpHttpHandler, "fetch">;
  onRecord: (record: ProbeRecord) => void | Promise<void>;
  /** Runs recording after the response is returned (ExecutionContext.waitUntil on a Worker). */
  waitUntil: (promise: Promise<unknown>) => void;
  mintSessionId?: () => string;
  maxBodyBytes?: number;
};

type Parsed =
  | { ok: true; text: string; body: unknown }
  | {
      ok: false;
      text: string | null;
      why: Extract<ProbeClassification, { kind: "unparsed" }>["why"];
    };

/**
 * The probe edge: read and cap the body, parse it once, classify it with the
 * SDK's own predicate, then hand the parsed body to the SDK.
 */
export async function probeFetch(request: Request, options: ProbeOptions): Promise<Response> {
  const httpMethod = request.method.toUpperCase();
  const headers = headerFields(request);
  const parsed =
    httpMethod === "POST"
      ? await readAndParse(request, options.maxBodyBytes ?? PROBE_MAX_BODY_BYTES)
      : null;

  if (parsed !== null && !parsed.ok) {
    // The probe answers these itself. Calling handler.fetch without
    // parsedBody here would make the SDK clone an already-read request.
    const response =
      parsed.why === "too-large"
        ? jsonRpcError(413, -32000, "Payload Too Large")
        : jsonRpcError(400, -32700, "Parse error");
    const record = baseRecord(httpMethod, parsed.text, headers, undefined, {
      kind: "unparsed",
      why: parsed.why,
    });
    options.waitUntil(finishRecord(record, response, null, options));
    return response;
  }

  const body = parsed?.body;
  const outcome = classifyInboundRequest({
    httpMethod,
    ...optional("protocolVersionHeader", headers.protocolVersion),
    ...optional("mcpMethodHeader", headers.mcpMethod),
    ...optional("mcpNameHeader", headers.mcpName),
    ...(body !== undefined && { body }),
  });
  const record = baseRecord(httpMethod, parsed?.text ?? null, headers, body, summarize(outcome));

  const response = await options.handler.fetch(
    request,
    body !== undefined ? { parsedBody: body } : undefined,
  );

  if (outcome.kind === "legacy" && outcome.reason === "initialize" && response.body !== null) {
    // The legacy initialize reply is a single message, so buffering it is
    // cheap, and the probe must see it before it can decide whether to attach
    // a session id: only a real InitializeResult gets one, not an in-band
    // JSON-RPC error answered with HTTP 200.
    const text = await response.text();
    const headersOut = new Headers(response.headers);
    let mintedSessionId: string | null = null;
    if (
      response.ok &&
      negotiatedVersionOf(text, isSse(response)) !== null &&
      options.mintSessionId !== undefined
    ) {
      mintedSessionId = options.mintSessionId();
      headersOut.set("mcp-session-id", mintedSessionId);
    }
    options.waitUntil(
      finishRecord(record, response, Promise.resolve(text), options, mintedSessionId),
    );
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: headersOut,
    });
  }

  const [clientResponse, inspected] = splitForInspection(response);
  options.waitUntil(finishRecord(record, response, inspected, options));
  return clientResponse;
}

async function readAndParse(request: Request, maxBytes: number): Promise<Parsed> {
  let text: string;
  try {
    const read = await readRequestBody(request, maxBytes);
    if (read.tooLarge) return { ok: false, text: null, why: "too-large" };
    text = read.text;
  } catch {
    return { ok: false, text: null, why: "unreadable-body" };
  }
  if (text.length === 0) return { ok: false, text, why: "empty-body" };
  try {
    return { ok: true, text, body: JSON.parse(text) };
  } catch {
    return { ok: false, text, why: "invalid-json" };
  }
}

function headerFields(request: Request): ProbeRecord["headers"] {
  const get = (name: string) => request.headers.get(name);
  return {
    protocolVersion: get("mcp-protocol-version"),
    mcpMethod: get("mcp-method"),
    mcpName: get("mcp-name"),
    sessionId: get("mcp-session-id"),
    origin: get("origin"),
    accept: get("accept"),
  };
}

function summarize(outcome: InboundClassificationOutcome): ProbeClassification {
  switch (outcome.kind) {
    case "legacy":
      return {
        kind: "legacy",
        reason: outcome.reason,
        ...optional("requestedVersion", outcome.requestedVersion),
      };
    case "modern":
      return {
        kind: "modern",
        messageKind: outcome.messageKind,
        era: outcome.classification.era,
        ...optional("revision", outcome.classification.revision),
      };
    case "reject":
      return {
        kind: "reject",
        rung: outcome.rung,
        cell: outcome.cell,
        code: outcome.code,
        httpStatus: outcome.httpStatus,
      };
  }
}

function baseRecord(
  httpMethod: string,
  rawBody: string | null,
  headers: ProbeRecord["headers"],
  body: unknown,
  classification: ProbeClassification,
): ProbeRecord {
  const message = asObject(body);
  const params = asObject(message?.["params"]);
  const meta = asObject(params?.["_meta"]);
  const method = typeof message?.["method"] === "string" ? message["method"] : null;
  const isInitialize = method === "initialize";
  return {
    httpMethod,
    rawBody,
    headers,
    declared: {
      method,
      envelopeProtocolVersion: stringOrNull(meta?.[PROTOCOL_VERSION_META_KEY]),
      initializeProtocolVersion: isInitialize ? stringOrNull(params?.["protocolVersion"]) : null,
      clientInfo: isInitialize ? params?.["clientInfo"] : meta?.[CLIENT_INFO_META_KEY],
      clientCapabilities: isInitialize
        ? params?.["capabilities"]
        : meta?.[CLIENT_CAPABILITIES_META_KEY],
    },
    classification,
    reply: { status: 0, errorCode: null, negotiatedProtocolVersion: null, mintedSessionId: null },
  };
}

/**
 * Returns the response for the client and, when the body is worth reading,
 * a second copy for the probe. SSE bodies are teed so the client still
 * streams; JSON bodies are small, so a clone is enough.
 */
function splitForInspection(response: Response): [Response, Promise<string> | null] {
  if (response.body === null) return [response, null];
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("text/event-stream") && !contentType.startsWith("application/json"))
    return [response, null];
  const [forClient, forProbe] = response.body.tee();
  const clientResponse = new Response(forClient, response);
  return [clientResponse, new Response(forProbe).text()];
}

async function finishRecord(
  record: ProbeRecord,
  response: Response,
  inspected: Promise<string> | null,
  options: ProbeOptions,
  mintedSessionId: string | null = null,
): Promise<void> {
  const text = inspected === null ? null : await inspected;
  const sse = isSse(response);
  record.reply = {
    status: response.status,
    errorCode: text === null ? null : errorCodeOf(text, sse),
    negotiatedProtocolVersion:
      text !== null && record.declared.method === "initialize"
        ? negotiatedVersionOf(text, sse)
        : null,
    mintedSessionId,
  };
  await options.onRecord(record);
}

function errorCodeOf(text: string, isSse: boolean): number | null {
  const candidates = isSse
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
    : [text];
  for (const candidate of candidates) {
    try {
      const error = asObject(asObject(JSON.parse(candidate))?.["error"]);
      if (typeof error?.["code"] === "number") return error["code"];
    } catch {
      // Not JSON; nothing to record.
    }
  }
  return null;
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status });
}

function isSse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").startsWith("text/event-stream");
}

/** The protocolVersion of an InitializeResult in the reply, or null when the reply is not one. */
function negotiatedVersionOf(text: string, sse: boolean): string | null {
  if (sse) return negotiatedVersionFromSse(text);
  try {
    const version = asObject(asObject(JSON.parse(text))?.["result"])?.["protocolVersion"];
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Spreads `{ [key]: value }` only when value is present, for exactOptionalPropertyTypes. */
function optional<K extends string>(
  key: K,
  value: string | null | undefined,
): { [P in K]?: string } {
  return (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: string };
}
