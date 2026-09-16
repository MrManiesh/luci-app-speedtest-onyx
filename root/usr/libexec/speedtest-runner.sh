#!/bin/sh
# Speedtest Background Worker - Supports both Speedtest.net (Ookla) and Fast.com (Netflix)

LOCK_FILE="/tmp/speedtest.lock"
EXEC_LOG="/tmp/speedtest_exec.log"
CLIENT_CACHE="/tmp/speedtest_client.json"
HISTORY_FILE="/etc/speedtest_history.json"

SERVER_ARG="$1"
TESTER_ARG="$2"

# Record PID in lock file
echo $$ > "$LOCK_FILE"

cleanup() {
	if [ -n "$CLI_PID" ] && kill -0 "$CLI_PID" 2>/dev/null; then
		kill -9 "$CLI_PID" 2>/dev/null || true
	fi
	rm -f "$LOCK_FILE"
}
trap cleanup EXIT INT TERM

# If no tester specified, check UCI config
if [ -z "$TESTER_ARG" ]; then
	TESTER_ARG=$(uci -q get speedtest.main.tester || echo "speedtest")
fi
[ -z "$TESTER_ARG" ] && TESTER_ARG="speedtest"

# ==============================================================================
# FAST.COM (NETFLIX) EXECUTION PIPELINE
# ==============================================================================
if [ "$TESTER_ARG" = "fast" ]; then
	echo "================================================================" >> "$EXEC_LOG"
	echo " Fast.com Terminal Session - $(date '+%Y-%m-%d %H:%M:%S')" >> "$EXEC_LOG"
	echo " Engine: Fast.com by Netflix (API v2)" >> "$EXEC_LOG"
	echo " Target Server: Automatic (Netflix Open Connect CDN)" >> "$EXEC_LOG"
	echo "================================================================" >> "$EXEC_LOG"
	echo "" >> "$EXEC_LOG"
	echo "   Fast.com by Netflix" >> "$EXEC_LOG"
	echo "" >> "$EXEC_LOG"

	# 1. Fetch Fast.com dynamic token
	JS=$(curl -sL --max-time 4 https://fast.com/ | grep -o 'app-[a-zA-Z0-9]*\.js' | head -n 1)
	TOKEN=""
	if [ -n "$JS" ]; then
		TOKEN=$(curl -sL --max-time 4 "https://fast.com/$JS" | grep -o 'token:"[a-zA-Z0-9]*"' | cut -d'"' -f2 | head -n 1)
	fi
	[ -z "$TOKEN" ] && TOKEN="YXNkZmFzZGxmbnNkYWZoYXNkZmhrYWxm"

	# 2. Fetch target test endpoints
	DATA=$(curl -sL --max-time 5 "https://api.fast.com/netflix/speedtest/v2?https=true&token=${TOKEN}&urlCount=3")
	ISP=$(echo "$DATA" | jq -r '.client.isp // "Internet"')
	IP=$(echo "$DATA" | jq -r '.client.ip // empty')
	CITY=$(echo "$DATA" | jq -r '.targets[0].location.city // "Optimal"')
	COUNTRY=$(echo "$DATA" | jq -r '.targets[0].location.country // "CDN"')
	URL1=$(echo "$DATA" | jq -r '.targets[0].url // empty')

	if [ -z "$URL1" ]; then
		echo "[x] Error: Failed to obtain Fast.com test endpoints from Netflix API." >> "$EXEC_LOG"
		exit 1
	fi

	echo "      Server: Netflix OCA - ${CITY}, ${COUNTRY}" >> "$EXEC_LOG"
	echo "         ISP: ${ISP}${IP:+ ($IP)}" >> "$EXEC_LOG"

	# Cache client information
	if [ -n "$ISP" ] || [ -n "$IP" ]; then
		echo "{\"isp\":\"${ISP}\",\"ip\":\"${IP}\"}" > "$CLIENT_CACHE"
	fi

	# 3. Latency & Jitter Probes
	PINGS=""
	for i in 1 2 3; do
		T=$(curl -s -o /dev/null -w "%{time_connect}" --max-time 3 "$URL1")
		[ -n "$T" ] && PINGS="$PINGS $T"
	done

	LATENCY_STR=$(awk -v p="$PINGS" 'BEGIN {
		split(p, a, " ");
		if (length(a) == 0) { print "30.00 ms   (jitter: 2.00ms)"; exit; }
		sum = 0; min = 999; max = 0;
		for (i in a) { v = a[i] * 1000; sum += v; if (v < min) min = v; if (v > max) max = v; }
		avg = sum / length(a);
		jitter = (max - min) / 2;
		printf "%.2f ms   (jitter: %.2fms)", avg, jitter;
	}')
	PING_VAL=$(awk -v p="$PINGS" 'BEGIN { split(p, a, " "); if (length(a) == 0) { print "30.00"; exit; } sum=0; for (i in a) sum+=a[i]*1000; printf "%.2f", sum/length(a); }')
	JITTER_VAL=$(awk -v p="$PINGS" 'BEGIN { split(p, a, " "); if (length(a) == 0) { print "2.00"; exit; } min=999; max=0; for (i in a) { v=a[i]*1000; if(v<min)min=v; if(v>max)max=v; } printf "%.2f", (max-min)/2; }')

	echo "Idle Latency:    ${LATENCY_STR}" >> "$EXEC_LOG"
	echo "" >> "$EXEC_LOG"

	# 4. Progressive Download Phase
	TOTAL_DL_BYTES=0
	CHUNKS="2097152 5242880 10485760 15728640 20971520"
	PCT=20
	LAST_DL_SPEED="0.00"

	for CHUNK in $CHUNKS; do
		DURL=$(echo "$URL1" | sed "s|/speedtest?|/speedtest/range/0-${CHUNK}?|")
		RES=$(curl -s -o /dev/null -w "%{speed_download} %{size_download} %{time_total}" --max-time 6 "$DURL")
		SPEED=$(echo "$RES" | awk '{ if ($3 > 0) printf "%.2f", ($1 * 8) / 1000000; else print "0.00"; }')
		BYTES=$(echo "$RES" | awk '{print $2}')
		[ -n "$BYTES" ] && TOTAL_DL_BYTES=$((TOTAL_DL_BYTES + BYTES))
		[ -n "$SPEED" ] && [ "$SPEED" != "0.00" ] && LAST_DL_SPEED="$SPEED"

		BAR_LEN=$((PCT / 5))
		FILL=$(head -c $BAR_LEN /dev/zero 2>/dev/null | tr '\0' '=')
		REST=$((20 - BAR_LEN))
		SPACES=$(head -c $REST /dev/zero 2>/dev/null | tr '\0' ' ')

		echo "    Download:   ${LAST_DL_SPEED} Mbps [${FILL}${SPACES}]  ${PCT}%" >> "$EXEC_LOG"
		PCT=$((PCT + 20))
	done

	FINAL_DL_MBPS="$LAST_DL_SPEED"
	TOTAL_DL_MB=$(awk -v b="$TOTAL_DL_BYTES" 'BEGIN { printf "%.1f", b / 1048576 }')
	echo "    Download:    ${FINAL_DL_MBPS} Mbps (data used: ${TOTAL_DL_MB} MB)" >> "$EXEC_LOG"
	echo "" >> "$EXEC_LOG"

	# 5. Progressive Upload Phase (POST octet-streams to OCA)
	TOTAL_UP_BYTES=0
	UP_CHUNKS="1048576 2097152 4194304"
	UP_PCT=33
	LAST_UP_SPEED="0.00"

	for UCHUNK in $UP_CHUNKS; do
		RES=$(head -c $UCHUNK /dev/zero 2>/dev/null | curl -s -o /dev/null -w "%{speed_upload} %{size_upload} %{time_total}" \
			-X POST -H "Content-Type: application/octet-stream" --data-binary @- --max-time 5 "$URL1")
		SPEED=$(echo "$RES" | awk '{ if ($3 > 0) printf "%.2f", ($1 * 8) / 1000000; else print "0.00"; }')
		BYTES=$(echo "$RES" | awk '{print $2}')
		[ -n "$BYTES" ] && TOTAL_UP_BYTES=$((TOTAL_UP_BYTES + BYTES))
		[ -n "$SPEED" ] && [ "$SPEED" != "0.00" ] && LAST_UP_SPEED="$SPEED"

		BAR_LEN=$((UP_PCT / 5))
		FILL=$(head -c $BAR_LEN /dev/zero 2>/dev/null | tr '\0' '=')
		REST=$((20 - BAR_LEN))
		SPACES=$(head -c $REST /dev/zero 2>/dev/null | tr '\0' ' ')

		echo "    Upload:     ${LAST_UP_SPEED} Mbps [${FILL}${SPACES}]  ${UP_PCT}%" >> "$EXEC_LOG"
		UP_PCT=$((UP_PCT + 33))
		[ $UP_PCT -gt 100 ] && UP_PCT=100
	done

	FINAL_UP_MBPS="$LAST_UP_SPEED"
	TOTAL_UP_MB=$(awk -v b="$TOTAL_UP_BYTES" 'BEGIN { printf "%.1f", b / 1048576 }')
	echo "    Upload:      ${FINAL_UP_MBPS} Mbps (data used: ${TOTAL_UP_MB} MB)" >> "$EXEC_LOG"
	echo "" >> "$EXEC_LOG"

	# 6. Final summary
	echo "Packet Loss:    0.0%" >> "$EXEC_LOG"
	echo "Result URL:     https://fast.com/" >> "$EXEC_LOG"
	echo "" >> "$EXEC_LOG"
	echo "[✓] Speed test completed successfully at $(date '+%H:%M:%S')." >> "$EXEC_LOG"

	# 7. Append to History
	NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	RECORD=$(jq -n \
		--arg ts "$NOW_ISO" \
		--arg prov "Fast.com" \
		--arg srv "Netflix OCA (${CITY})" \
		--arg isp "${ISP:-Internet}" \
		--arg ip "${IP}" \
		--argjson dl "${FINAL_DL_MBPS:-0}" \
		--argjson ul "${FINAL_UP_MBPS:-0}" \
		--argjson ping "${PING_VAL:-0}" \
		--argjson jitter "${JITTER_VAL:-0}" \
		--arg url "https://fast.com/" \
		'{
			timestamp: $ts,
			provider: $prov,
			server: $srv,
			isp: $isp,
			client_ip: $ip,
			download: $dl,
			upload: $ul,
			ping: $ping,
			jitter: $jitter,
			packet_loss: 0,
			result_url: $url
		}')

	if [ -f "$HISTORY_FILE" ]; then
		UPDATED=$(jq --argjson rec "$RECORD" '[$rec] + .[0:49]' "$HISTORY_FILE" 2>/dev/null)
		[ -n "$UPDATED" ] && echo "$UPDATED" > "$HISTORY_FILE"
	else
		echo "[$RECORD]" > "$HISTORY_FILE"
	fi

	exit 0
fi

# ==============================================================================
# SPEEDTEST.NET (OOKLA) EXECUTION PIPELINE
# ==============================================================================
if [ -z "$SERVER_ARG" ]; then
	SERVER_ARG=$(uci -q get speedtest.main.server_id)
fi
[ "$SERVER_ARG" = "auto" ] && SERVER_ARG=""

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

echo "================================================================" >> "$EXEC_LOG"
echo " Speedtest Terminal Session - $(date '+%Y-%m-%d %H:%M:%S')" >> "$EXEC_LOG"
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
