include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-marktrack
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

PKG_MAINTAINER:=Mark and Track Contributors
PKG_LICENSE:=GPL-3.0-or-later

LUCI_TITLE:=Mark and Track — LuCI Web Interface
LUCI_DEPENDS:=+marktrack +jq
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

define Package/luci-app-marktrack
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=$(LUCI_TITLE)
  DEPENDS:=$(LUCI_DEPENDS)
  PKGARCH:=$(LUCI_PKGARCH)
endef

define Package/luci-app-marktrack/description
  LuCI web interface for Mark and Track.
  Provides pages for managing DSCP marking rules,
  custom nftables rules, and a live connection viewer
  showing per-connection DSCP marks and bandwidth.
endef

define Package/luci-app-marktrack/install
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DIR) $(1)/usr/libexec/rpcd
	$(INSTALL_DIR) $(1)/htdocs/luci-static/resources/view/marktrack
	$(INSTALL_DIR) $(1)/htdocs/luci-static/resources/marktrack

	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-app-marktrack.json \
		$(1)/usr/share/luci/menu.d/
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-marktrack.json \
		$(1)/usr/share/rpcd/acl.d/

	$(INSTALL_BIN)  ./root/usr/libexec/rpcd/luci.marktrack \
		$(1)/usr/libexec/rpcd/
	$(INSTALL_BIN)  ./root/usr/libexec/rpcd/luci.marktrack_stats \
		$(1)/usr/libexec/rpcd/

	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/marktrack/connections.js \
		$(1)/htdocs/luci-static/resources/view/marktrack/
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/marktrack/rules.js \
		$(1)/htdocs/luci-static/resources/view/marktrack/
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/marktrack/custom_rules.js \
		$(1)/htdocs/luci-static/resources/view/marktrack/

	$(INSTALL_DATA) ./htdocs/luci-static/resources/marktrack/marktrack.css \
		$(1)/htdocs/luci-static/resources/marktrack/
endef

$(eval $(call BuildPackage,luci-app-marktrack))
