#!/bin/sh
# Speedtest Server List Provider

CACHE_FILE="/tmp/speedtest_servers_cache.json"
CACHE_MAX_AGE=3600

now=$(date +%s)
if [ -f "$CACHE_FILE" ]; then
	file_time=$(date -r "$CACHE_FILE" +%s 2>/dev/null || echo 0)
	age=$((now - file_time))
	if [ $age -lt $CACHE_MAX_AGE ] && [ -s "$CACHE_FILE" ]; then
		cat "$CACHE_FILE"
		exit 0
	fi
fi

# Try speedtest-go first if available
if command -v speedtest-go >/dev/null 2>&1 || [ -x /usr/bin/speedtest-go ]; then
	SGO=$(command -v speedtest-go 2>/dev/null || echo "/usr/bin/speedtest-go")
	RAW=$("$SGO" -l 2>/dev/null)
	if [ -n "$RAW" ] && echo "$RAW" | grep -q '\['; then
		TMP_JSON="["
		first=1
		echo "$RAW" | grep '^[ 	]*\[' | head -n 30 | while IFS= read -r line; do
			sid=$(echo "$line" | sed -n 's/^[ 	]*\[ *\([0-9]*\)\]\([^k]*\)km *\([^m]*\)ms *\(.*\) by *\(.*\)//p')
			[ -z "$sid" ] && continue
			sloc=$(echo "$line" | sed -n 's/^[ 	]*\[ *\([0-9]*\)\]\([^k]*\)km *\([^m]*\)ms *\(.*\) by *\(.*\)//p' | sed 's/[ 	]*$//')
			sname=$(echo "$line" | sed -n 's/^[ 	]*\[ *\([0-9]*\)\]\([^k]*\)km *\([^m]*\)ms *\(.*\) by *\(.*\)//p' | sed 's/[ 	]*$//')
			scountry=""
			if echo "$sloc" | grep -q '('; then
				scountry=$(echo "$sloc" | sed -n 's/.*(\([^)]*\)).*//p')
				sloc=$(echo "$sloc" | sed -n 's/\(.*\) *(.*)//p' | sed 's/[ 	]*$//')
			fi
			if [ "$first" = "1" ]; then
				TMP_JSON="$TMP_JSON{\"id\":$sid,\"name\":\"$sname\",\"location\":\"$sloc\",\"country\":\"$scountry\"}"
				first=0
			else
				TMP_JSON="$TMP_JSON,{\"id\":$sid,\"name\":\"$sname\",\"location\":\"$sloc\",\"country\":\"$scountry\"}"
			fi
		done
		TMP_JSON="$TMP_JSON]"
		if [ "$TMP_JSON" != "[]" ] && [ -n "$TMP_JSON" ]; then
			echo "$TMP_JSON" > "$CACHE_FILE"
			cat "$CACHE_FILE"
			exit 0
		fi
	fi
fi

# Fallback to Ookla CLI if available
SPEEDTEST_BIN="/usr/bin/speedtest"
[ ! -x "$SPEEDTEST_BIN" ] && SPEEDTEST_BIN=$(command -v speedtest 2>/dev/null)

if [ -n "$SPEEDTEST_BIN" ] && [ -x "$SPEEDTEST_BIN" ]; then
	SERVERS_JSON=$("$SPEEDTEST_BIN" -L --format=json --accept-license --accept-gdpr 2>/dev/null)
	if [ -n "$SERVERS_JSON" ] && echo "$SERVERS_JSON" | grep -q '"servers"'; then
		if command -v jq >/dev/null 2>&1; then
			echo "$SERVERS_JSON" | jq '.servers // []' 2>/dev/null > "$CACHE_FILE"
		else
			echo "$SERVERS_JSON" | sed -n 's/.*"servers":\(\[[^]]*\]\).*//p' > "$CACHE_FILE"
		fi
		if [ -s "$CACHE_FILE" ]; then
			cat "$CACHE_FILE"
			exit 0
		fi
	fi
fi

if [ -s "$CACHE_FILE" ]; then
	cat "$CACHE_FILE"
	exit 0
fi

echo "[]"
