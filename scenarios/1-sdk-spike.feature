# Acceptance criteria for issue #1, "Spike: raw capture in front of
# @modelcontextprotocol/server 2.3.1 on a Worker".
#
# There is no Cucumber runner. Each automated scenario names the Vitest test
# that covers it, in spikes/issue-1/test/. Scenarios that cannot be automated
# say why and how to check them by hand.

Feature: Raw capture in front of the MCP SDK on a Worker
  The probe owns the HTTP edge: it reads and caps the body, parses it once,
  classifies it with the SDK's own classifyInboundRequest, and records what the
  client declared. The SDK owns the protocol: the probe hands every POST to
  handler.fetch(request, { parsedBody }).

  Background:
    Given the spike Worker wraps createMcpHandler from @modelcontextprotocol/server 2.3.1
    And the probe caps request bodies at 64 KiB (65,536 bytes)

  # Test: test/capture.test.ts > "legacy initialize keeps unknown capability keys in the record only"
  # Also: test/capture.test.ts > "legacy era: stripping is top-level only ..."
  # and "modern era: the SDK keeps unknown capability keys ...".
  Scenario: Legacy initialize with an unknown capability key
    Given a legacy initialize for protocol version "2025-06-18" with clientInfo
    And capabilities that include an unknown key "foo" with the value {}
    When the spike reads the body and calls handler.fetch(request, { parsedBody })
    Then the response is a valid InitializeResult
    And the spike's own record holds "foo" verbatim
    And the SDK instance's client capabilities do not contain "foo"

  # Test: test/capture.test.ts > "modern request naming an unsupported version is answered -32022"
  Scenario: Modern request naming an unsupported protocol version
    Given a modern tools/list whose _meta names protocol version "1999-01-01"
    When it is served
    Then the response status is 400 with JSON-RPC error code -32022
    And the list of supported versions includes "2026-07-28"
    And the spike's record holds "1999-01-01"

  # Test: test/capture.test.ts > "header and _meta version mismatch is answered -32020"
  Scenario: Modern request whose header and _meta versions differ
    Given a modern request whose MCP-Protocol-Version header differs from the version in _meta
    When it is served
    Then the response status is 400 with JSON-RPC error code -32020
    And the spike's record holds both the header version and the _meta version

  # Test: test/body.test.ts > "SDK misreads an already-read body ..." and "probe answers -32700 itself ..."
  Scenario Outline: Body that cannot be parsed after the probe has read it
    Given a POST whose body is <body>
    When the probe reads the body and then hands the request to handler.fetch without parsedBody
    Then the findings record the failure the SDK produces
    And the probe-side alternative of answering -32700 itself without calling the SDK works

    Examples:
      | body                    |
      | the text {"jsonrpc":    |
      | an empty body           |

  # Test: test/body.test.ts > "readRequestBody refuses 64 KiB + 1 ..."
  Scenario Outline: Body one byte over the cap
    Given a body of 65,537 bytes sent <framing>
    When it is read with the SDK's readRequestBody under a 64 KiB cap
    Then it is refused with { tooLarge: true } and nothing is thrown
    And the probe answers 413 itself

    Examples:
      | framing                                   |
      | with a Content-Length header              |
      | chunked, with no Content-Length header    |

  # Test: test/body.test.ts > "readRequestBody accepts exactly 64 KiB ..."
  Scenario: Body exactly at the cap
    Given a body of exactly 65,536 bytes
    When it is read under the same cap
    Then it is accepted

  # Test: test/session.test.ts
  Scenario: Probe-minted session id on the stateless legacy leg
    Given a legacy initialize whose reply carries a probe-minted Mcp-Session-Id
    And a following tools/call that echoes it through the default stateless legacy leg
    When the second request is served
    Then it succeeds and the tool can read the header value
    And no session id is minted when initialize fails, including an in-band JSON-RPC error with HTTP 200

  # Test: test/sse.test.ts
  # The CPU cost is measured locally only (Node, process.cpuUsage). The deployed
  # cost is an owner-run step; see docs/adr/0001-sdk-strategy.md.
  Scenario: Negotiated protocol version from a legacy initialize reply
    Given a legacy initialize on the SDK's default legacy leg
    When the negotiated protocol version is read from the reply
    Then the findings state the CPU cost of parsing the SSE body
    And the findings state whether a cheaper source exists

  # Test: test/edge.test.ts > "legacy POST without both media types in Accept is answered 406"
  Scenario Outline: Legacy POST with an incomplete Accept header
    Given a legacy POST whose Accept header is <accept>
    When it is served
    Then the findings record the status code and body (expected 406)

    Examples:
      | accept             |
      | application/json   |
      | text/event-stream  |
      | */*                |

  # Test: test/edge.test.ts > "OPTIONS preflight reaches the legacy leg and gets 405 ..."
  Scenario: CORS preflight handed to the SDK
    Given an OPTIONS request with Origin "https://example.test" and Access-Control-Request-Method "POST"
    When it is handed to the SDK handler
    Then the findings record the status and headers returned
    And the findings state what the probe must add for browser clients

  # Test: test/classification.test.ts
  Scenario: Classification reasons and rejections outside the classification
    Then the findings list every legacy routing reason string observed
    And the findings state which rejection codes arise outside that classification
    And the findings name the input form that originValidationResponse accepts

  # Not automated: needs a Cloudflare account. Owner-run steps 1 to 4 in
  # docs/adr/0001-sdk-strategy.md give the commands; step 4a reads the Workers
  # metrics through the GraphQL Analytics API, so no request logging is needed.
  # Local timings in the ADR are labelled local and indicative only, and the
  # workerd ones are wall time, not CPU time.
  Scenario: CPU time per invocation on a deployed Worker
    Given a deployed scratch Worker
    When 100 modern tools/call requests and 100 legacy initialize plus tools/call pairs are sent, with and without one D1 insert
    Then the findings record p50 and p95 CPU time for each run
    And the findings record the Free-plan CPU limit read from the Cloudflare limits page, with the link and date
    And the findings say whether the Free plan suffices or which plan is required

  # Not a Vitest test, because each setting needs its own runtime start. The
  # matrix is run by scripts/compat-matrix.sh against `wrangler dev` in local
  # mode. Manual check: run that script and compare its summary with the ADR.
  Scenario: Minimal compatibility flag setting
    Then the findings state the minimal compatibility flag setting that works
    And the setting was tested with no flag and with each candidate flag
    And the findings say plainly whether nodejs_compat_v2 was needed

  # Not automated: documentation review. Manual check: compare each snippet in
  # the ADR with the linked page. spikes/issue-1/wrangler.jsonc carries every
  # snippet and `wrangler dev` parses it without warnings.
  Scenario: Verified Wrangler configuration snippets
    Then the findings include verified snippets for cron triggers, D1 bindings, compatibility_flags, the assets block, the Rate Limiting binding and observability log settings
    And each snippet names the documentation page it was checked against

  # Test: test/d1.test.ts measures rows written locally. The free-plan limit
  # is read from the D1 pricing page.
  Scenario: D1 rows written per request
    Then the findings record D1 rows written per request with three indexes
    And the findings record the free-plan daily write limit
    And the findings state the largest daily cap that fits

  # Not automated: the remote --json shape needs an account (owner-run step).
  # The agents package was read, not executed.
  Scenario: Cloudflare's createMcpHandler and the remote D1 JSON shape
    Then the findings state whether Cloudflare's createMcpHandler is the SDK's function
    And the findings show one line of `wrangler d1 execute --remote --json` output shape

  # Not automated: document review.
  Scenario: The decision record
    Then docs/adr/0001-sdk-strategy.md records the hybrid where the probe owns the HTTP edge and the SDK owns the protocol
    And it records the measured numbers and the alternatives, including the no-storage echo probe and why it loses
