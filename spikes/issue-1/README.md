# Spike for issue #1: raw capture in front of `@modelcontextprotocol/server` 2.3.1

This folder is a throwaway Worker. It exists to answer the questions in issue #1, and the answers are in [`docs/adr/0001-sdk-strategy.md`](../../docs/adr/0001-sdk-strategy.md). Issue #4 scaffolds the real project, so nothing here is production code, and the record shape and D1 table are for measurement only, not the storage design.

Run every command from this folder. Nothing in the first two sections needs a Cloudflare account; the steps that do are listed under "Owner-run steps" in the ADR.

> **Warning: deploying this spike makes it public.** `npx wrangler deploy` publishes an unauthenticated endpoint on `workers.dev`. It stores no request content, keeps invocation logs off, and its `/__runtime` diagnostic answers only on local hostnames, but its rate limiter is declared and never enforced. Deploy it only for the owner-run CPU measurement, and tear it down afterwards with `npx wrangler delete canimcp-probe-spike-1` (and `npx wrangler delete --env with-invocation-logs` if you used that environment). The `with-invocation-logs` environment turns request logging on; use it only as the fallback in owner-run step 4b.

## Setup

```sh
npm ci
mkdir -p .tmp
npm run types                 # generates worker-configuration.d.ts (git-ignored)
npm run d1:migrate:local      # creates the local D1 table used by wrangler dev
```

## Experiments

| What it shows                                                                                        | Command                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All acceptance-criteria tests, inside local workerd                                                  | `npm test`                                                                                                                                                                          |
| Type check (regenerates the Worker types first)                                                      | `npm run typecheck`                                                                                                                                                                 |
| Format and lint with Vite+ defaults                                                                  | `vp check src test bench scripts vitest.config.ts`                                                                                                                                  |
| Local CPU per request in Node (indicative only); add `legacy-first` to measure a cold legacy request | `npm run bench:node`, or `node scripts/bench-node.ts 100 20 legacy-first`                                                                                                           |
| Local wall time per request inside workerd (whole-millisecond clock, indicative only, not CPU time)  | `npm run bench:workerd`                                                                                                                                                             |
| The already-read body experiment in Node, for comparison with workerd                                | `node scripts/clone-after-read-node.ts`                                                                                                                                             |
| Compatibility flag matrix (starts `wrangler dev --local` six times)                                  | `npm run compat:matrix`                                                                                                                                                             |
| Edge cases over real HTTP                                                                            | `npm run dev`, then in a second terminal `sh scripts/http-smoke.sh`                                                                                                                 |
| Local wall-clock load, with and without D1, written to `.tmp/` request by request                    | `npm run dev`, then `node scripts/bench-http.ts http://127.0.0.1:8787 100 .tmp/bench-http-local.ndjson 0`                                                                           |
| Local `d1 execute --json` shape                                                                      | `npx wrangler d1 execute canimcp-probe-spike-1 --local --json --command "SELECT id, received_at, classification_kind, classification_era, reply_status FROM probe_records LIMIT 1"` |

`vp test` does not apply yet: without a local `vite-plus` it runs the global Vite+ Vitest instead of this folder's Vitest 5.1.0 and Cloudflare plugin, and every file fails. Use `npm test` until issue #4.

Do not run `npm run compat:matrix` while `npm run dev` is running. Both write to `.wrangler/tmp`, and one can delete the other's build output.

## Owner-run helpers

| Step in the ADR                                                | Command                                                                                                                                                                                             |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4a, deployed CPU from the Workers metrics (no request logging) | `node scripts/bench-http.ts <workers.dev URL> 100`, then `CLOUDFLARE_ACCOUNT_TAG=... CLOUDFLARE_ANALYTICS_TOKEN=... node scripts/owner-cpu-graphql.ts canimcp-probe-spike-1 .tmp/bench-http.ndjson` |
| 4b, fallback p50 and p95 from exported invocation events       | `node scripts/cpu-percentiles.ts events.json`                                                                                                                                                       |

When you create the database, run `npx wrangler d1 create canimcp-probe-spike-1` without `--update-config`, and paste the printed `database_id` by hand into both `database_id` fields in `wrangler.jsonc`. With `--update-config`, Wrangler rewrites the file itself, which was not tested and may drop its comments.

## Layout

- `src/probe.ts` is the probe edge: it reads the body under a 64 KiB cap, parses it once, classifies it with the SDK's `classifyInboundRequest`, and calls `handler.fetch(request, { parsedBody })`.
- `src/server.ts` is the per-request `McpServer` factory with one tool, `spike_echo`.
- `src/sse.ts` reads the negotiated version from an SSE reply, and holds the cheaper prediction it was compared with.
- `src/store.ts` is the single D1 insert used to count rows written. It writes no request content.
- `src/worker.ts` wires it together: `/mcp` records nothing, `/mcp-d1` adds one D1 insert, `/__runtime` reports the Node.js compatibility mode on local hostnames only, and everything else is a static asset.
- `test/` holds the Vitest tests; `bench/` holds the opt-in workerd timing runs; `scripts/` holds the benchmarks and owner-run helpers.
