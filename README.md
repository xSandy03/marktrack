# Mark and Track (`marktrack`)

Mark and Track is a lightweight, standalone OpenWrt package designed to mark network packets with DSCP values via `nftables` and store these marks in connection tracking (`conntrack`). This enables per-connection visibility of DSCP classifications through a companion LuCI web interface.

This project is a streamlined fork of the marking and tracking components from [QoSmate](https://github.com/hudra0/qosmate), stripped of all traffic shaping (TC), autorate, and complex QoS logic. It focuses purely on **marking** packets and **tracking** connections.

## Features

- **DSCP Marking Rules**: Define per-flow packet marking rules based on Protocol, Source/Destination IPs, and Ports via standard UCI configuration.
- **IP Sets**: Support for both static and dynamic IPv4/IPv6 sets (e.g., `gaming_devices`) that can be referenced in rules.
- **Custom nftables Rules**: Directly inject raw `nftables` syntax for advanced marking logic.
- **Conntrack Integration**: Automatically saves applied DSCP marks into the `ct mark` field, ensuring the mark persists for the lifetime of the connection.
- **Live Connections UI**: A real-time LuCI dashboard showing all active connections, their decoded DSCP labels (e.g., `CS0`, `CS5`, `AF42`), and live bandwidth usage.
- **Rule Hit Counters**: View packet and byte match counters live in the LuCI interface for every active rule.

## Installation

Mark and Track targets OpenWrt **21.02 or newer** (nftables + conntrack). It ships as two packages: `marktrack` (backend) and `luci-app-marktrack` (web UI).

### Requirements

| Package | Why |
|---|---|
| `nftables` | Applies the DSCP marking rules |
| `kmod-nf-conntrack` | Stores marks per connection |
| `jq` | Rule hit counters in the UI |
| `ca-bundle` | HTTPS fetch from GitHub (for the one-line installer) |

> The Connections page backend is pure shell + `awk` (busybox), so no `lua`/`luci-lib-jsonc` is required.

### Method A — One-line install (no build, recommended)

Paste this into the router's shell (SSH). It downloads the latest tagged release straight from GitHub with `uclient-fetch`, installs dependencies, and starts the service — no SDK or `.ipk` needed. Re-running it updates an existing install (your `/etc/config/marktrack` is preserved).

```sh
REPO="xSandy03/marktrack"
LATEST_TAG=$(uclient-fetch -O - https://api.github.com/repos/$REPO/releases/latest 2>/dev/null | grep -o '"tag_name":"[^"]*' | sed 's/"tag_name":"//')
[ -z "$LATEST_TAG" ] && LATEST_TAG="v0.2"
BASE="https://raw.githubusercontent.com/$REPO/$LATEST_TAG"

# Dependencies (auto-detects apk on OpenWrt 24.10+, opkg on 23.05 and older)
DEPS="nftables kmod-nf-conntrack jq ca-bundle"
if command -v apk >/dev/null 2>&1; then
    apk update && apk add $DEPS
elif command -v opkg >/dev/null 2>&1; then
    opkg update && opkg install $DEPS
fi

# Backend (marktrack)
mkdir -p /etc/marktrack.d
uclient-fetch -O /etc/init.d/marktrack $BASE/etc/init.d/marktrack && chmod +x /etc/init.d/marktrack
uclient-fetch -O /etc/marktrack.sh    $BASE/etc/marktrack.sh    && chmod +x /etc/marktrack.sh
[ ! -f /etc/config/marktrack ] && uclient-fetch -O /etc/config/marktrack $BASE/etc/config/marktrack
[ ! -f /etc/marktrack.d/custom_rules.nft ] && uclient-fetch -O /etc/marktrack.d/custom_rules.nft $BASE/etc/marktrack.d/custom_rules.nft

# Frontend (luci-app-marktrack)
mkdir -p /www/luci-static/resources/view/marktrack /usr/share/luci/menu.d /usr/share/rpcd/acl.d /usr/libexec/rpcd
for f in connections custom_rules ipsets rules; do
  uclient-fetch -O /www/luci-static/resources/view/marktrack/$f.js \
    $BASE/luci-app-marktrack/htdocs/luci-static/resources/view/marktrack/$f.js
done
uclient-fetch -O /usr/share/luci/menu.d/luci-app-marktrack.json $BASE/luci-app-marktrack/root/usr/share/luci/menu.d/luci-app-marktrack.json
uclient-fetch -O /usr/share/rpcd/acl.d/luci-app-marktrack.json  $BASE/luci-app-marktrack/root/usr/share/rpcd/acl.d/luci-app-marktrack.json
uclient-fetch -O /usr/libexec/rpcd/luci.marktrack       $BASE/luci-app-marktrack/root/usr/libexec/rpcd/luci.marktrack       && chmod +x /usr/libexec/rpcd/luci.marktrack
uclient-fetch -O /usr/libexec/rpcd/luci.marktrack_stats $BASE/luci-app-marktrack/root/usr/libexec/rpcd/luci.marktrack_stats && chmod +x /usr/libexec/rpcd/luci.marktrack_stats

# Enable, start, and register the web UI
/etc/init.d/marktrack enable
/etc/init.d/marktrack start
/etc/init.d/rpcd restart
/etc/init.d/uhttpd restart
```

> **Note:** marktrack lives in a **single** repository, so every file above comes from `xSandy03/marktrack` (unlike QoSmate, which splits backend and LuCI into two repos). To pin a specific version instead of the latest, replace the `LATEST_TAG` line with e.g. `LATEST_TAG="v0.2"`.

### Method B — Build from source with the OpenWrt SDK

```sh
# 1. Get the SDK for your target/version from https://downloads.openwrt.org
#    (example: x86_64 / 23.05.3), unpack it, and cd into it.

# 2. Drop marktrack into the SDK's package tree
git clone https://github.com/xSandy03/marktrack package/marktrack

# 3. Select both packages, then build them
make menuconfig          # Network > marktrack   and   LuCI > Applications > luci-app-marktrack
make package/marktrack/compile V=s
make package/luci-app-marktrack/compile V=s

# 4. Copy the resulting .ipk files to the router and install
scp bin/packages/*/base/marktrack_*.ipk bin/packages/*/base/luci-app-marktrack_*.ipk root@192.168.1.1:/tmp/
ssh root@192.168.1.1 'opkg install /tmp/marktrack_*.ipk /tmp/luci-app-marktrack_*.ipk'
```

### Method C — Manual install (quick test / development)

Run these from the repository root, pointing `ROUTER` at your device:

```sh
ROUTER=root@192.168.1.1

# Dependencies
ssh $ROUTER 'opkg update && opkg install nftables kmod-nf-conntrack jq lua luci-lib-jsonc'

# Backend
ssh $ROUTER 'mkdir -p /etc/marktrack.d'
scp etc/marktrack.sh                 $ROUTER:/etc/marktrack.sh
scp etc/init.d/marktrack             $ROUTER:/etc/init.d/marktrack
scp etc/config/marktrack             $ROUTER:/etc/config/marktrack
scp etc/marktrack.d/custom_rules.nft $ROUTER:/etc/marktrack.d/custom_rules.nft

# LuCI frontend
ssh $ROUTER 'mkdir -p /usr/libexec/rpcd /usr/share/luci/menu.d /usr/share/rpcd/acl.d /www/luci-static/resources/view/marktrack'
scp luci-app-marktrack/root/usr/libexec/rpcd/luci.marktrack \
    luci-app-marktrack/root/usr/libexec/rpcd/luci.marktrack_stats        $ROUTER:/usr/libexec/rpcd/
scp luci-app-marktrack/root/usr/share/luci/menu.d/luci-app-marktrack.json $ROUTER:/usr/share/luci/menu.d/
scp luci-app-marktrack/root/usr/share/rpcd/acl.d/luci-app-marktrack.json  $ROUTER:/usr/share/rpcd/acl.d/
scp luci-app-marktrack/htdocs/luci-static/resources/view/marktrack/*.js   $ROUTER:/www/luci-static/resources/view/marktrack/

# Permissions, enable, and start
ssh $ROUTER 'chmod 755 /etc/marktrack.sh /etc/init.d/marktrack /usr/libexec/rpcd/luci.marktrack /usr/libexec/rpcd/luci.marktrack_stats'
ssh $ROUTER '/etc/init.d/marktrack enable && /etc/init.d/marktrack start'
ssh $ROUTER '/etc/init.d/rpcd restart && /etc/init.d/uhttpd restart'   # register the RPC + web UI
```

### Verify

```sh
/etc/init.d/marktrack health_check      # checks the nftables table, chain, and ct mark rule
nft list table inet marktrack           # inspect the applied ruleset
```

Then open **LuCI → Network → Mark and Track** in your browser. For version-specific notes (21.02 / 22.03 / 23.05) and a deeper walkthrough, see [`DOCS.md`](DOCS.md).

## Architecture & How It Works

Mark and Track is composed of two packages:
1. **`marktrack`** (Backend): Generates and applies the `nftables` rules.
2. **`luci-app-marktrack`** (Frontend): The LuCI web interface and its backend RPC endpoints.

### 1. Packet Marking Pipeline (`marktrack.sh`)

When the `marktrack` service starts, the `/etc/marktrack.sh` script reads the `/etc/config/marktrack` UCI configuration. It translates your IP sets, rules, and custom rules into a single `nftables` table named `marktrack`.

The generated `nftables` chain evaluates traffic at a configurable netfilter hook (default: `forward` at priority `0`). 

Crucially, at the end of the chain, the script adds the following rules:
```nftables
ct mark set ip  dscp or 128 counter;
ct mark set ip6 dscp or 128 counter;
```
This takes the final DSCP value of the packet, performs a bitwise OR with `128` (setting the 8th bit to mark it as processed by Mark and Track), and saves it into the connection tracking state (`ct mark`). 

### 2. Connection Tracking (`luci.marktrack` rpcd)

The LuCI frontend needs to display live connection data. OpenWrt uses `rpcd` (ubus) for frontend-to-backend communication.

The `luci.marktrack` Lua script reads `/proc/net/nf_conntrack` directly. For every active connection, it extracts the IP addresses, ports, protocol, transferred bytes, and the `ct mark`.

It reverses the encoding logic (`dscp = mark & 0x3F`) to extract the exact DSCP number from the connection, maps it to a human-readable label (e.g., `40` -> `CS5`), and sends this data back to the browser as JSON.

### 3. Web Interface (`luci-app-marktrack`)

The frontend is built using LuCI's modern JavaScript framework. It provides four main pages under **Network > Mark and Track** (or your LuCI's equivalent submenu):
- **DSCP Rules**: A form to configure UCI rules. It polls the `luci.marktrack_stats` RPC endpoint to show live packet/byte hit counters next to each rule.
- **IP Sets**: Define static or dynamic sets.
- **Custom Rules**: A text editor for raw `nftables` rules with built-in syntax validation.
- **Connections**: A live, sortable, and filterable table polling every second. It calculates live bandwidth client-side by comparing the byte counters between polls.

## Directory Structure

```text
marktrack/
├── Makefile                                # OpenWrt package Makefile for the backend
├── etc/
│   ├── config/
│   │   └── marktrack                       # UCI Configuration file
│   ├── init.d/
│   │   └── marktrack                       # Service init script (start/stop/reload)
│   ├── marktrack.d/
│   │   └── custom_rules.nft                # Raw user-defined nftables rules
│   └── marktrack.sh                        # Core script that compiles UCI to nftables
│
└── luci-app-marktrack/                     # Frontend Package
    ├── Makefile                            # OpenWrt package Makefile for the frontend
    ├── htdocs/luci-static/resources/view/marktrack/
    │   ├── connections.js                  # Live connection viewer UI
    │   ├── custom_rules.js                 # Custom raw rules editor UI
    │   ├── ipsets.js                       # IP sets editor UI
    │   └── rules.js                        # DSCP Rules editor UI
    └── root/
        ├── usr/libexec/rpcd/
        │   ├── luci.marktrack              # Lua backend: Parses nf_conntrack for the UI
        │   └── luci.marktrack_stats        # Shell backend: Fetches nftables rule counters
        └── usr/share/
            ├── luci/menu.d/
            │   └── luci-app-marktrack.json # Registers the app in the LuCI navigation menu
            └── rpcd/acl.d/
                └── luci-app-marktrack.json # Grants LuCI permission to read/write config and call RPCs
```

## Configuration Reference (`/etc/config/marktrack`)

```uci
config global 'global'
	option enabled '1'

config settings 'settings'
	option NFT_HOOK 'forward'       # Hook point: forward, prerouting, postrouting, etc.
	option NFT_PRIORITY '0'         # Priority within the hook
	option MAX_CONNECTIONS '0'      # Cap for the Connections UI (0 = unlimited)

config custom_rules 'custom_rules'  # Enables the inclusion of custom_rules.nft

# Example Rule
# config rule 'gaming'
# 	option name 'gaming'
# 	option proto 'udp'
# 	option src_ip '192.168.1.50'
# 	option dest_port '30000-65535'
# 	option class 'cs5'
# 	option counter '1'
# 	option enabled '1'

# Example IP Set
# config ipset
# 	option name 'gaming_devices'
# 	option mode 'static'
# 	option family 'ipv4'
# 	list ip4 '192.168.1.50'
# 	list ip4 '192.168.1.51'
# 	option enabled '1'
```
