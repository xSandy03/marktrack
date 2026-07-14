include $(TOPDIR)/rules.mk

PKG_NAME:=marktrack
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

PKG_MAINTAINER:=Mark and Track Contributors
PKG_LICENSE:=GPL-3.0-or-later

include $(INCLUDE_DIR)/package.mk

define Package/marktrack
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Mark and Track — nftables DSCP packet marker and connection tracker
  DEPENDS:=+kmod-nf-conntrack +nftables
endef

define Package/marktrack/description
  Mark and Track is a lightweight OpenWrt package that marks network packets
  with DSCP values via nftables and stores the marks in conntrack for
  per-connection visibility. Supports user-defined rules, IP sets, and
  custom raw nftables rules. Pairs with luci-app-marktrack for a web UI.
endef

define Build/Prepare
endef

define Build/Compile
endef

define Package/marktrack/conffiles
/etc/config/marktrack
/etc/marktrack.d/custom_rules.nft
endef

define Package/marktrack/install
	$(INSTALL_DIR) $(1)/etc
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_DIR) $(1)/etc/marktrack.d

	$(INSTALL_BIN)  ./etc/marktrack.sh        $(1)/etc/
	$(INSTALL_BIN)  ./etc/init.d/marktrack    $(1)/etc/init.d/
	$(INSTALL_CONF) ./etc/config/marktrack    $(1)/etc/config/
	$(INSTALL_CONF) ./etc/marktrack.d/custom_rules.nft  $(1)/etc/marktrack.d/
endef

$(eval $(call BuildPackage,marktrack))
