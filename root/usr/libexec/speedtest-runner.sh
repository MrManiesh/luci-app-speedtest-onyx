#!/bin/sh
# Speedtest Background Worker - Local OpenWrt Execution Engine

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

detect_pkg_mgr() {
	if command -v apk >/dev/null 2>&1; then
		echo "apk"
	elif command -v opkg >/dev/null 2>&1; then
		echo "opkg"
	else
		echo ""
	fi
}

download_file() {
	_url="$1"
	_dest="$2"
	rm -f "$_dest"
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL -k --connect-timeout 15 --max-time 120 -o "$_dest" "$_url" 2>&1
		return $?
	elif command -v uclient-fetch >/dev/null 2>&1; then
		uclient-fetch --no-check-certificate -O "$_dest" "$_url" 2>&1
		return $?
	elif command -v wget >/dev/null 2>&1; then
		wget --no-check-certificate -q -O "$_dest" "$_url" 2>&1
		return $?
	fi
	return 1
}

find_speedtest() {
	for p in /usr/bin/speedtest /usr/bin/speedtest-go /usr/local/bin/speedtest /usr/local/bin/speedtest-go; do
		if [ -f "$p" ]; then
			[ ! -x "$p" ] && chmod 0755 "$p" 2>/dev/null || true
			if [ -x "$p" ]; then
				if "$p" --version >/dev/null 2>&1 || "$p" -v >/dev/null 2>&1; then
					echo "$p"
					return 0
				fi
			fi
		fi
	done
	if command -v speedtest >/dev/null 2>&1; then
		if speedtest --version >/dev/null 2>&1; then
			echo "$(command -v speedtest)"
			return 0
		fi
	fi
	if command -v speedtest-go >/dev/null 2>&1; then
		if speedtest-go -v >/dev/null 2>&1; then
			echo "$(command -v speedtest-go)"
			return 0
		fi
	fi
	echo ""
}

install_speedtest_engine() {
	_log="$1"
	[ -z "$_log" ] && _log="$EXEC_LOG"

	echo "================================================================" >> "$_log"
	echo " Speedtest Engine Auto-Provisioning" >> "$_log"
	
	ARCH=$(uname -m 2>/dev/null || echo "unknown")
	echo " [*] Detected Hardware Architecture: $ARCH" >> "$_log"

	OOKLA_URL=""
	FALLBACK_URL=""

	case "$ARCH" in
		x86_64|amd64)
			OOKLA_URL="https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-x86_64.tgz"
			;;
		i386|i486|i586|i686|x86)
			OOKLA_URL="https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-i386.tgz"
			;;
		aarch64*|arm64*|armv8*)
			OOKLA_URL="https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-aarch64.tgz"
			;;
		armv7*|armv6*|armhf)
			OOKLA_URL="https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-armhf.tgz"
			FALLBACK_URL="https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-armel.tgz"
			;;
		arm*|armel)
			OOKLA_URL="https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-armel.tgz"
			;;
	esac

	# Step 1: If architecture is supported by Ookla CLI, download and extract
	if [ -n "$OOKLA_URL" ]; then
		echo " [*] Downloading official Ookla Speedtest CLI ($ARCH)..." >> "$_log"
		echo "     Source: $OOKLA_URL" >> "$_log"
		TMP_TGZ="/tmp/ookla-speedtest.tgz"
		if download_file "$OOKLA_URL" "$TMP_TGZ"; then
			echo " [*] Extracting binary to /usr/bin/speedtest..." >> "$_log"
			tar -xzf "$TMP_TGZ" -C /tmp/ speedtest 2>/dev/null || tar -xzf "$TMP_TGZ" -C /tmp/ 2>/dev/null
			rm -f "$TMP_TGZ" /tmp/speedtest.md /tmp/speedtest.5 2>/dev/null

			if [ -f /tmp/speedtest ]; then
				mv -f /tmp/speedtest /usr/bin/speedtest
				chmod 0755 /usr/bin/speedtest
				
				if /usr/bin/speedtest --version >/dev/null 2>&1; then
					VER=$(/usr/bin/speedtest --version 2>&1 | head -n 1)
					echo " [✓] Official Ookla Speedtest CLI installed successfully!" >> "$_log"
					echo "     Version: $VER" >> "$_log"
					echo "================================================================" >> "$_log"
					echo "" >> "$_log"
					return 0
				elif [ -n "$FALLBACK_URL" ]; then
					echo " [!] Primary ARM binary incompatible, attempting ARMEL fallback..." >> "$_log"
					rm -f /usr/bin/speedtest
					if download_file "$FALLBACK_URL" "$TMP_TGZ"; then
						tar -xzf "$TMP_TGZ" -C /tmp/ speedtest 2>/dev/null || tar -xzf "$TMP_TGZ" -C /tmp/ 2>/dev/null
						rm -f "$TMP_TGZ" /tmp/speedtest.md /tmp/speedtest.5 2>/dev/null
						if [ -f /tmp/speedtest ]; then
							mv -f /tmp/speedtest /usr/bin/speedtest
							chmod 0755 /usr/bin/speedtest
							if /usr/bin/speedtest --version >/dev/null 2>&1; then
								VER=$(/usr/bin/speedtest --version 2>&1 | head -n 1)
								echo " [✓] Official Ookla Speedtest CLI installed successfully!" >> "$_log"
								echo "     Version: $VER" >> "$_log"
								echo "================================================================" >> "$_log"
								echo "" >> "$_log"
								return 0
							fi
						fi
					fi
				fi
			fi
		fi
		echo " [!] Ookla CLI setup failed. Falling back to speedtest-go..." >> "$_log"
	fi

	# Step 2: Fallback to speedtest-go (package manager or prebuilt binary)
	echo " [*] Attempting to install speedtest-go engine..." >> "$_log"
	PKG_MGR=$(detect_pkg_mgr)
	if [ "$PKG_MGR" = "apk" ]; then
		echo " [*] Running: apk update && apk add speedtest-go" >> "$_log"
		apk update >> "$_log" 2>&1 || true
		apk add speedtest-go >> "$_log" 2>&1 || true
	elif [ "$PKG_MGR" = "opkg" ]; then
		echo " [*] Running: opkg update && opkg install speedtest-go" >> "$_log"
		opkg update >> "$_log" 2>&1 || true
		opkg install speedtest-go >> "$_log" 2>&1 || true
	fi

	BIN=$(find_speedtest)
	if [ -n "$BIN" ]; then
		VER=$("$BIN" --version 2>&1 | head -n 1)
		[ -z "$VER" ] && VER=$("$BIN" -v 2>&1 | head -n 1)
		echo " [✓] Speedtest engine installed successfully via $PKG_MGR ($BIN)!" >> "$_log"
		echo "     Version: $VER" >> "$_log"
		echo "================================================================" >> "$_log"
		echo "" >> "$_log"
		return 0
	fi

	# Step 3: Precompiled speedtest-go binary for MIPS/other from GitHub
	MIPS_GO_ARCH=""
	case "$ARCH" in
		mips|mipsbe) MIPS_GO_ARCH="mips" ;;
		mipsel|mipsle) MIPS_GO_ARCH="mipsle" ;;
		mips64) MIPS_GO_ARCH="mips64" ;;
		mips64le) MIPS_GO_ARCH="mips64le" ;;
	esac

	if [ -n "$MIPS_GO_ARCH" ]; then
		SGO_URL="https://github.com/showwin/speedtest-go/releases/download/v1.7.10/speedtest-go_1.7.10_Linux_${MIPS_GO_ARCH}.tar.gz"
		echo " [*] Downloading precompiled speedtest-go ($MIPS_GO_ARCH)..." >> "$_log"
		TMP_SGO="/tmp/speedtest-go.tar.gz"
		if download_file "$SGO_URL" "$TMP_SGO"; then
			tar -xzf "$TMP_SGO" -C /tmp/ speedtest-go 2>/dev/null || tar -xzf "$TMP_SGO" -C /tmp/ 2>/dev/null
			rm -f "$TMP_SGO"
			if [ -f /tmp/speedtest-go ]; then
				mv -f /tmp/speedtest-go /usr/bin/speedtest-go
				chmod 0755 /usr/bin/speedtest-go
				if /usr/bin/speedtest-go -v >/dev/null 2>&1; then
					echo " [✓] Precompiled speedtest-go installed successfully!" >> "$_log"
					echo "================================================================" >> "$_log"
					echo "" >> "$_log"
					return 0
				fi
			fi
		fi
	fi

	# If all failed:
	HINT="apk add speedtest-go"
	[ "$PKG_MGR" = "opkg" ] && HINT="opkg update && opkg install speedtest-go"
	echo "" >> "$_log"
	echo " [x] Engine installation could not complete automatically." >> "$_log"
	echo "     Please connect to your router via SSH and run:" >> "$_log"
	echo "     $HINT" >> "$_log"
	echo "================================================================" >> "$_log"
	echo "" >> "$_log"
	return 1
}

# Find speedtest binary; auto-provision if missing
SPEEDTEST_BIN=$(find_speedtest)
if [ -z "$SPEEDTEST_BIN" ] || [ ! -x "$SPEEDTEST_BIN" ]; then
	install_speedtest_engine "$EXEC_LOG"
	SPEEDTEST_BIN=$(find_speedtest)
fi

if [ -z "$SPEEDTEST_BIN" ] || [ ! -x "$SPEEDTEST_BIN" ]; then
	echo "[Error] Speedtest binary not found and could not be installed automatically." >> "$EXEC_LOG"
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

	# Extract ISP and Client IP
	RAW_ISP=$(grep -iE '^[[:space:]]*ISP:' "$EXEC_LOG" | head -n 1 | sed -e 's/^[[:space:]]*[Ii][Ss][Pp]: *//' -e 's/[[:space:]]*(.*//' | tr -d '\r')
	RAW_IP=$(grep -iE '^[[:space:]]*ISP:' "$EXEC_LOG" | head -n 1 | sed -nE 's/.*\(([0-9a-fA-F.:]+)\).*/\1/p' | tr -d '\r')
	if [ -z "$RAW_ISP" ]; then
		RAW_ISP=$(grep -i 'ISP:' "$EXEC_LOG" | head -n 1 | sed -n 's/.*(\([^)]*\)).*/\1/p' | tr -d '\r')
	fi
	if [ -z "$RAW_IP" ]; then
		RAW_IP=$(grep -i 'ISP:' "$EXEC_LOG" | head -n 1 | sed -n 's/.*ISP: *\([0-9a-fA-F.:]*\) .*/\1/p' | tr -d '\r')
	fi
	if [ -n "$RAW_ISP" ] || [ -n "$RAW_IP" ]; then
		echo "{\"isp\":\"${RAW_ISP:-Internet}\",\"ip\":\"$RAW_IP\"}" > "$CLIENT_CACHE"
	fi

	# Extract Server Name
	RAW_SERVER=$(grep -iE '^[[:space:]]*Server:' "$EXEC_LOG" | head -n 1 | sed -e 's/^[[:space:]]*[Ss]erver: *//' -e 's/[[:space:]]*(id:.*//' -e 's/[[:space:]]*(id =.*//' | tr -d '\r')
	[ -z "$RAW_SERVER" ] && RAW_SERVER=$(grep -i 'Server:' "$EXEC_LOG" | head -n 1 | sed -e 's/.*Server: *//' -e 's/[[:space:]]*(id:.*//' -e 's/[[:space:]]*(id =.*//' | tr -d '\r')

	# Extract Latency / Ping
	PING_VAL=$(grep -iE '(Idle Latency|Latency|Ping):' "$EXEC_LOG" | head -n 1 | sed -nE 's/.*(Idle Latency|Latency|Ping): *([0-9.]+).*/\2/p' | tr -d '\r')

	# Extract Jitter
	JITTER_VAL=$(grep -iE '(Idle Latency|Latency|Ping):' "$EXEC_LOG" | head -n 1 | sed -nE 's/.*jitter: *([0-9.]+).*/\1/p' | tr -d '\r')
	[ -z "$JITTER_VAL" ] && JITTER_VAL=$(grep -iE 'jitter:' "$EXEC_LOG" | head -n 1 | sed -nE 's/.*jitter: *([0-9.]+).*/\1/p' | tr -d '\r')

	# Extract Final Download & Upload
	DL_VAL=$(grep -iE '^[[:space:]]*Download:' "$EXEC_LOG" | tail -n 1 | sed -nE 's/.*Download: *([0-9.]+).*/\1/p' | tr -d '\r')
	[ -z "$DL_VAL" ] && DL_VAL=$(grep -i 'Download:' "$EXEC_LOG" | tail -n 1 | sed -nE 's/.*Download: *([0-9.]+).*/\1/p' | tr -d '\r')

	UL_VAL=$(grep -iE '^[[:space:]]*Upload:' "$EXEC_LOG" | tail -n 1 | sed -nE 's/.*Upload: *([0-9.]+).*/\1/p' | tr -d '\r')
	[ -z "$UL_VAL" ] && UL_VAL=$(grep -i 'Upload:' "$EXEC_LOG" | tail -n 1 | sed -nE 's/.*Upload: *([0-9.]+).*/\1/p' | tr -d '\r')

	# Extract Packet Loss & Result URL
	LOSS_VAL=$(grep -iE '^[[:space:]]*Packet Loss:' "$EXEC_LOG" | head -n 1 | sed -nE 's/.*Packet Loss: *([0-9.]+).*/\1/p' | tr -d '\r')
	RESULT_URL=$(grep -iE '^[[:space:]]*Result URL:' "$EXEC_LOG" | head -n 1 | sed -nE 's/.*Result URL: *([^ \r\n]+).*/\1/p' | tr -d '\r')

	# Append benchmark result to persistent history file
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
		UPDATED=$(jq --argjson entry "$NEW_ENTRY" --argjson max "$HISTORY_MAX" '[$entry] + (if type=="array" then . else [] end) | .[0:$max]' "$HISTORY_FILE" 2>/dev/null)
		if [ -n "$UPDATED" ] && [ "$UPDATED" != "null" ]; then
			echo "$UPDATED" > "$HISTORY_FILE"
			chmod 0666 "$HISTORY_FILE" 2>/dev/null || true
		fi
	fi
else
	echo "[x] Speed test exited with status $RC at $(date '+%H:%M:%S')." >> "$EXEC_LOG"
fi

exit $RC
