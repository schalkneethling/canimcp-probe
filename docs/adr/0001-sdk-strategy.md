# ADR-0001: SDK strategy and platform facts

- **Status:** Proposed. Every local experiment is done; the deployed measurements are owner-run steps (see the end of this record).
- **Date:** 2026-11-12
- **Issue:** schalkneethling/canimcp-probe#1
- **Spike code:** [`spikes/issue-1/`](../../spikes/issue-1/README.md)

## Summary

The probe can read the raw body itself, classify it with the SDK's own `classifyInboundRequest`, and still let `@modelcontextprotocol/server` 2.3.1 serve both protocol eras on a Worker, as long as it passes `parsedBody` on every POST and answers unreadable bodies itself. We adopt that hybrid: **the probe owns the HTTP edge, the SDK owns the protocol.** Whether the Free plan's 10 ms CPU limit is enough is still open. Warm requests cost well under a millisecond locally, but the first request in a fresh local isolate took 13–14 ms of wall time in workerd and about 44 ms of CPU time in Node, and only the owner-run deployed measurement can say what that costs on Cloudflare.

## Context

The probe is a passive public MCP endpoint that records what clients declare. Two facts force the design:

1. On the legacy era, the SDK parses `initialize` with zod `z.object` schemas, which strip unknown top-level capability keys. A capability the SDK does not know, such as `foo: {}`, never reaches the SDK instance (evidence 1). Anything the probe wants to record verbatim has to come from the bytes, before the SDK sees them.
2. A request body can be read only once. If the probe reads it, the SDK must be given the parsed value through `handler.fetch(request, { parsedBody })`. Otherwise the SDK tries to read it again and answers the wrong thing (evidence 2).

Versions used: `@modelcontextprotocol/server` 2.3.1 (pinned by the issue; npm's `latest` is 2.4.0), wrangler 4.160.1, workerd 1.20261110.1, `@cloudflare/vitest-plugin` 1.8.0, Vitest 5.1.0, TypeScript 7.0.2, Node v26.13.1.

## Decision

The probe sits in front of `createMcpHandler(factory)` with the default `legacy: 'stateless'` posture. For each request it does the steps below, in this order. The arrows show where the request body goes.

```
client ──► probe edge (src/probe.ts)
             │ 1. readRequestBody(request, 65_536) ── tooLarge ──► 413, SDK never called
             │ 2. empty or JSON.parse fails ─────────────────────► 400 -32700, SDK never called
             │ 3. classifyInboundRequest({ httpMethod, headers, body })   → record.classification
             │ 4. handler.fetch(request, { parsedBody: body })            ──► SDK (both eras)
             │ 5. legacy initialize: buffer the one-message reply; if it is an
             │    InitializeResult (not a JSON-RPC error), add a probe-minted
             │    Mcp-Session-Id
             │ 6. other replies: tee(); in waitUntil, read the error code from
             │    the copy                                                → record.reply
             ▼
client ◄── response
```

The record keeps two things apart. `classification` holds only what `classifyInboundRequest` said. `reply` holds what the client actually got, because several rejections happen after classification (evidence 7). The record shape and the D1 table in the spike are for measurement only; they are not the storage design, which issue #1 puts out of scope.

The probe must still add, in later issues, everything the SDK leaves out: CORS preflight and CORS response headers (evidence 6), and an explicit Origin and Host policy.

## Evidence

Each claim names its test in `spikes/issue-1/test/` and the SDK source line it rests on. SDK paths are relative to `spikes/issue-1/node_modules/@modelcontextprotocol/server/dist/`. All tests pass in local workerd: `Test Files 8 passed (8)`, `Tests 47 passed (47)`. No test uses a snapshot; every claim below is an explicit assertion.

### 1. Unknown capability keys: stripped on the legacy era only, and only at the top level

**Legacy era.** A legacy `initialize` for `2025-06-18` with `capabilities: { roots: { listChanged: true }, foo: {} }` gets a valid `InitializeResult` over SSE. The probe's `rawBody` and `declared.clientCapabilities` both hold `foo: {}`. The SDK instance's `server.getClientCapabilities()` returns `{ roots: { listChanged: true } }`, without `foo`. The cause is `ClientCapabilitiesSchema$1 = z.object({...})` (`src-Cqbh3MYc.mjs` lines 811-821), which drops keys it does not declare.

The stripping is not deep. Unknown keys inside `roots`, which is also a `z.object`, are dropped. But `experimental` is a `z.record` and `tasks` is a `z.looseObject`, so everything inside them survives, including unknown keys under `tasks.requests`.

**Modern era.** The SDK keeps unknown keys. A modern `tools/call` whose envelope capabilities are `{ foo: {}, roots: { listChanged: true, zzz: 1 }, experimental: {...}, extensions: {...} }` reaches the tool unchanged through `ctx.mcpReq.envelope`, which the SDK documents as "surfaced as received" (`createMcpHandler-D4NN8WsG.d.mts` line 2135), and `getClientCapabilities()` returns the same object, because `createMcpHandler` seeds it from the raw request `_meta` (`index.mjs` lines 1364-1365 and 1420-1423). The published type of that envelope is `{}` (`createMcpHandler-D4NN8WsG.d.mts` line 378), so the spike widens it to read it.

The SDK does not mutate the object passed as `parsedBody`, so the probe can keep references into it.

Tests: `capture.test.ts` "legacy initialize keeps unknown capability keys in the record only", "legacy era: stripping is top-level only ...", "modern era: the SDK keeps unknown capability keys ...", "does not mutate the parsedBody object it is given".

### 2. A body that was already read when `handler.fetch` gets no `parsedBody`

When `parsedBody` is missing, `classifyEntryRequest` calls `request.clone()` before reading (`index.mjs` line 1173). What happens next depends on the runtime and on how the body was read. That holds for every body tested, including a valid JSON-RPC request, not only for bodies that cannot be parsed:

| Runtime, and how the body was read                           | `clone()`                                                    | What the SDK answers                                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| workerd, after `readRequestBody` (which releases its reader) | does not throw; the clone reads as empty                     | 400 `{"code":-32700,"message":"Parse error: Invalid JSON"}`, after building a legacy server instance. The client's bytes never reach the SDK, and `onerror` receives nothing. |
| workerd, after `request.text()`                              | throws                                                       | 500 `{"code":-32603,"message":"Internal server error"}`; `onerror` gets "This ReadableStream is currently locked to a reader".                                                |
| Node v26.13.1, after `readRequestBody`                       | throws `TypeError: unusable`, as the Fetch standard requires | 500 `-32603` from `fetchFace` (`index.mjs` lines 1487-1494).                                                                                                                  |

Every outcome is wrong for the probe: the SDK either answers a different request from the one the client sent, or turns a client error into a server error. So the probe answers empty and invalid bodies itself with 400 `-32700` and never calls the SDK, and passes `parsedBody` for every other POST. Tests show this works, with no SDK instance created and no `onerror` call.

Tests: `body.test.ts` "after readRequestBody, workerd answers -32700 ...", "after request.text(), workerd answers 500 ...", "probe answers -32700 itself ...", and the control case. The Node run is `scripts/clone-after-read-node.ts`.

### 3. Body size cap

`readRequestBody(request, 65_536)` never throws for an oversized body. It returns `{ tooLarge: true }`, so the probe answers 413 itself. The SDK's own `maxRequestBodySize` option does not apply to a `parsedBody` (`createMcpHandler-D4NN8WsG.d.mts` line 3989).

| Body         | Framing                      | Result                                             | Body consumed?                                   | Source line         |
| ------------ | ---------------------------- | -------------------------------------------------- | ------------------------------------------------ | ------------------- |
| 65,537 bytes | `Content-Length` header      | `{ tooLarge: true }`                               | No: refused from the header alone                | `index.mjs` 276     |
| 65,537 bytes | chunked, no `Content-Length` | `{ tooLarge: true }`                               | Yes: refused once more than 65,536 bytes arrived | `index.mjs` 290     |
| 65,536 bytes | either                       | `{ tooLarge: false, text }` with 65,536 characters | Yes                                              | `index.mjs` 296-299 |

The same cases over real HTTP to `wrangler dev` gave 413 for 65,537 bytes and 400 `-32700` for 65,536 bytes (the test body is not JSON), with and without `Content-Length` (`scripts/http-smoke.sh`).

Tests: `body.test.ts` "readRequestBody refuses ...", "readRequestBody accepts exactly 64 KiB ...", "probe answers 413 itself ...".

### 4. A probe-minted `Mcp-Session-Id` on the stateless legacy leg

The probe adds `Mcp-Session-Id` to a legacy `initialize` reply only when that reply is an `InitializeResult`. To know that before sending headers, it buffers the reply, which is a single SSE message. An `initialize` without `params` gets HTTP 200 with an in-band JSON-RPC error (`-32603`), and no session id; a 406 gets none either.

A following legacy `tools/call` that sends the minted header succeeds, and the tool reads it as `ctx.http.req.headers.get("mcp-session-id")`. The stateless transport skips session validation when `sessionIdGenerator` is undefined (`index.mjs` line 876), so the foreign id is tolerated, and the SDK never sets a session id of its own.

Tests: `session.test.ts`.

### 5. Negotiated protocol version on a legacy `initialize`

The legacy leg always answers with SSE. Three sources give the same answer for a requested `2025-06-18` (echoed) and for an unknown `2099-01-01` (answered `2025-11-25`):

| Source                                                                                     | Cost and risk                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read the SSE reply and scan it (`negotiatedVersionFromSse` in `src/sse.ts`)                | The full cost is `tee()`, reading both branches with `Response.text()`, and the scan. For a 197-byte reply that is 0.018 ms of Node CPU against 0.005 ms for reading the body once, so the probe adds about **0.013 ms** per reply (1,000 iterations, `process.cpuUsage()`). Local workerd wall time gives the same extra 0.013–0.014 ms. The scan alone is 0.001–0.0015 ms. About 25 lines of code. |
| `server.server.getNegotiatedProtocolVersion()` on the instance the factory built           | Free. `Server._oninitialize` assigns it synchronously (`mcp-DIH4cS6P.mjs` lines 1338-1344), and the protocol layer runs that handler in a microtask (`src-Cqbh3MYc.mjs` line 6534), which has already run when `handler.fetch` resolves, before the body is read. The accessor is marked deprecated, and the probe would have to capture each instance from the factory.                             |
| Predict it from the request (`predictNegotiatedVersion`, the same rule as `_oninitialize`) | Free and available before the SDK runs, but it copies SDK logic, so it can drift on an upgrade.                                                                                                                                                                                                                                                                                                      |

Cheaper sources exist, but the read costs about 0.013 ms, and it reports what the client actually received. The spike uses the read. On `initialize` specifically, the probe now buffers the reply instead of teeing it (evidence 4), which costs no more than the teed path measured here.

Tests: `sse.test.ts`. Timing: `npm run bench:node` and `npm run bench:workerd` (`scripts/sse-cost.ts`).

### 6. Accept handling, OPTIONS and Origin

**406.** A legacy POST gets status 406, header `content-type: application/json`, and body `{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Not Acceptable: Client must accept both application/json and text/event-stream"}}` when its `Accept` is only `application/json`, only `text/event-stream`, or `*/*` (`index.mjs` lines 706-709). The check is a substring test for both media types, not content negotiation, which is why a wildcard fails. The modern path has no Accept check: a modern `tools/list` with `Accept: text/plain` gets 200 JSON.

**415.** The Content-Type check still runs when `parsedBody` is supplied: a `text/plain` POST gets 415 (`index.mjs` lines 1462-1464).

**OPTIONS.** With `Origin: https://example.test` and `Access-Control-Request-Method: POST`, and also with no Origin, the SDK answers 405, `content-type: application/json`, body `{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Method not allowed."}}`, and no `Access-Control-*` or `Allow` header. The classifier routes every non-POST to legacy with reason `http-method` (`src-Cqbh3MYc.mjs` line 5283), and the stateless legacy fallback answers any non-POST with 405 before a transport exists (`index.mjs` line 1066). So a browser client cannot pass preflight today. The probe must answer `OPTIONS` itself and add `Access-Control-Allow-Origin` and `Access-Control-Expose-Headers: mcp-session-id` to real responses.

The allowed request headers are **provisional**. The candidates are `content-type` and `accept` (checked by the SDK, evidence 6), `mcp-protocol-version`, `mcp-method` and `mcp-name` (read by `standardHeadersOf`, `index.mjs` lines 1147-1153), and `mcp-session-id`. Cloudflare's `agents` package allows the same set plus `authorization` (`DEFAULT_CORS_OPTIONS`, `handler-stateless-B5hU3dxK.js` line 224). Tools can also declare their own parameter headers, which the SDK checks (`index.mjs` lines 1390-1405), so a later issue must settle the list against the MCP specification's transport section, which this spike did not read.

**`originValidationResponse` input form.** It takes lowercase hostnames: no scheme and no port, with brackets for IPv6. It also accepts `<scheme>://*`, lowercase, for a non-web scheme such as `moz-extension://*`, but not `http://*` or `https://*`. The rule is in the JSDoc at `index.mjs` lines 1582-1596, and `<scheme>://*` with its lowercase requirement is at lines 1589-1592. The URL parser lowercases the Origin's hostname and the allowlist is compared exactly, so an entry such as `Example.test` never matches.

| Origin header               | Allowlist                  | Result                             |
| --------------------------- | -------------------------- | ---------------------------------- |
| `https://example.test`      | `["example.test"]`         | allowed                            |
| `https://example.test:8443` | `["example.test"]`         | allowed (port-agnostic)            |
| `https://EXAMPLE.test`      | `["example.test"]`         | allowed                            |
| `https://example.test`      | `["Example.test"]`         | 403                                |
| `http://[::1]:3000`         | `["[::1]"]`                | allowed                            |
| `moz-extension://4b2a-uuid` | `["moz-extension://*"]`    | allowed                            |
| `https://example.test`      | `["https://example.test"]` | 403 `Invalid Origin: example.test` |
| `https://example.test`      | `["https://*"]`            | 403                                |
| `null`                      | `["example.test"]`         | 403                                |
| absent                      | `[]`                       | allowed                            |

Tests: `edge.test.ts`.

### 7. Legacy routing reasons, and rejections outside the classification

Every reason in the `InboundLegacyRouteReason` union (`createMcpHandler-D4NN8WsG.d.mts` lines 1225-1231) was observed through the probe: `http-method`, `initialize`, `no-claim`, `notification`, `batch`, `response`.

**`kind` is not `era`.** The classifier's `kind` is the route it chose. On a modern route, `classification.era` is the era of the version the envelope claims (`classificationForClaim`, `src-Cqbh3MYc.mjs` lines 5146-5151). A `_meta` naming `1999-01-01` is `kind: "modern"` with `era: "legacy"`, because any envelope claim routes to the modern path, which then answers it `-32022`. Storing `kind` in a column called `era` would record that request as modern-era traffic. The spike stores them in separate `classification_kind` and `classification_era` columns, with `classification_era` NULL except on modern routes.

The classifier itself returns some rejections; others come later, from `createMcpHandler`. The probe must record the first kind in `classification` and the second kind only in `reply`:

| Request                                 | `kind`                                                              | `era`      | Client gets                                                          | Where the error comes from                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Body `{}`                               | reject `-32600` (`jsonrpc-shape/invalid-json-rpc-body`)             |            | 400 `-32600`                                                         | classifier, `src-Cqbh3MYc.mjs` line 5295                                                                               |
| Body `[]`                               | reject `-32600` (`jsonrpc-shape/empty-batch`)                       |            | 400 `-32600`                                                         | classifier, line 5176                                                                                                  |
| Header and `_meta` versions differ      | reject `-32020` (`era-classification/header-body-version-mismatch`) |            | 400 `-32020`                                                         | classifier, line 5205                                                                                                  |
| Envelope missing `clientCapabilities`   | reject `-32602` (`envelope/envelope-invalid`)                       |            | 400 `-32602`                                                         | classifier, line 5203                                                                                                  |
| Envelope capabilities of the wrong type | reject `-32602` (`envelope/envelope-invalid`)                       |            | 400 `-32602`                                                         | classifier, line 5203                                                                                                  |
| Modern header, no envelope              | reject `-32602` (`envelope/modern-header-without-claim`)            |            | 400 `-32602`                                                         | classifier, lines 5214-5219                                                                                            |
| `_meta` names `1999-01-01`              | modern                                                              | **legacy** | 400 `-32022`, `supported: ["2026-07-28"]`, `requested: "1999-01-01"` | after classification: `serveModern`, `index.mjs` lines 1347-1355                                                       |
| `MCP-Protocol-Version` header missing   | modern                                                              | modern     | 400 `-32020`                                                         | after classification: `validateStandardRequestHeaders`, `src-Cqbh3MYc.mjs` lines 5123-5142, called at `index.mjs` 1356 |
| `Mcp-Method` header missing             | modern                                                              | modern     | 400 `-32020`                                                         | after classification, same function                                                                                    |

So `-32022` never comes from the classifier, `-32020` comes from either place, and `-32600` and `-32602` came only from the classifier in these cases. Two more codes arise after classification by reading the source, without a test here: `-32021` for a missing required client capability (`index.mjs` lines 1366-1375), and in-band `-32602` for invalid method params, which is answered with HTTP 200 (`src-Cqbh3MYc.mjs` lines 4983-5003). A legacy `initialize` without `params` is another in-band case: HTTP 200 with `-32603` (evidence 4).

Tests: `classification.test.ts` (every row above is an explicit assertion), `capture.test.ts` for the `-32022` and `-32020` scenarios.

### 8. CPU time per invocation, and the plan

**Limit.** Workers Free allows 10 ms of CPU time per HTTP request. Workers Paid defaults to 30 seconds and can be raised to 5 minutes. Waiting on network requests and database queries does not count as CPU time. ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), read 2026-11-12, last updated 2026-10-29.) The metrics page adds that higher quantiles can appear to exceed the limit without errors, "because of a mechanism in the Workers runtime that allows rollover CPU time for requests below the CPU limit" ([Metrics and analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/), read 2026-11-12, last updated 2026-07-01).

**Deployed p50 and p95: not measured.** They need an account; see owner-run step 4. No deployed number appears in this record.

**Local numbers, indicative only.** None of these is CPU time on Cloudflare. Rows marked "wall" are elapsed time, not CPU time.

| Measurement                                                        | Modern `tools/call`         | Legacy `initialize` + `tools/call` pair            | What it is                                                                                                                             |
| ------------------------------------------------------------------ | --------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Node CPU, warm, p50 / p95 (ms), several runs of 100                | 0.21–0.23 / 0.74–0.90       | 0.32–0.34 / 1.03–1.15                              | `process.cpuUsage()`; the Node build of the SDK uses Ajv, not the Worker's validator                                                   |
| Node CPU, first request after startup (ms)                         | about 44 when it runs first | about 44 when it runs first                        | whichever request runs first pays it; the second one then costs about 6                                                                |
| Node CPU, `preloadSchemas()` at startup (ms)                       | 8.3–8.7                     |                                                    | the workerd build runs this at module load (`shimsWorkerd.mjs` line 10), so it counts toward the 1-second startup limit, not a request |
| Local workerd **wall**, first request in a fresh isolate (ms)      | 13–14                       | 5 (cold `initialize`, measured in its own process) | `performance.now()`, whole-millisecond clock                                                                                           |
| Local workerd **wall**, warm, mean (ms), no D1                     | 0.24–0.26                   | 0.47–0.48                                          | whole-millisecond clock, so p50 reads 0 and p95 reads 1                                                                                |
| Local workerd **wall**, warm, mean (ms), one D1 insert per request | 0.75–0.79                   | 1.11–1.12                                          | includes local SQLite work and I/O wait                                                                                                |
| HTTP **wall** through `wrangler dev`, p50 / p95 (ms), no D1        | 2.5 / 3.9                   | 2.5 / 3.8 per request                              | client-side, includes the local proxy                                                                                                  |
| Same, with D1                                                      | 3.4 / 4.7                   | 3.3 / 5.6 per request                              |                                                                                                                                        |

**What this says about the plan: undecided.** Warm requests use a small fraction of 10 ms locally. The first request in a fresh isolate is the risk: 13–14 ms of wall time in local workerd for a modern request, and about 44 ms of CPU time in Node for either era. Wall time is not CPU time and Node is not workerd, so neither number predicts the deployed cost, and the rollover mechanism may absorb some of it. Owner-run step 4 settles it. If the deployed p95, or the first request after a deploy, exceeds 10 ms, the Workers Paid plan is required (minimum charge $5 per month, with 30 million CPU milliseconds included per month: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), read 2026-11-12, last updated 2026-10-02).

Commands: `npm run bench:node`, `node scripts/bench-node.ts 100 20 legacy-first`, `npm run bench:workerd`, `node scripts/bench-http.ts http://127.0.0.1:8787 100 .tmp/bench-http-local.ndjson 0`.

### 9. Compatibility flags

**No compatibility flag is needed, and `nodejs_compat_v2` was not needed.** The SDK runs even with Node.js compatibility switched off completely.

The reason is in the package, not the runtime. `@modelcontextprotocol/server` exports a `workerd` condition for its `./_shims` entry (`package.json` line 64). Wrangler resolves it to `shimsWorkerd.mjs`, which uses the `@cfworker/json-schema` validator and imports no `node:` module. The local dev bundle (696,926 bytes uncompressed, 139,297 gzipped) contains `shimsWorkerd.mjs` and no `node:` import.

The current documentation also changed the question. For compatibility dates of 2026-08-04 or later, Workers enables both `nodejs_compat` and `nodejs_compat_v2` by default, and the flags are ignored ([Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/), read 2026-11-12, last updated 2026-08-12; [Compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/), last updated 2026-09-18). So `nodejs_compat_v2` is not stale, but it is redundant on a current date.

`scripts/compat-matrix.sh`, run against `wrangler dev --local`. The last column is what the local-only `/__runtime` route reported for `typeof process` and `typeof Buffer`, which proves the setting took effect:

| Compatibility date | Flags                                     | Modern `tools/call` | Legacy `initialize` | `process` / `Buffer`  |
| ------------------ | ----------------------------------------- | ------------------- | ------------------- | --------------------- |
| 2026-11-10         | none                                      | 200                 | 200                 | object / function     |
| 2026-11-10         | `no_nodejs_compat`, `no_nodejs_compat_v2` | 200                 | 200                 | undefined / undefined |
| 2026-11-10         | `nodejs_compat`                           | 200                 | 200                 | object / function     |
| 2026-08-03         | none                                      | 200                 | 200                 | undefined / undefined |
| 2026-08-03         | `nodejs_compat`                           | 200                 | 200                 | object / function     |
| 2026-08-03         | `nodejs_compat_v2`                        | 200                 | 200                 | object / function     |

`/__runtime` answers only when the request's hostname is `localhost`, `127.0.0.1` or `[::1]`. On a deployed Worker it falls through to the static assets and answers 404 (`test/worker.test.ts`).

Minimal working setting: `"compatibility_flags": []` with a current `compatibility_date`. Cloudflare's `agents` package would change this, because it imports `node:async_hooks` (evidence 12).

### 10. Verified Wrangler configuration snippets

Each snippet was checked against the page named under it, read on 2026-11-12, and against `node_modules/wrangler/config-schema.json` from wrangler 4.160.1. All of them are in [`spikes/issue-1/wrangler.jsonc`](../../spikes/issue-1/wrangler.jsonc), and `wrangler dev --local` and `wrangler types` (also with `--env with-invocation-logs`) accept that file without warnings. The configuration page recommends `wrangler.jsonc` for new projects.

**Cron triggers** ([configuration, Triggers](https://developers.cloudflare.com/workers/wrangler/configuration/#triggers), last updated 2026-11-11). Locally, `curl http://127.0.0.1:8787/cdn-cgi/local/scheduled` ran the `scheduled` handler ([Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/#test-cron-triggers-locally), last updated 2026-10-17).

```jsonc
"triggers": { "crons": ["17 3 * * *"] }
```

**D1 binding, including `migrations_dir`** ([configuration, D1 databases](https://developers.cloudflare.com/workers/wrangler/configuration/#d1-databases)). `migrations_table` is not documented on that page, so it is not used. Bindings are not inheritable, so a named environment must restate this block ([configuration, Environments](https://developers.cloudflare.com/workers/wrangler/configuration/#environments)).

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "canimcp-probe-spike-1",
    "database_id": "<id from wrangler d1 create>",
    "migrations_dir": "migrations"
  }
]
```

**`compatibility_flags`** ([configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), and the Node.js compatibility page above). Its only example on the configuration page is `["nodejs_compat_v2"]` under Hyperdrive, "required for database drivers", which does not apply here.

```jsonc
"compatibility_date": "2026-11-10",
"compatibility_flags": []
```

**Static assets for a landing page** ([configuration, Assets](https://developers.cloudflare.com/workers/wrangler/configuration/#assets)). `run_worker_first` sends the listed paths to the Worker; `GET /` returned `public/index.html` with 200 locally. This is the spike's exact block; a later issue keeps only its MCP path.

```jsonc
"assets": {
  "directory": "./public",
  "binding": "ASSETS",
  "html_handling": "auto-trailing-slash",
  "not_found_handling": "none",
  "run_worker_first": ["/mcp", "/mcp-d1", "/__runtime"]
}
```

**Rate Limiting binding** ([Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), last updated 2026-10-21; the configuration page does not document it). `namespace_id` is an integer in a string, unique to the account, and `period` must be 10 or 60. Limits are approximate and per Cloudflare location. The spike declares it to check the shape but never calls it.

```jsonc
"ratelimits": [
  { "name": "PROBE_RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 100, "period": 60 } }
]
```

**Observability log settings** ([configuration, Observability](https://developers.cloudflare.com/workers/wrangler/configuration/#observability); `logs.invocation_logs` from [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), last updated 2026-10-12). Later issues set invocation logs off, as here, because each invocation log "contains details such as the Request, Response, and related metadata" (Workers Logs page). With `enabled: true`, the Worker's own `console.log` output is still kept, so the code must log nothing a client supplied. The spike logs only `d1RowsWritten` and SDK error class names, not messages, because SDK error messages embed client-supplied strings.

```jsonc
"observability": {
  "enabled": true,
  "head_sampling_rate": 1,
  "logs": { "invocation_logs": false }
}
```

The fallback environment `with-invocation-logs` in the same file turns invocation logs on, for owner-run step 4b only.

### 11. D1 rows written, and the daily cap

The spike's table (`migrations/0001_probe_records.sql`) stores no request content: only `received_at`, `classification_kind`, `classification_era` and `reply_status`, with an index on each of the first three. One insert reports `meta.rows_written = 4` in local D1: one table row plus one entry per index. It is still 4 when the indexed `classification_era` column is NULL, and all 301 inserts made through `wrangler dev` reported 4. This is local D1 only; owner-run step 5 confirms the remote number.

The Free plan allows 100,000 rows written per day, resetting at 00:00 UTC. Past the limit, "you will not be able to run queries against D1" ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), read 2026-11-12, last updated 2026-10-30). The D1 limits page does not state the daily row limits; only the pricing page does.

**Largest daily cap that fits, if the local figure holds remotely:** 100,000 ÷ 4 = **25,000 recorded requests per day**, and only if nothing else writes to D1 that day. Any other write lowers it: for example, one extra single-row update per request, such as a counter in an unindexed table, gives 100,000 ÷ 5 = 20,000.

Tests: `d1.test.ts`.

### 12. Cloudflare's `agents` package exports two different `createMcpHandler` functions

The package was read from `npm pack agents@0.33.0` in `spikes/issue-1/.tmp/agents-pack/` and never executed. Neither export is the SDK's function.

**`agents/mcp/server`** exports `createStatelessMcpHandler as createMcpHandler` (`dist/mcp/server/index.js` line 2). It wraps the SDK's `createMcpHandler`. Line numbers in this table refer to `dist/handler-stateless-B5hU3dxK.js`.

**`agents/mcp`** exports a different `createMcpHandler` (`dist/mcp/index.js` lines 1441-1448) that dispatches on its first argument. A function is treated as an SDK v2 factory and handed to the same `createStatelessMcpHandler`. An SDK **v1** `McpServer` or `Server` instance, from `@modelcontextprotocol/sdk`, triggers a deprecation warning and goes to `createLegacyMcpHandler` (lines 1399-1436), a sessionful handler over the v1 `WorkerTransport`. That module also imports `@modelcontextprotocol/sdk` (v1), `@modelcontextprotocol/client` and the `Agent` runtime (lines 1-11), so importing it pulls in both SDK generations.

| Behavior         | SDK `createMcpHandler` (2.3.1)                                                                      | `agents/mcp/server` `createMcpHandler` (0.33.0)                                                                                                                                                                                   | `agents/mcp` `createMcpHandler` with a v1 server              |
| ---------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| SDK version      | itself                                                                                              | optional peer dependency `@modelcontextprotocol/server` **2.4.0** exactly, not 2.3.1                                                                                                                                              | `@modelcontextprotocol/sdk` 1.32.2 (optional peer dependency) |
| Legacy traffic   | built-in `legacy: 'stateless'` fallback                                                             | calls the SDK with `legacy: 'reject'` (line 300) and routes legacy traffic to its own compatibility handler using `isLegacyRequest`                                                                                               | sessionful v1 transport; no 2026-07-28 serving                |
| Routing          | none                                                                                                | answers 404 for any path other than `route` (default `/mcp`, line 308)                                                                                                                                                            | same `route` check, default `/mcp`                            |
| Host and Origin  | none ("deliberately validation-free")                                                               | checks Host when the endpoint is localhost or `*.workers.dev`, or against `allowedHostnames`; checks Origin against localhost, the `workers.dev` hostname and the configured CORS origin unless `allowedOriginHostnames` is `"*"` | none in this function                                         |
| OPTIONS and CORS | 405, no CORS headers                                                                                | answers OPTIONS itself (line 328) and adds CORS headers, default origin `*` (line 224)                                                                                                                                            | not handled in this function                                  |
| Options          | `legacy`, `onerror`, `responseMode`, `bus`, `maxSubscriptions`, `keepAliveMs`, `maxRequestBodySize` | adds `route`, `corsOptions`, `allowedHostnames`, `allowedOriginHostnames`, `authContext`; throws on `bus` and on SDK v1 transport options                                                                                         | `route`, `authContext`, and v1 transport options              |
| Node.js APIs     | none on workerd                                                                                     | imports `node:async_hooks` (line 1)                                                                                                                                                                                               | same, through the shared module                               |

Its documentation (`docs/mcp-servers.md` in the package) describes the `agents/mcp/server` function, so it must not be read as documentation for the SDK's function, or the reverse.

### 13. `wrangler d1 execute --json` output shape

Local shape, from `wrangler d1 execute canimcp-probe-spike-1 --local --json --command "SELECT id, received_at, classification_kind, classification_era, reply_status FROM probe_records LIMIT 1"`:

```json
[
  {
    "results": [
      {
        "id": 1,
        "received_at": "2026-11-11T23:57:20.024Z",
        "classification_kind": "legacy",
        "classification_era": null,
        "reply_status": 200
      }
    ],
    "success": true,
    "meta": { "duration": 1 }
  }
]
```

The local `meta` has only `duration`, even for an `INSERT`. The `--remote` shape, which the export script will parse, is owner-run step 5.

## Alternatives considered

**Pure SDK (`createMcpHandler` alone, no probe edge).** It serves both eras correctly, but the probe could only see what the SDK keeps, and on the legacy era the SDK drops unknown capability keys (evidence 1). Reading the body for capture first and then letting the SDK read it again fails on both runtimes (evidence 2). It loses because raw capture is the product.

**Hand-rolled JSON-RPC.** It gives full control of the bytes, but it would have to reimplement both protocol eras, the validation ladder in evidence 7, SSE replies, and version negotiation, and keep them in step with the spec. It loses because the SDK already does this and the probe needs only the bytes and the classification.

**A no-storage echo probe** that answers each client with what it declared and asks people to paste it somewhere. It needs no D1 and no CPU budget for writes. It loses because it has no corroboration counts (one paste is one claim, never "N clients said this"), no version history (nothing records when a client's declaration changed), and it relies on manual, lossy pasting that drops fields and selects for motivated reporters.

**Cloudflare's `agents` `createMcpHandler`, either export.** It adds CORS and routing the probe needs, but it pins SDK 2.4.0, needs `node:async_hooks`, takes over legacy routing, and still hides the raw body (evidence 12). The probe can add CORS itself in a few lines.

## Consequences

### Facts later issues can treat as settled

1. Pass `parsedBody` on every POST, and answer 413 (cap exceeded) and 400 `-32700` (empty, invalid JSON, unreadable) yourself. Never call `handler.fetch` on a body that was already read without `parsedBody`, whatever the body contains.
2. Record `classifyInboundRequest`'s outcome as the classification, and the reply's status and JSON-RPC error code separately.
3. Never use the classifier's `kind` as the era. Store `kind` and `era` separately: a `_meta` naming a pre-2026 version is `kind: "modern"`, `era: "legacy"`.
4. The legacy leg answers with SSE and returns 406 unless `Accept` names both `application/json` and `text/event-stream`; `*/*` is refused.
5. The SDK strips unknown top-level capability keys on the legacy era only. Raw capture still matters for the modern era, because the record must not depend on what the SDK keeps.
6. The SDK does no CORS and answers `OPTIONS` with 405. The probe owns preflight; the allowed-header list is provisional (evidence 6).
7. `originValidationResponse` takes lowercase hostnames without scheme or port, plus `<scheme>://*` for non-web schemes only (`index.mjs` lines 1582-1596). There is no wildcard for websites.
8. A probe-minted `Mcp-Session-Id` is tolerated on the stateless legacy leg and visible to tools through `ctx.http.req`. Mint it only on a real `InitializeResult`.
9. No compatibility flag is needed with SDK 2.3.1 on a current compatibility date.
10. Keep invocation logs off, and log nothing a client supplied, including SDK error messages.

### Local-only figures, pending owner-run steps

11. One insert with three indexes writes 4 rows in **local** D1, which would fit at most 25,000 such inserts per day on the Free plan. Owner-run step 5 confirms the remote figure.

### Open

12. **Whether the Free plan suffices is undecided.** Warm requests are well under 10 ms locally, but the first request in a fresh isolate took 13–14 ms of wall time in local workerd and about 44 ms of CPU in Node. Owner-run step 4 decides between Free and Workers Paid.

## Owner-run steps

These need a Cloudflare account, which the spike did not use. Run them from `spikes/issue-1/` in this order. None of them was run.

> **Warning: the scratch Worker is public.** `wrangler deploy` publishes it on `workers.dev`, where anyone can call `/mcp` and `/mcp-d1`. It stores no request content and keeps invocation logs off, but it is unauthenticated and its rate limiter is not enforced. Run step 6 as soon as the measurements are done.

| Step                                                          | Command                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | What it settles                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Sign in                                                    | `npx wrangler login`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Access for the steps below.                                                                                                                                                                                                                                                                 |
| 2. Create and migrate the scratch database                    | `npx wrangler d1 create canimcp-probe-spike-1` **without** `--update-config`. Copy the printed `database_id` by hand into **both** `database_id` fields in `wrangler.jsonc` (top level and `env.with-invocation-logs`). `--update-config` lets Wrangler rewrite the file itself, which was not tested and may drop its comments. Then `npx wrangler d1 migrations apply canimcp-probe-spike-1 --remote`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | The table with three indexes exists remotely.                                                                                                                                                                                                                                               |
| 3. Deploy the scratch Worker                                  | `npx wrangler deploy`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | The minimal flag setting deploys; the output's `Total Upload` and `startup_time_ms` give the real bundle size and startup time. Optionally, `npx wrangler check startup` profiles startup without uploading (it runs `deploy --dry-run` internally, which is why the spike did not run it). |
| 4a. Deployed CPU from the Workers metrics, no request logging | `mkdir -p .tmp`, then `node scripts/bench-http.ts https://canimcp-probe-spike-1.<your-subdomain>.workers.dev 100`. It appends every request to `.tmp/bench-http.ndjson` as it goes, records non-2xx answers instead of stopping, and writes one `window` line per run with UTC start and end. Then create an API token with **Account > Account Analytics > Read** ([token setup](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)) and run `CLOUDFLARE_ACCOUNT_TAG=<account id> CLOUDFLARE_ANALYTICS_TOKEN=<token> node scripts/owner-cpu-graphql.ts canimcp-probe-spike-1 .tmp/bench-http.ndjson`. The script introspects the schema, prints every `cpuTime*` quantile field with its description (which gives the unit), and queries `workersInvocationsAdaptive` for each window with `cpuTimeP50`, `cpuTimeP99`, and `cpuTimeP95` if the schema has it. The query shape, the filter keys and `cpuTimeP50` and `cpuTimeP99` come from [Querying Workers Metrics with GraphQL](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/); `cpuTimeP95` is not documented there. The dashboard's **CPU Time per execution** chart shows the same metrics as quantiles ([Metrics and analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)). | p50 (and p95 if available) CPU time for the four runs, and so whether the Free plan suffices.                                                                                                                                                                                               |
| 4b. Only if 4a has no p95: invocation logs, briefly           | `npx wrangler deploy --env with-invocation-logs`, which deploys a separate Worker named `canimcp-probe-spike-1-with-invocation-logs` ([environments](https://developers.cloudflare.com/workers/wrangler/environments/)). Rerun `bench-http.ts` against its URL with a different output file. In **Observability > Query Builder**, filter to that Worker and each window, and add the **Median (P50)** and **P95** visualizations on `$workers.cpuTimeMs` ([Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/)); or export the events and run `node scripts/cpu-percentiles.ts <file>`. Then delete it straight away: `npx wrangler delete --env with-invocation-logs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | p95 CPU time, at the cost of request logging for the length of the run.                                                                                                                                                                                                                     |
| 5. Remote D1 output shape and rows written                    | `npx wrangler d1 execute canimcp-probe-spike-1 --remote --json --command "SELECT id, received_at, classification_kind, classification_era, reply_status FROM probe_records LIMIT 1"`, then the same with `--command "INSERT INTO probe_records (received_at, classification_kind, classification_era, reply_status) VALUES ('2026-11-12T00:00:00Z','legacy',NULL,200)"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | The `--remote --json` shape the export script parses (one line of it goes into this record), and whether remote `meta.rows_written` is 4 per insert.                                                                                                                                        |
| 6. Tear down                                                  | `npx wrangler delete canimcp-probe-spike-1`, `npx wrangler delete --env with-invocation-logs` if step 4b ran, and `npx wrangler d1 delete canimcp-probe-spike-1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Removes the public scratch Workers and the database. `wrangler delete [name]` and `--env` are from `npx wrangler delete --help` (wrangler 4.160.1).                                                                                                                                         |

## Documentation drift and tooling notes

- The [Vitest integration configuration page](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/) (last updated 2026-11-10) says `readD1Migrations` is exported from `@cloudflare/vitest-plugin/config`. The installed 1.8.0 package exports only the root entry, and the page's own example imports from the root.
- The [Vitest test APIs page](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/) says to type `env` through a `ProvidedEnv` interface. In the installed types, `env` is `Cloudflare.Env`, so the spike merges into that instead (`test/env.d.ts`).
- `@cloudflare/vitest-pool-workers` is deprecated in favor of `@cloudflare/vitest-plugin` (its README), and its latest version, 0.23.0, pulled vulnerable nested copies of wrangler and miniflare (`npm audit`: 6 high). The spike uses `@cloudflare/vitest-plugin` 1.8.0, for which `npm audit` reports 0 vulnerabilities.
- The SDK publishes `RequestMetaEnvelope` as `{}` (`createMcpHandler-D4NN8WsG.d.mts` line 378), so typed code cannot read `ctx.mcpReq.envelope` keys without a cast.
- `vp test` does not apply to this spike yet. The spike has no local `vite-plus`, so `vp test run` uses the global Vite+ 1.2.0 Vitest instead of the project's Vitest 5.1.0 with the Cloudflare plugin, and every file fails with `TypeError: Cannot read properties of undefined (reading 'config')`. `npm test` is the runner until issue #4 scaffolds the project with Vite+.

## Sources read

All read on 2026-11-12 as Markdown (`<page>/index.md`).

| Page                                                                                                                                                                                                                      | Last updated              | Used for                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)                                                                                                                                              | 2026-10-29                | CPU limit, startup limit, bundle size, where CPU time is reported |
| [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)                                                                                                                                            | 2026-10-02                | Paid plan price and CPU allowance                                 |
| [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)                                                                                                                                                        | 2026-10-30                | queries per invocation (50 on Free)                               |
| [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)                                                                                                                                                      | 2026-10-30                | 100,000 rows written per day, index writes, reset time            |
| [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)                                                                                                                               | 2026-11-11                | triggers, D1, flags, assets, observability, inheritance           |
| [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/)                                                                                                                                 | 2026-10-18                | environment Worker naming                                         |
| [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)                                                                                                                      | 2026-10-21                | `ratelimits` block                                                |
| [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)                                                                                                                                | 2026-10-12                | `logs.invocation_logs`, what an invocation log holds              |
| [Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/)                                                                                                                                   | 2026-10-02                | `$workers.cpuTimeMs`, P50 and P95 visualizations                  |
| [Metrics and analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)                                                                                                                   | 2026-07-01                | CPU time chart, rollover note                                     |
| [Querying Workers Metrics with GraphQL](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)                                                                                      | 2026-04-23                | `workersInvocationsAdaptive`, `cpuTimeP50`, `cpuTimeP99`          |
| [GraphQL introspection](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/introspection/)                                                                                                        | 2026-04-23                | `__schema` introspection                                          |
| [Analytics API token](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)                                                                                             | 2026-04-23                | Account Analytics Read permission                                 |
| [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)                                                                                                                                   | 2026-08-12                | default-on Node.js compatibility from 2026-08-04                  |
| [Compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)                                                                                                                       | 2026-09-18                | `nodejs_compat_v2` semantics                                      |
| [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)                                                                                                                                   | 2026-10-17                | local scheduled endpoint                                          |
| [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/)                                                                                                                                           | 2026-04-21                | `d1 execute` flags                                                |
| [Workers Trace Events](https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/workers_trace_events/)                                                                                                 | 2026-09-14                | `CPUTimeMs` field                                                 |
| [Vitest integration: configuration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/) and [test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/) | 2026-11-10 and 2026-10-10 | test setup                                                        |

## Commands run

Every command ran locally; none reached a Cloudflare account. Counts are how many times each ran, across the first pass and the review round.

| Command                                                                                                                                                                                                 | Runs                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `gh issue view 1 --repo schalkneethling/canimcp-probe --comments` (and once with `--json`)                                                                                                              | 2                                                                 |
| `npm view` for `@modelcontextprotocol/server`, `wrangler`, `vitest`, `@cloudflare/vitest-pool-workers`, `@cloudflare/vitest-plugin`, `agents`, `@cloudflare/workers-types`, `typescript`, `@types/node` | 1 each                                                            |
| `npm install --save-exact @modelcontextprotocol/server@2.3.1`                                                                                                                                           | 1                                                                 |
| `npm install --save-dev --save-exact wrangler@4.160.1 vitest@4.1.12 @cloudflare/vitest-pool-workers@0.23.0 typescript@7.0.2`                                                                            | 1                                                                 |
| `npm audit`                                                                                                                                                                                             | 2                                                                 |
| `npm uninstall @cloudflare/vitest-pool-workers`, then `npm install --save-dev --save-exact vitest@5.1.0 @cloudflare/vitest-plugin@1.8.0`                                                                | 1                                                                 |
| `npm install --save-dev --save-exact @types/node@26.6.6`                                                                                                                                                | 1                                                                 |
| `npm pack agents@0.33.0` into `.tmp/agents-pack/`, then `tar -xzf`                                                                                                                                      | 1                                                                 |
| `curl -sSL https://developers.cloudflare.com/<page>/index.md` for each page in "Sources read"                                                                                                           | 1 each                                                            |
| One web search for the GraphQL quantile field list (third-party results only, so not relied on)                                                                                                         | 1                                                                 |
| `npx wrangler types`                                                                                                                                                                                    | 6, plus 1 with `--env with-invocation-logs`                       |
| `npx wrangler types --check`                                                                                                                                                                            | 1                                                                 |
| `npx wrangler --help` variants for `dev`, `tail`, `types`, `check startup`, `deploy`, `delete`, `login`, `d1 create`, `d1 delete`, `d1 execute`, `d1 migrations apply`                                  | 1 or 2 each                                                       |
| `npx wrangler d1 migrations apply canimcp-probe-spike-1 --local`                                                                                                                                        | 2 (the second after deleting `.wrangler/state` for the new table) |
| `npx wrangler dev --local --port 8787 --ip 127.0.0.1`                                                                                                                                                   | 2                                                                 |
| `sh scripts/http-smoke.sh`                                                                                                                                                                              | 3                                                                 |
| `node scripts/bench-http.ts` against `http://127.0.0.1:8787`, and once against a closed port to check that failures are recorded                                                                        | 3                                                                 |
| `npx wrangler d1 execute canimcp-probe-spike-1 --local --json`                                                                                                                                          | 3 (two SELECTs, one INSERT)                                       |
| `sh scripts/compat-matrix.sh`                                                                                                                                                                           | 3                                                                 |
| `node scripts/bench-node.ts 100 20` (with and without `legacy-first`)                                                                                                                                   | 6                                                                 |
| `npm run bench:workerd`                                                                                                                                                                                 | 6                                                                 |
| `node scripts/clone-after-read-node.ts`                                                                                                                                                                 | 1                                                                 |
| `npx vitest run` (whole suite or one file, including the red run and temporary diagnostic tests that were deleted)                                                                                      | about 25                                                          |
| `npx tsc --noEmit` and `npm run typecheck`                                                                                                                                                              | about 10                                                          |
| `vp check` and `vp check --fix`                                                                                                                                                                         | about 10                                                          |
| `vp test run`                                                                                                                                                                                           | 2 (fails as described above)                                      |
