#!/bin/sh
# Speedtest Binary Installer & Architecture Detector for OpenWrt

INSTALL_BIN="/usr/bin/speedtest"

detect_arch() {
	local raw_arch=$(uname -m)
	case "$raw_arch" in
		x86_64|amd64) echo "x86_64" ;;
		i386|i486|i586|i686) echo "i386" ;;
		aarch64|arm64) echo "aarch64" ;;
		armv7*|armhf) echo "armhf" ;;
		armv6*|armel) echo "armel" ;;
		mips*) echo "mips" ;;
		mipsel*) echo "mipsel" ;;
		*) echo "$raw_arch" ;;
	esac
}

ARCH=$(detect_arch)

case "$1" in
	check)
		BIN=""
		if command -v speedtest-go >/dev/null 2>&1; then
			BIN=$(command -v speedtest-go)
		elif [ -x "$INSTALL_BIN" ]; then
			BIN="$INSTALL_BIN"
		fi

		if [ -n "$BIN" ] && [ -x "$BIN" ]; then
			VER=$("$BIN" --version 2>&1 | head -n 1)
			[ -z "$VER" ] && VER=$("$BIN" -v 2>&1 | head -n 1)
			echo "{\"installed\":true,\"path\":\"$BIN\",\"version\":\"$VER\",\"arch\":\"$ARCH\"}"
		else
			echo "{\"installed\":false,\"arch\":\"$ARCH\"}"
		fi
		exit 0
		;;
	install)
		# 1. Try official OpenWrt package manager apk or opkg for speedtest-go
		if command -v apk >/dev/null 2>&1; then
			apk add speedtest-go >/dev/null 2>&1
			if [ -x /usr/bin/speedtest-go ]; then
				echo '{"status":"ok","engine":"speedtest-go","message":"Installed speedtest-go via apk successfully"}'
				exit 0
			fi
		fi

		if command -v opkg >/dev/null 2>&1; then
			opkg update >/dev/null 2>&1
			opkg install speedtest-go >/dev/null 2>&1
			if [ -x /usr/bin/speedtest-go ]; then
				echo '{"status":"ok","engine":"speedtest-go","message":"Installed speedtest-go via opkg successfully"}'
				exit 0
			fi
		fi

		# 2. Direct binary download fallback
		TMP_DIR="/tmp/speedtest_install_$$"
		mkdir -p "$TMP_DIR"
		GO_VER="1.7.10"
		GO_URL="https://github.com/showwin/speedtest-go/releases/download/v${GO_VER}/speedtest-go_${GO_VER}_Linux_${ARCH}.tar.gz"

		curl -sSLk -o "$TMP_DIR/speedtest.tar.gz" "$GO_URL"
		if [ $? -eq 0 ] && [ -s "$TMP_DIR/speedtest.tar.gz" ]; then
			tar -xzf "$TMP_DIR/speedtest.tar.gz" -C "$TMP_DIR"
			mv "$TMP_DIR/speedtest-go" "$INSTALL_BIN" 2>/dev/null || true
			chmod 0755 "$INSTALL_BIN"
			rm -rf "$TMP_DIR"
			echo '{"status":"ok","engine":"speedtest-go","message":"Installed speedtest-go successfully"}'
			exit 0
		fi

		rm -rf "$TMP_DIR"
		echo "{\"status\":\"error\",\"message\":\"Failed to install speedtest binary. Try: apk add speedtest-go\"}"
		exit 1
		;;
	*)
		echo "Usage: $0 {check|install}"
		exit 1
		;;
esac
