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
