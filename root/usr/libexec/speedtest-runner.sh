#!/bin/sh
# Speedtest Background Worker - Supports both Router (local) and 5G ODU (remote telnet)

LOCK_FILE="/tmp/speedtest.lock"
EXEC_LOG="/tmp/speedtest_exec.log"
CLIENT_CACHE="/tmp/speedtest_client.json"
HISTORY_FILE="/etc/speedtest_history.json"

SERVER_ARG="$1"
TARGET_ARG="$2"

# Record PID in lock file
echo $$ > "$LOCK_FILE"

cleanup() {
	if [ -n "$CLI_PID" ] && kill -0 "$CLI_PID" 2>/dev/null; then
		kill -9 "$CLI_PID" 2>/dev/null || true
	fi
	killall -9 telnet 2>/dev/null || true
	rm -f "$LOCK_FILE"
}
trap cleanup EXIT INT TERM

# If no target specified, check UCI config
if [ -z "$TARGET_ARG" ]; then
	TARGET_ARG=$(uci -q get speedtest.main.target || echo "router")
fi
[ -z "$TARGET_ARG" ] && TARGET_ARG="router"

if [ -z "$SERVER_ARG" ]; then
	SERVER_ARG=$(uci -q get speedtest.main.server_id)
fi
[ "$SERVER_ARG" = "auto" ] && SERVER_ARG=""

# ==============================================================================
# ODU (5G OUTDOOR UNIT) TELNET EXECUTION PIPELINE
# ==============================================================================
if [ "$TARGET_ARG" = "odu" ]; then
	ODU_HOST=$(uci -q get speedtest.main.odu_host || echo "192.168.225.1")
	ODU_PORT=$(uci -q get speedtest.main.odu_port || echo "23")
	ODU_PASS=$(uci -q get speedtest.main.odu_pass || echo "Manu@625")

	echo "================================================================" >> "$EXEC_LOG"
	echo " Speedtest Terminal Session (5G ODU) - $(date '+%Y-%m-%d %H:%M:%S')" >> "$EXEC_LOG"
	echo " Host: Sercomm 5G Outdoor Unit (${ODU_HOST}:${ODU_PORT})" >> "$EXEC_LOG"
	echo " Engine: Ookla Speedtest CLI (armhf / in-memory /tmp)" >> "$EXEC_LOG"
	[ -n "$SERVER_ARG" ] && echo " Target Server ID: $SERVER_ARG" >> "$EXEC_LOG"
	[ -z "$SERVER_ARG" ] && echo " Target Server: Automatic (Nearest / Optimal)" >> "$EXEC_LOG"
	echo "================================================================" >> "$EXEC_LOG"
	echo "" >> "$EXEC_LOG"

	SERVER_FLAG=""
	[ -n "$SERVER_ARG" ] && SERVER_FLAG="-s $SERVER_ARG"

	# Connect via Telnet and execute speedtest in /tmp RAM
	(
		sleep 1
		printf '%s\r\n' "$ODU_PASS"
		sleep 1
		printf 'export HOME=/tmp\r\n'
		printf 'cd /tmp\r\n'
		# Download binary to RAM if not already cached
		printf 'if [ ! -x /tmp/speedtest ]; then wget --no-check-certificate -qO- https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-armhf.tgz 2>/dev/null | tar -xz; chmod +x /tmp/speedtest 2>/dev/null; fi\r\n'
		sleep 1
		printf 'HOME=/tmp /tmp/speedtest --accept-license --accept-gdpr -p yes %s; exit\r\n' "$SERVER_FLAG"
		# Keep stdin open until telnet process exits
		while killall -0 telnet 2>/dev/null; do
			sleep 1
		done
	) | telnet "$ODU_HOST" "$ODU_PORT" >> "$EXEC_LOG" 2>&1 &
	CLI_PID=$!

	wait "$CLI_PID"
	RC=$?

	echo "" >> "$EXEC_LOG"
	if grep -iq "Result URL:" "$EXEC_LOG" 2>/dev/null; then
		echo "[✓] Speed test completed successfully at $(date '+%H:%M:%S')." >> "$EXEC_LOG"

		RAW_ISP=$(grep -i 'ISP:' "$EXEC_LOG" | head -n 1 | sed -n 's/.*(\([^)]*\)).*/\1/p')
		RAW_IP=$(grep -i 'ISP:' "$EXEC_LOG" | head -n 1 | sed -n 's/.*ISP: *\([0-9a-fA-F.:]*\) .*/\1/p')
		if [ -n "$RAW_ISP" ] || [ -n "$RAW_IP" ]; then
			echo "{\"isp\":\"${RAW_ISP:-Jio 5G ODU}\",\"ip\":\"$RAW_IP\"}" > "$CLIENT_CACHE"
		fi
	else
		echo "[x] Speed test on ODU finished with status $RC at $(date '+%H:%M:%S')." >> "$EXEC_LOG"
	fi

	exit $RC
fi

# ==============================================================================
# ROUTER (LOCAL OPENWRT) EXECUTION PIPELINE
# ==============================================================================
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
	echo "[Error] Speedtest binary not found on router. Please install speedtest-go using:" >> "$EXEC_LOG"
	echo "        apk add speedtest-go" >> "$EXEC_LOG"
	exit 1
fi

IS_OOKLA=0
if "$SPEEDTEST_BIN" --version 2>&1 | grep -iq "Speedtest by Ookla"; then
	IS_OOKLA=1
fi

echo "================================================================" >> "$EXEC_LOG"
echo " Speedtest Terminal Session (Router) - $(date '+%Y-%m-%d %H:%M:%S')" >> "$EXEC_LOG"
echo " Engine: $($SPEEDTEST_BIN --version 2>&1 | head -n 1)" >> "$EXEC_LOG"
[ -n "$SERVER_ARG" ] && echo " Target Server ID: $SERVER_ARG" >> "$EXEC_LOG"
[ -z "$SERVER_ARG" ] && echo " Target Server: Automatic (Nearest / Optimal)" >> "$EXEC_LOG"
echo "================================================================" >> "$EXEC_LOG"
echo "" >> "$EXEC_LOG"

if [ "$IS_OOKLA" = "1" ]; then
	CMD="$SPEEDTEST_BIN --accept-license --accept-gdpr -p yes"
	[ -n "$SERVER_ARG" ] && CMD="$CMD -s $SERVER_ARG"
else
	CMD="$SPEEDTEST_BIN"
	[ -n "$SERVER_ARG" ] && CMD="$CMD -s $SERVER_ARG"
fi

$CMD >> "$EXEC_LOG" 2>&1 &
CLI_PID=$!

wait "$CLI_PID"
RC=$?

echo "" >> "$EXEC_LOG"
if [ $RC -eq 0 ]; then
	echo "[✓] Speed test completed successfully at $(date '+%H:%M:%S')." >> "$EXEC_LOG"

	RAW_ISP=$(grep -i 'ISP:' "$EXEC_LOG" | head -n 1 | sed -n 's/.*(\([^)]*\)).*/\1/p')
	RAW_IP=$(grep -i 'ISP:' "$EXEC_LOG" | head -n 1 | sed -n 's/.*ISP: *\([0-9a-fA-F.:]*\) .*/\1/p')
	if [ -n "$RAW_ISP" ] || [ -n "$RAW_IP" ]; then
		echo "{\"isp\":\"${RAW_ISP:-Internet}\",\"ip\":\"$RAW_IP\"}" > "$CLIENT_CACHE"
	fi
else
	echo "[x] Speed test exited with status $RC at $(date '+%H:%M:%S')." >> "$EXEC_LOG"
fi

exit $RC
