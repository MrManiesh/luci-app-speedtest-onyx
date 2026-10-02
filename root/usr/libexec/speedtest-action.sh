#!/bin/sh
# Speedtest Main Action Controller (<10ms fast response)

LOCK_FILE="/tmp/speedtest.lock"
EXEC_LOG="/tmp/speedtest_exec.log"
CLIENT_CACHE="/tmp/speedtest_client.json"
HISTORY_FILE="/etc/speedtest_history.json"

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

case "$1" in
	status)
		SPEEDTEST_BIN=$(find_speedtest)
		ENGINE_INSTALLED="0"
		ENGINE_VER=""
		ENGINE_ARCH=$(uname -m 2>/dev/null || echo "unknown")
		ENGINE_TYPE="none"
		if [ -n "$SPEEDTEST_BIN" ] && [ -x "$SPEEDTEST_BIN" ]; then
			ENGINE_INSTALLED="1"
			ENGINE_VER=$("$SPEEDTEST_BIN" --version 2>&1 | head -n 1)
			[ -z "$ENGINE_VER" ] && ENGINE_VER=$("$SPEEDTEST_BIN" -v 2>&1 | head -n 1)
			case "$ENGINE_VER" in
				*Ookla*) ENGINE_TYPE="ookla" ;;
				*) ENGINE_TYPE="speedtest-go" ;;
			esac
		fi

		IS_RUNNING="0"
		if [ -f "$LOCK_FILE" ]; then
			pid=$(cat "$LOCK_FILE" 2>/dev/null)
			if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
				IS_RUNNING="1"
			else
				rm -f "$LOCK_FILE"
			fi
		fi

		# Read or seed client info
		if [ ! -f "$CLIENT_CACHE" ]; then
			if [ -f "$HISTORY_FILE" ]; then
				H_ISP=$(jq -r '.[0].isp // empty' "$HISTORY_FILE" 2>/dev/null)
				H_IP=$(jq -r '.[0].client_ip // empty' "$HISTORY_FILE" 2>/dev/null)
				if [ -n "$H_ISP" ] || [ -n "$H_IP" ]; then
					echo "{\"isp\":\"${H_ISP:-Internet Connection}\",\"ip\":\"$H_IP\"}" > "$CLIENT_CACHE"
				fi
			fi
			if [ ! -f "$CLIENT_CACHE" ]; then
				(
					INFO=$(curl -s --connect-timeout 2 --max-time 3 "https://ipinfo.io/json" 2>/dev/null)
					if [ -n "$INFO" ]; then
						Q_IP=$(echo "$INFO" | jq -r '.ip // empty' 2>/dev/null)
						Q_ORG=$(echo "$INFO" | jq -r '.org // empty' 2>/dev/null | sed -E 's/^AS[0-9]+ //')
						[ -n "$Q_IP" ] && echo "{\"isp\":\"${Q_ORG:-Broadband}\",\"ip\":\"$Q_IP\"}" > "$CLIENT_CACHE"
					fi
				) </dev/null >/dev/null 2>&1 &
			fi
		fi

		CLIENT_JSON=""
		if [ -f "$CLIENT_CACHE" ]; then
			CLIENT_JSON=$(cat "$CLIENT_CACHE" 2>/dev/null)
		fi
		case "$CLIENT_JSON" in
			*\"isp\"*\"ip\"*) ;;
			*) CLIENT_JSON='{"isp":"Detecting...","ip":""}' ;;
		esac

		cat << EOF
{
  "running": $IS_RUNNING,
  "client": $CLIENT_JSON,
  "engine": {
    "installed": $ENGINE_INSTALLED,
    "version": "$ENGINE_VER",
    "path": "$SPEEDTEST_BIN",
    "arch": "$ENGINE_ARCH",
    "type": "$ENGINE_TYPE"
  }
}
EOF
		exit 0
		;;

	install)
		SPEEDTEST_BIN=$(find_speedtest)
		if [ -n "$SPEEDTEST_BIN" ]; then
			VER=$("$SPEEDTEST_BIN" --version 2>&1 | head -n 1)
			[ -z "$VER" ] && VER=$("$SPEEDTEST_BIN" -v 2>&1 | head -n 1)
			echo "{\"status\":\"ok\",\"message\":\"Speedtest engine already installed\",\"path\":\"$SPEEDTEST_BIN\",\"version\":\"$VER\"}"
			exit 0
		fi

		rm -f "$EXEC_LOG"
		touch "$EXEC_LOG"

		if install_speedtest_engine "$EXEC_LOG"; then
			SPEEDTEST_BIN=$(find_speedtest)
			VER=$("$SPEEDTEST_BIN" --version 2>&1 | head -n 1)
			[ -z "$VER" ] && VER=$("$SPEEDTEST_BIN" -v 2>&1 | head -n 1)
			echo "{\"status\":\"ok\",\"message\":\"Speedtest engine installed successfully\",\"path\":\"$SPEEDTEST_BIN\",\"version\":\"$VER\"}"
			exit 0
		else
			echo '{"status":"error","message":"Failed to install speedtest engine automatically. Please check terminal log."}'
			exit 0
		fi
		;;

	check)
		SPEEDTEST_BIN=$(find_speedtest)
		ARCH=$(uname -m 2>/dev/null || echo "unknown")
		if [ -n "$SPEEDTEST_BIN" ]; then
			VER=$("$SPEEDTEST_BIN" --version 2>&1 | head -n 1)
			[ -z "$VER" ] && VER=$("$SPEEDTEST_BIN" -v 2>&1 | head -n 1)
			echo "Speedtest engine: Installed"
			echo "Path:             $SPEEDTEST_BIN"
			echo "Version:          $VER"
			echo "Architecture:     $ARCH"
		else
			echo "Speedtest engine: Not Installed"
			echo "Architecture:     $ARCH"
		fi
		exit 0
		;;

	start)
		SERVER_ID="$2"

		if [ -f "$LOCK_FILE" ]; then
			pid=$(cat "$LOCK_FILE" 2>/dev/null)
			if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
				echo '{"status":"error","message":"Speed test is already running"}'
				exit 0
			fi
		fi

		rm -f "$EXEC_LOG"
		touch "$EXEC_LOG"

		chmod 0755 /usr/libexec/speedtest-runner.sh 2>/dev/null || true
		if command -v start-stop-daemon >/dev/null 2>&1; then
			start-stop-daemon -S -b -x /usr/libexec/speedtest-runner.sh -- "$SERVER_ID"
		else
			( /bin/sh /usr/libexec/speedtest-runner.sh "$SERVER_ID" </dev/null >/dev/null 2>&1 ) &
		fi

		echo '{"status":"ok","message":"Speed test started"}'
		exit 0
		;;

	stop)
		if [ -f "$LOCK_FILE" ]; then
			pid=$(cat "$LOCK_FILE" 2>/dev/null)
			[ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
			rm -f "$LOCK_FILE"
		fi
		killall -9 speedtest-go 2>/dev/null || true
		killall -9 speedtest 2>/dev/null || true
		[ -f "$EXEC_LOG" ] && echo -e "\n[!] Speed test stopped by user." >> "$EXEC_LOG"
		echo '{"status":"ok","message":"Speed test cancelled"}'
		exit 0
		;;

	log)
		if [ -f "$EXEC_LOG" ]; then
			cat "$EXEC_LOG"
		else
			echo ""
		fi
		exit 0
		;;

	clear_log)
		rm -f "$EXEC_LOG"
		touch "$EXEC_LOG"
		echo '{"status":"ok"}'
		exit 0
		;;

	history)
		if [ -f "$HISTORY_FILE" ] && [ -s "$HISTORY_FILE" ]; then
			cat "$HISTORY_FILE"
		else
			echo "[]"
		fi
		exit 0
		;;

	clear_history)
		echo "[]" > "$HISTORY_FILE"
		chmod 0666 "$HISTORY_FILE" 2>/dev/null || true
		echo '{"status":"ok","message":"History cleared"}'
		exit 0
		;;

	check_update)
		CURL_OUT=$(curl -s --connect-timeout 6 --max-time 10 -H "User-Agent: OpenWrt-LuCI-Speedtest" "https://api.github.com/repos/MrManiesh/luci-app-speedtest-onyx/releases/latest" 2>/dev/null)
		if [ -n "$CURL_OUT" ]; then
			echo "$CURL_OUT"
		else
			echo '{"error":"Failed to connect to GitHub"}'
		fi
		exit 0
		;;

	*)
		echo '{"error":"Invalid action"}'
		exit 1
		;;
esac
