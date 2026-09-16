include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for Speedtest.net (Onyx Edition)
LUCI_DEPENDS:=+luci-base +curl +ca-bundle +jq +tar
LUCI_PKGARCH:=all

PKG_NAME:=luci-app-speedtest-onyx
PKG_VERSION:=1.1
PKG_RELEASE:=2
PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=Manish Matwa Choudhary

# Include luci.mk if present in feeds (standard OpenWrt SDK setup)
ifneq ($(wildcard $(TOPDIR)/feeds/luci/luci.mk),)
  include $(TOPDIR)/feeds/luci/luci.mk
else
  include $(INCLUDE_DIR)/package.mk

  define Package/$(PKG_NAME)
    SECTION:=luci
    CATEGORY:=LuCI
    SUBMENU:=3. Applications
    TITLE:=$(LUCI_TITLE)
    DEPENDS:=$(LUCI_DEPENDS)
    PKGARCH:=$(LUCI_PKGARCH)
  endef

  define Package/$(PKG_NAME)/description
    Modern, responsive Speedtest.net (Ookla) Onyx Dashboard for OpenWrt.
    Features authentic Speedtest.net aesthetics, real-time speedometer gauge,
    ping, jitter, server selection, and historical speed analytics.
  endef

  define Package/$(PKG_NAME)/conffiles
/etc/config/speedtest
  endef

  define Build/Configure
  endef

  define Build/Compile
  endef

  define Package/$(PKG_NAME)/install
	$(INSTALL_DIR) $(1)/
	cp -pR ./root/* $(1)/
	$(INSTALL_DIR) $(1)/www
	cp -pR ./htdocs/* $(1)/www/
	chmod 0755 $(1)/usr/libexec/* 2>/dev/null || true
	chmod 0755 $(1)/etc/init.d/* 2>/dev/null || true
  endef
endif

define Package/$(PKG_NAME)/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	chmod 0755 /etc/init.d/speedtest 2>/dev/null || true
	chmod 0755 /usr/libexec/speedtest* 2>/dev/null || true
	rm -rf /tmp/luci-indexcache /tmp/luci-modulecache /tmp/luci-sessions/*
	/etc/init.d/rpcd reload 2>/dev/null
	if [ -f /etc/init.d/speedtest ]; then
		/etc/init.d/speedtest enable 2>/dev/null
		/etc/init.d/speedtest start 2>/dev/null
	fi
}
exit 0
endef

define Package/$(PKG_NAME)/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	if [ -f /etc/init.d/speedtest ]; then
		/etc/init.d/speedtest stop 2>/dev/null
		/etc/init.d/speedtest disable 2>/dev/null
	fi
}
exit 0
endef

ifeq ($(wildcard $(TOPDIR)/feeds/luci/luci.mk),)
  $(eval $(call BuildPackage,$(PKG_NAME)))
endif
