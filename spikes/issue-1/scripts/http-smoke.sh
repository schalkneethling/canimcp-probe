#!/bin/sh
# Sends the spike's edge-case requests over real HTTP to a running Worker and
# prints status, selected headers and body for each.
# Usage: sh scripts/http-smoke.sh [base-url]   (default http://127.0.0.1:8787)
set -eu

BASE="${1:-http://127.0.0.1:8787}"
ACCEPT="application/json, text/event-stream"
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"foo":{}},"clientInfo":{"name":"smoke","version":"0"}}}'

show() {
	printf '\n== %s\n' "$1"
}

big_body() {
	# Prints $1 bytes of "x".
	head -c "$1" /dev/zero | tr '\0' 'x'
}

show "GET / (static assets landing page)"
curl -s -o /dev/null -w 'status=%{http_code} content-type=%{content_type}\n' "$BASE/"

show "legacy initialize on /mcp"
curl -s -i -X POST "$BASE/mcp" -H "content-type: application/json" -H "accept: $ACCEPT" --data "$INIT" | tr -d '\r' | grep -iE '^(HTTP|content-type|mcp-session-id)|^data:'

show "legacy initialize on /mcp-d1 (one D1 insert)"
curl -s -o /dev/null -w 'status=%{http_code}\n' -X POST "$BASE/mcp-d1" -H "content-type: application/json" -H "accept: $ACCEPT" --data "$INIT"

for size in 65536 65537; do
	show "body of $size bytes with Content-Length"
	big_body "$size" | curl -s -w '\nstatus=%{http_code}\n' -X POST "$BASE/mcp" -H "content-type: application/json" -H "accept: $ACCEPT" --data-binary @-
	show "body of $size bytes chunked, no Content-Length"
	big_body "$size" | curl -s -w '\nstatus=%{http_code}\n' -X POST "$BASE/mcp" -H "content-type: application/json" -H "accept: $ACCEPT" -H "transfer-encoding: chunked" --data-binary @-
done

show "truncated JSON"
curl -s -w '\nstatus=%{http_code}\n' -X POST "$BASE/mcp" -H "content-type: application/json" -H "accept: $ACCEPT" --data '{"jsonrpc":'

show "empty body"
curl -s -w '\nstatus=%{http_code}\n' -X POST "$BASE/mcp" -H "content-type: application/json" -H "accept: $ACCEPT" --data ''

for accept in "application/json" "text/event-stream"; do
	show "legacy initialize with Accept: $accept"
	curl -s -w '\nstatus=%{http_code}\n' -X POST "$BASE/mcp" -H "content-type: application/json" -H "accept: $accept" --data "$INIT"
done

show "OPTIONS preflight with Origin"
curl -s -i -X OPTIONS "$BASE/mcp" -H "origin: https://example.test" -H "access-control-request-method: POST" | tr -d '\r'

show "OPTIONS without Origin"
curl -s -o /dev/null -w 'status=%{http_code}\n' -X OPTIONS "$BASE/mcp"

show "scheduled handler (local dev only)"
curl -s -w '\nstatus=%{http_code}\n' "$BASE/cdn-cgi/local/scheduled" || true
