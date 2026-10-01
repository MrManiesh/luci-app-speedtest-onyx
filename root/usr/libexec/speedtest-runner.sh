#!/bin/sh
# Speedtest Background Worker - Streams real-time terminal output to /tmp/speedtest_exec.log

LOCK_FILE="/tmp/speedtest.lock"
EXEC_LOG="/tmp/speedtest_exec.log"
CLIENT_CACHE="/tmp/speedtest_client.json"
HISTORY_FILE="/etc/speedtest_history.json"

SERVER_ARG="$1"

# Record PID in lock file
echo $$ > "$LOCK_FILE"

cleanup() {
	if [ -n "$CLI_PID" ] && kill -0 "$CLI_PID" 2>/dev/null; then
		kill -9 "$CLI_PID" 2>/dev/null || true
	fi
	rm -f "$LOCK_FILE"
}
trap cleanup EXIT INT TERM

if [ -z "$SERVER_ARG" ]; then
	SERVER_ARG=$(uci -q get speedtest.main.server_id)
fi
[ "$SERVER_ARG" = "auto" ] && SERVER_ARG=""

# Identify speedtest engine (prefer official Ookla speedtest)
SPEEDTEST_BIN=""
if [ -x /usr/bin/speedtest ]; then
	SPEEDTEST_BIN="/usr/bin/speedtest"
elif command -v speedtest >/dev/null 2>&1; then
	SPEEDTEST_BIN=$(command -v speedtest)
elif [ -x /usr/bin/speedtest-go ]; then
	SPEEDTEST_BIN="/usr/bin/speedtest-go"
elif command -v speedtest-go >/dev/null 2>&1; then
	SPEEDTEST_BIN=$(command -v speedtest-go)
fi

if [ -z "$SPEEDTEST_BIN" ] || [ ! -x "$SPEEDTEST_BIN" ]; then
	echo "[Error] Speedtest binary not found. Please install speedtest-go using:" >> "$EXEC_LOG"
	echo "        apk add speedtest-go" >> "$EXEC_LOG"
	exit 1
fi

IS_OOKLA=0
if "$SPEEDTEST_BIN" --version 2>&1 | grep -iq "Speedtest by Ookla"; then
	IS_OOKLA=1
fi

# Print session banner
echo "================================================================" >> "$EXEC_LOG"
echo " Speedtest Terminal Session - $(date '+%Y-%m-%d %H:%M:%S')" >> "$EXEC_LOG"
echo " Engine: $($SPEEDTEST_BIN --version 2>&1 | head -n 1)" >> "$EXEC_LOG"
[ -n "$SERVER_ARG" ] && echo " Target Server ID: $SERVER_ARG" >> "$EXEC_LOG"
[ -z "$SERVER_ARG" ] && echo " Target Server: Automatic (Nearest / Optimal)" >> "$EXEC_LOG"
echo "================================================================" >> "$EXEC_LOG"
echo "" >> "$EXEC_LOG"

# Build command line
if [ "$IS_OOKLA" = "1" ]; then
	CMD="$SPEEDTEST_BIN --accept-license --accept-gdpr -p yes"
	[ -n "$SERVER_ARG" ] && CMD="$CMD -s $SERVER_ARG"
else
	CMD="$SPEEDTEST_BIN"
	[ -n "$SERVER_ARG" ] && CMD="$CMD -s $SERVER_ARG"
fi

# Execute speedtest streaming directly to EXEC_LOG
$CMD >> "$EXEC_LOG" 2>&1 &
CLI_PID=$!

# Wait for process to complete
wait "$CLI_PID"
RC=$?

echo "" >> "$EXEC_LOG"
if [ $RC -eq 0 ]; then
	echo "[✓] Speed test completed successfully at $(date '+%H:%M:%S')." >> "$EXEC_LOG"

	# Cache client ISP / IP if detected in output
	RAW_ISP=$(grep -i 'ISP:' "$EXEC_LOG" | head -n 1 | sed -n 's/.*(\([^)]*\)).*/\1/p')
	RAW_IP=$(grep -i 'ISP:' "$EXEC_LOG" | head -n 1 | sed -nE 's/.*([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|[0-9a-fA-F:]+:[0-9a-fA-F:]+).*/\1/p')
	if [ -n "$RAW_ISP" ] || [ -n "$RAW_IP" ]; then
		echo "{\"isp\":\"${RAW_ISP:-Internet}\",\"ip\":\"$RAW_IP\"}" > "$CLIENT_CACHE"
	fi

	# Extract benchmark metrics for persistent history
	RAW_SERVER=$(grep -i 'Server:' "$EXEC_LOG" | head -n 1 | sed -e 's/.*Server: *//' -e 's/[[:space:]]*(id:.*//' -e 's/[[:space:]]*(id =.*//')
	PING_VAL=$(grep -iE '(Idle Latency|Ping):' "$EXEC_LOG" | head -n 1 | sed -nE 's/.*(Idle Latency|Ping): *([0-9.]+).*/\2/p')
	JITTER_VAL=$(grep -iE '(Idle Latency|Ping):' "$EXEC_LOG" | head -n 1 | sed -nE 's/.*jitter: *([0-9.]+).*/\1/p')
	DL_VAL=$(grep -i 'Download:' "$EXEC_LOG" | tail -n 1 | sed -nE 's/.*Download: *([0-9.]+).*/\1/p')
	UL_VAL=$(grep -i 'Upload:' "$EXEC_LOG" | tail -n 1 | sed -nE 's/.*Upload: *([0-9.]+).*/\1/p')
	LOSS_VAL=$(grep -i 'Packet Loss:' "$EXEC_LOG" | head -n 1 | sed -nE 's/.*Packet Loss: *([0-9.]+).*/\1/p')
	RESULT_URL=$(grep -i 'Result URL:' "$EXEC_LOG" | head -n 1 | sed -nE 's/.*Result URL: *([^ ]+).*/\1/p')

	# Record entry in history file (trimmed to history_max)
	if command -v jq >/dev/null 2>&1; then
		HISTORY_MAX=$(uci -q get speedtest.main.history_max || echo 50)
		[ -z "$HISTORY_MAX" ] && HISTORY_MAX=50

		NEW_ENTRY=$(jq -n \
			--arg ts "$(date '+%Y-%m-%d %H:%M:%S')" \
			--arg server "${RAW_SERVER:-Auto Server}" \
			--arg isp "${RAW_ISP:-Internet}" \
			--arg ip "${RAW_IP:-}" \
			--arg ping "${PING_VAL:-0}" \
			--arg jitter "${JITTER_VAL:-0}" \
			--arg dl "${DL_VAL:-0}" \
			--arg ul "${UL_VAL:-0}" \
			--arg loss "${LOSS_VAL:-0}" \
			--arg url "${RESULT_URL:-}" \
			'{
				timestamp: $ts,
				server: $server,
				isp: $isp,
				client_ip: $ip,
				ping: ($ping | tonumber? // 0),
				jitter: ($jitter | tonumber? // 0),
				download: ($dl | tonumber? // 0),
				upload: ($ul | tonumber? // 0),
				packet_loss: ($loss | tonumber? // 0),
				result_url: $url
			}')

		[ ! -f "$HISTORY_FILE" ] && echo "[]" > "$HISTORY_FILE"
		UPDATED=$(jq --argjson entry "$NEW_ENTRY" --argjson max "$HISTORY_MAX" '[$entry] + . | .[0:$max]' "$HISTORY_FILE" 2>/dev/null)
		if [ -n "$UPDATED" ] && [ "$UPDATED" != "null" ]; then
			echo "$UPDATED" > "$HISTORY_FILE"
			chmod 0666 "$HISTORY_FILE" 2>/dev/null || true
		fi
	fi
else
	echo "[x] Speed test exited with status $RC at $(date '+%H:%M:%S')." >> "$EXEC_LOG"
fi

exit $RC
