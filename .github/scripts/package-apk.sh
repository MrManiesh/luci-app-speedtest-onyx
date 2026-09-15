#!/bin/bash
set -eo pipefail

# 1. Parse metadata dynamically from Makefile
PKG_NAME=$(grep '^PKG_NAME:=' Makefile | cut -d= -f2 | tr -d ' \r\n')
PKG_VERSION=$(grep '^PKG_VERSION:=' Makefile | cut -d= -f2 | tr -d ' \r\n')
PKG_RELEASE=$(grep '^PKG_RELEASE:=' Makefile | cut -d= -f2 | tr -d ' \r\n')
PKG_TITLE=$(grep '^LUCI_TITLE:=' Makefile | cut -d= -f2 | tr -d '\r\n')
PKG_LICENSE=$(grep '^PKG_LICENSE:=' Makefile | cut -d= -f2 | tr -d ' \r\n')
PKG_MAINTAINER=$(grep '^PKG_MAINTAINER:=' Makefile | cut -d= -f2 | tr -d '\r\n')
PKG_DEPENDS=$(grep '^LUCI_DEPENDS:=' Makefile | cut -d= -f2 | tr -d '\r\n' | sed 's/+install //g; s/+//g')

echo "=== Packaging Information ==="
echo "Package:     $PKG_NAME"
echo "Version:     $PKG_VERSION-r$PKG_RELEASE"
echo "Title:       $PKG_TITLE"
echo "License:     $PKG_LICENSE"
echo "Maintainer:  $PKG_MAINTAINER"
echo "Depends:     $PKG_DEPENDS"

# 2. Prepare directory tree for packaging
WORKSPACE_DIR="${GITHUB_WORKSPACE:-$(pwd)}"
STAGE_DIR="${WORKSPACE_DIR}/stage"
PKG_ROOT="${STAGE_DIR}/pkg_root"
SCRIPTS_DIR="${STAGE_DIR}/scripts"
DIST_DIR="${WORKSPACE_DIR}/dist"

rm -rf "${STAGE_DIR}"
mkdir -p "${PKG_ROOT}" "${SCRIPTS_DIR}" "${DIST_DIR}"

# Copy app files
cp -r root/* "${PKG_ROOT}/"
mkdir -p "${PKG_ROOT}/www"
cp -r htdocs/* "${PKG_ROOT}/www/"

# Set permissions
chmod -R 0755 "${PKG_ROOT}/usr/libexec"
chmod -R 0755 "${PKG_ROOT}/etc/init.d"
find "${PKG_ROOT}" -type f -exec chmod a+r {} +

# Generate OpenWrt APK tracking files
mkdir -p "${PKG_ROOT}/lib/apk/packages"
(cd "${PKG_ROOT}" && find . -type f -o -type l | sed 's|^\.||' | sort > "lib/apk/packages/${PKG_NAME}.list")
if [ -f "${PKG_ROOT}/etc/config/speedtest" ]; then
	echo "/etc/config/speedtest" > "${PKG_ROOT}/lib/apk/packages/${PKG_NAME}.conffiles"
	CONF_CSUM=$(sha256sum "${PKG_ROOT}/etc/config/speedtest" | awk '{print $1}')
	echo "/etc/config/speedtest ${CONF_CSUM}" > "${PKG_ROOT}/lib/apk/packages/${PKG_NAME}.conffiles_static"
fi

# 3. Create lifecycle scripts
cat << 'EOF' > "${SCRIPTS_DIR}/post-install"
#!/bin/sh
[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0
[ -s "${IPKG_INSTROOT}/lib/functions.sh" ] || exit 0
. "${IPKG_INSTROOT}/lib/functions.sh"
export root="${IPKG_INSTROOT}"
export pkgname="luci-app-speedtest-onyx"
[ -n "${IPKG_INSTROOT}" ] || {
	chmod 0755 /etc/init.d/speedtest* 2>/dev/null || true
	chmod 0755 /usr/libexec/speedtest* 2>/dev/null || true
	rm -rf /tmp/luci-indexcache /tmp/luci-modulecache /tmp/luci-sessions/*
	/etc/init.d/rpcd reload 2>/dev/null
	if [ -f /etc/init.d/speedtest ]; then
		/etc/init.d/speedtest enable 2>/dev/null
		/etc/init.d/speedtest start 2>/dev/null
	fi
}
exit 0
EOF

cat << 'EOF' > "${SCRIPTS_DIR}/post-upgrade"
#!/bin/sh
export PKG_UPGRADE=1
[ -n "${IPKG_INSTROOT}" ] || {
	chmod 0755 /etc/init.d/speedtest* 2>/dev/null || true
	chmod 0755 /usr/libexec/speedtest* 2>/dev/null || true
	rm -rf /tmp/luci-indexcache /tmp/luci-modulecache /tmp/luci-sessions/*
	/etc/init.d/rpcd reload 2>/dev/null
	if [ -f /etc/init.d/speedtest ]; then
		/etc/init.d/speedtest restart 2>/dev/null
	fi
}
exit 0
EOF

cat << 'EOF' > "${SCRIPTS_DIR}/pre-deinstall"
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] || {
	if [ -f /etc/init.d/speedtest ]; then
		/etc/init.d/speedtest stop 2>/dev/null || true
		/etc/init.d/speedtest disable 2>/dev/null || true
	fi
	if [ -f /tmp/speedtest.lock ]; then
		pid=$(cat /tmp/speedtest.lock 2>/dev/null)
		[ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
		rm -f /tmp/speedtest.lock
	fi
	killall -9 speedtest 2>/dev/null || true
	killall -9 speedtest-go 2>/dev/null || true
}
exit 0
EOF

chmod 0755 "${SCRIPTS_DIR}"/*

# 4. Invoke apk mkpkg directly in lightweight alpine:edge container
APK_FILE="${PKG_NAME}-${PKG_VERSION}-r${PKG_RELEASE}.apk"

docker run --rm \
	-v "${WORKSPACE_DIR}":/workspace \
	-w /workspace \
	alpine:edge sh -c "
		apk update >/dev/null 2>&1 || true
		apk add apk-tools >/dev/null 2>&1 || true
		SOURCE_DATE_EPOCH=0 apk mkpkg \
			--info \"name:${PKG_NAME}\" \
			--info \"version:${PKG_VERSION}-r${PKG_RELEASE}\" \
			--info \"description:${PKG_TITLE}\" \
			--info \"arch:noarch\" \
			--info \"license:${PKG_LICENSE}\" \
			--info \"origin:${PKG_NAME}\" \
			--info \"url:https://github.com/MrManiesh/luci-app-speedtest-onyx\" \
			--info \"maintainer:${PKG_MAINTAINER}\" \
			--info \"depends:${PKG_DEPENDS}\" \
			--script \"post-install:stage/scripts/post-install\" \
			--script \"post-upgrade:stage/scripts/post-upgrade\" \
			--script \"pre-deinstall:stage/scripts/pre-deinstall\" \
			--files stage/pkg_root \
			--output \"dist/${APK_FILE}\"
	"

echo "=== Built Artifacts in dist/ ==="
ls -lh "${DIST_DIR}"
if [ ! -f "${DIST_DIR}/${APK_FILE}" ]; then
	echo "::error::Failed to produce ${DIST_DIR}/${APK_FILE}"
	exit 1
fi
