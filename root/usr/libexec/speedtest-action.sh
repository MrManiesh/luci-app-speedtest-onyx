#!/bin/sh
# Speedtest Main Action Controller (<10ms fast response)

LOCK_FILE="/tmp/speedtest.lock"
EXEC_LOG="/tmp/speedtest_exec.log"
CLIENT_CACHE="/tmp/speedtest_client.json"
HISTORY_FILE="/etc/speedtest_history.json"

find_speedtest() {
	if [ -x /usr/bin/speedtest ]; then
		echo "/usr/bin/speedtest"
	elif command -v speedtest >/dev/null 2>&1; then
		echo "$(command -v speedtest)"
	elif [ -x /usr/bin/speedtest-go ]; then
		echo "/usr/bin/speedtest-go"
	elif command -v speedtest-go >/dev/null 2>&1; then
		echo "$(command -v speedtest-go)"
	else
		echo ""
	fi
}

case "$1" in
	status)
		SPEEDTEST_BIN=$(find_speedtest)
		ENGINE_INSTALLED="0"
		ENGINE_VER=""
		ENGINE_ARCH=$(uname -m)
		if [ -n "$SPEEDTEST_BIN" ] && [ -x "$SPEEDTEST_BIN" ]; then
			ENGINE_INSTALLED="1"
			ENGINE_VER=$("$SPEEDTEST_BIN" --version 2>&1 | head -n 1)
			[ -z "$ENGINE_VER" ] && ENGINE_VER=$("$SPEEDTEST_BIN" -v 2>&1 | head -n 1)
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
					echo "{"isp":"${H_ISP:-Internet Connection}","ip":"$H_IP"}" > "$CLIENT_CACHE"
				fi
			fi
			if [ ! -f "$CLIENT_CACHE" ]; then
				(
					INFO=$(curl -s --connect-timeout 2 --max-time 3 "https://ipinfo.io/json" 2>/dev/null)
					if [ -n "$INFO" ]; then
						Q_IP=$(echo "$INFO" | jq -r '.ip // empty' 2>/dev/null)
						Q_ORG=$(echo "$INFO" | jq -r '.org // empty' 2>/dev/null | sed -E 's/^AS[0-9]+ //')
						[ -n "$Q_IP" ] && echo "{"isp":"${Q_ORG:-Broadband}","ip":"$Q_IP"}" > "$CLIENT_CACHE"
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
    "arch": "$ENGINE_ARCH"
  }
}
EOF
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

		SPEEDTEST_BIN=$(find_speedtest)
		if [ -z "$SPEEDTEST_BIN" ] || [ ! -x "$SPEEDTEST_BIN" ]; then
			echo '{"status":"error","message":"Speedtest binary not found. Please run: apk add speedtest-go"}'
			exit 0
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

	*)
		echo '{"error":"Invalid action"}'
		exit 1
		;;
esac
