#!/bin/sh
# Starts `wrangler dev --local` once per compatibility setting and checks that a
# modern tools/call and a legacy initialize are both served. Local mode only.
# Usage: sh scripts/compat-matrix.sh   (run from spikes/issue-1)
set -u

export WRANGLER_SEND_METRICS=false
PORT=8791
LOG_DIR=".tmp/compat-matrix"
mkdir -p "$LOG_DIR"

MODERN_BODY='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"spike_echo","arguments":{},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
LEGACY_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"matrix","version":"0"}}}'

run_case() {
	label="$1"
	date="$2"
	flags="$3"
	log="$LOG_DIR/$label.log"
	set -- --local --port "$PORT" --ip 127.0.0.1 --show-interactive-dev-session=false --compatibility-date "$date"
	if [ -n "$flags" ]; then
		# Word splitting is intended: one --compatibility-flags per flag.
		for flag in $flags; do set -- "$@" --compatibility-flags "$flag"; done
	fi
	npx wrangler dev "$@" >"$log" 2>&1 &
	pid=$!
	ready=no
	for _ in $(seq 1 40); do
		if grep -q "Ready on" "$log" 2>/dev/null; then ready=yes; break; fi
		if ! kill -0 "$pid" 2>/dev/null; then break; fi
		sleep 0.5
	done
	modern="-"
	legacy="-"
	runtime="-"
	if [ "$ready" = yes ]; then
		modern=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/mcp" \
			-H "content-type: application/json" -H "accept: application/json, text/event-stream" \
			-H "mcp-protocol-version: 2026-07-28" -H "mcp-method: tools/call" -H "mcp-name: spike_echo" \
			--data "$MODERN_BODY")
		legacy=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/mcp" \
			-H "content-type: application/json" -H "accept: application/json, text/event-stream" \
			--data "$LEGACY_BODY")
		runtime=$(curl -s "http://127.0.0.1:$PORT/__runtime")
	fi
	kill "$pid" 2>/dev/null
	wait "$pid" 2>/dev/null
	errors=$(grep -ciE "error|✘" "$log")
	printf '%-34s date=%s flags=[%s] ready=%s modern=%s legacy=%s runtime=%s error_lines=%s\n' "$label" "$date" "$flags" "$ready" "$modern" "$legacy" "$runtime" "$errors"
}

run_case "current-date-no-flags" "2026-11-10" ""
run_case "current-date-node-compat-off" "2026-11-10" "no_nodejs_compat no_nodejs_compat_v2"
run_case "current-date-nodejs_compat" "2026-11-10" "nodejs_compat"
run_case "pre-default-date-no-flags" "2026-08-03" ""
run_case "pre-default-date-nodejs_compat" "2026-08-03" "nodejs_compat"
run_case "pre-default-date-nodejs_compat_v2" "2026-08-03" "nodejs_compat_v2"
