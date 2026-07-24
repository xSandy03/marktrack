# marktrack — Technical Documentation

> **Version:** 1.0.0  
> **License:** GPL-3.0-or-later  
> **Platform:** OpenWrt (nftables, conntrack)

---

## Table of Contents

1. [Project Goal](#1-project-goal)
2. [Architecture Overview](#2-architecture-overview)
3. [Data Flow](#3-data-flow)
4. [Directory & File Reference](#4-directory--file-reference)
5. [Component Deep-Dive](#5-component-deep-dive)
   - 5.1 [Backend — marktrack.sh](#51-backend--marktrackshetc)
   - 5.2 [Init Script — /etc/init.d/marktrack](#52-init-script--etcinitdmarktrack)
   - 5.3 [UCI Config — /etc/config/marktrack](#53-uci-config--etcconfigmarktrack)
   - 5.4 [Custom Rules File](#54-custom-rules-file)
   - 5.5 [Lua RPC — luci.marktrack](#55-lua-rpc--lucimarktrack)
   - 5.6 [Shell RPC — luci.marktrack_stats](#56-shell-rpc--lucimarktrack_stats)
   - 5.7 [LuCI Views](#57-luci-views)
   - 5.8 [Package Makefiles](#58-package-makefiles)
   - 5.9 [ACL & Menu](#59-acl--menu)
6. [DSCP Encoding Scheme](#6-dscp-encoding-scheme)
7. [Hook Points & Marking Positions](#7-hook-points--marking-positions)
8. [Installation Guide](#8-installation-guide)
9. [Configuration Reference](#9-configuration-reference)
10. [Change Impact Reference](#10-change-impact-reference)
11. [Bugs Found & Historical Record](#11-bugs-found--historical-record)
12. [Version 0.2 Changes](#12-version-02-changes)
13. [Version 0.2.1 Changes](#13-version-021-changes)
14. [Version 0.2.2 Changes](#14-version-022-changes)
15. [Version 0.3 Changes](#15-version-03-changes)
16. [Version 0.3.1 Changes](#16-version-031-changes)

---

## 1. Project Goal

marktrack has two primary objectives:

1. **Mark packets with DSCP tags** at any configurable netfilter hook point inside OpenWrt, using `nftables` rules generated from a UCI configuration.
2. **Track and view statistics** — use conntrack (`nf_conntrack`) to associate each active connection with its DSCP mark and expose live bandwidth/packet counters through a LuCI web interface.

marktrack is a focused fork of [QoSmate](https://github.com/hudra0/qosmate), stripped of all traffic-shaping (TC/CAKE/HFSC), autorate, and complex QoS logic. It is a **pure marking and tracking layer** — it does not shape or schedule traffic itself.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  OpenWrt Router                                                     │
│                                                                     │
│  ┌──────────────────┐    UCI Config        ┌────────────────────┐  │
│  │  /etc/init.d/    │ ──read──────────────▶│ /etc/config/       │  │
│  │  marktrack       │                       │ marktrack          │  │
│  │  (procd service) │                       └────────────────────┘  │
│  └────────┬─────────┘                                               │
│           │ exec                                                     │
│           ▼                                                         │
│  ┌──────────────────┐    nft -f            ┌────────────────────┐  │
│  │  /etc/           │ ─────────────────────▶│  inet marktrack    │  │
│  │  marktrack.sh    │                       │  (nftables table)  │  │
│  │  (rule compiler) │                       │                    │  │
│  └──────────────────┘                       │  chain marktrack   │  │
│           │                                 │  hook: forward     │  │
│           │ include                         │  ├─ DSCP rules     │  │
│  ┌────────▼─────────┐                       │  ├─ custom rules   │  │
│  │  custom_rules    │                       │  └─ ct mark ← DSCP│  │
│  │  .nft            │                       │                    │  │
│  └──────────────────┘                       └────────┬───────────┘  │
│                                                      │              │
│                                              conntrack stores        │
│                                              ct mark = dscp | 128   │
│                                                      │              │
│  ┌───────────────────────────────────────────────────▼───────────┐ │
│  │  /proc/net/nf_conntrack  (kernel conntrack table)             │ │
│  └───────────────────────────────────────────────────┬───────────┘ │
│                                                      │              │
│           ┌──────────────────────────────────────────┘              │
│           ▼                                                         │
│  ┌──────────────────┐   ubus/rpcd        ┌─────────────────────┐  │
│  │  luci.marktrack  │ ◀──────────────────│  LuCI Web UI        │  │
│  │  (shell+awk rpcd)│                    │  connections.js      │  │
│  │                  │ ──JSON─────────────▶│  (dropdown interval)│  │
│  └──────────────────┘                    └─────────────────────┘  │
│                                                                     │
│  ┌──────────────────┐   ubus/rpcd        ┌─────────────────────┐  │
│  │  luci.marktrack  │ ◀──────────────────│  rules.js           │  │
│  │  _stats (sh)     │                    │  (polls every 8s)   │  │
│  │                  │ ──JSON─────────────▶│  (rule counters)    │  │
│  └──────────────────┘                    └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Flow

### 3.1 Startup / Rule Application

```
/etc/init.d/marktrack start
  │
  ├─ config_load 'marktrack'        — reads UCI config into shell vars
  ├─ check global.enabled
  └─ exec /etc/marktrack.sh
       │
       ├─ config_load 'marktrack'
       ├─ read settings: NFT_HOOK, NFT_PRIORITY
       │
       ├─ generate_dynamic_nft_rules()
       │    └─ foreach UCI rule section → create_nft_rule()
       │         ├─ separate IPs into v4/v6 buckets
       │         ├─ build proto/port/addr match expressions
       │         └─ emit: <match> ip dscp set <class> [counter] [comment]
       │
       ├─ validate /etc/marktrack.d/custom_rules.nft via nft --check
       │    └─ if valid: set INLINE_INCLUDE="include ..."
       │
       ├─ write /tmp/marktrack/marktrack.nft  (full nft table definition)
       │
       └─ nft -f /tmp/marktrack/marktrack.nft
            └─ applies: table inet marktrack
                 └─ chain marktrack (hook forward priority 0)
                      ├─ iif "lo" accept
                      ├─ [UCI DSCP rules]
                      ├─ [custom rules include]
                      └─ ct mark set ip  dscp or 128 counter
                         ct mark set ip6 dscp or 128 counter
```

### 3.2 Packet Path (Runtime)

```
Incoming packet → netfilter hook (forward by default)
  │
  └─ chain marktrack evaluates rules top-to-bottom
       ├─ Rule match? → ip dscp set <class>   (sets DSCP in packet header)
       └─ End of chain:
            ct mark = (packet DSCP value) | 128
            (128 = bit 7 = "marked by marktrack" flag)
            → stored in conntrack entry for lifetime of connection
```

### 3.3 Connections UI Polling

```
Browser → ubus call luci.marktrack getConntrackDSCP
  │
  └─ luci.marktrack (shell + awk)
       ├─ open /proc/net/nf_conntrack
       ├─ parse each line: proto, src, dst, sport, dport, bytes, packets, mark
       ├─ decode DSCP: dscp = mark & 0x3F  (strips marktrack bit 7)
       └─ return JSON { connections: { key: {...} }, max_connections: N }

Browser receives JSON → updateTable()
  ├─ compute Δbytes/Δtime between polls → bandwidth
  ├─ maintain history[] → rolling averages (avgPps, avgBps)
  └─ render table rows
```

### 3.4 Rule Counter Polling

```
Browser → ubus call luci.marktrack_stats getRuleCounters
  │
  └─ luci.marktrack_stats (shell)
       ├─ nft -j list table inet marktrack
       └─ jq: extract rules with comment field + counter expression
            └─ return { rule_counters: [ { name, packets, bytes } ] }
```

---

## 4. Directory & File Reference

```
marktrack/
├── Makefile                              — Backend OpenWrt package definition
├── README.md                             — Project summary
├── DOCS.md                               — This file
│
├── etc/
│   ├── config/
│   │   └── marktrack                    — UCI configuration (persistent settings)
│   ├── init.d/
│   │   └── marktrack                    — procd init script (start/stop/reload/health_check)
│   ├── marktrack.d/
│   │   └── custom_rules.nft             — User-defined raw nftables rules (chain-level)
│   └── marktrack.sh                     — Core script: UCI → nftables compiler
│
└── luci-app-marktrack/
    ├── Makefile                          — Frontend OpenWrt package definition
    ├── htdocs/luci-static/resources/
    │   ├── view/marktrack/
    │   │   ├── connections.js           — Live connections dashboard
    │   │   ├── custom_rules.js          — Raw nftables rule editor
    │   │   └── rules.js                 — DSCP rule manager with live counters
    │   └── marktrack/
    │       └── marktrack.css            — Shared "network-ops console" design system
    └── root/
        ├── usr/libexec/rpcd/
        │   ├── luci.marktrack           — Lua: conntrack parser → JSON
        │   └── luci.marktrack_stats     — Shell: nft JSON counter extractor
        └── usr/share/
            ├── luci/menu.d/
            │   └── luci-app-marktrack.json  — LuCI navigation registration
            └── rpcd/acl.d/
                └── luci-app-marktrack.json  — rpcd access control list
```

---

## 5. Component Deep-Dive

### 5.1 Backend — `marktrack.sh`

**Path:** `/etc/marktrack.sh`  
**Role:** The core UCI-to-nftables compiler. Reads UCI config, generates a full `nftables` table definition, validates it, and applies it atomically via `nft -f`.

**Key functions:**

| Function | Purpose |
|---|---|
| `generate_dynamic_nft_rules()` | Iterates `rule` UCI sections → calls `create_nft_rule()` for each. Skips if `global.enabled=0`. |
| `create_nft_rule()` | The most complex function. Parses a single UCI rule, separates IPs into IPv4/IPv6 buckets, generates separate v4 and v6 nft match expressions, emits one or two `ip/ip6 dscp set <class>` rules. |
| `gen_rule()` | Sub-function inside `create_nft_rule`. Builds a single nft match clause for a given prefix (`ip saddr`, `th dport`, etc.) from a list of values. Handles negation (`!=`), IPv6 suffix masks (`::suffix/::mask`), and mixed IP lists. |
| `is_ipv6_mask()` | Returns true if value matches `::X/::Y` format. |
| `is_ipv6()` | Returns true if value contains `:` (IPv6 or CIDR). |
| `separate_ips_by_family()` | Splits a space-separated IP list into two output variables: IPv4 bucket and IPv6 bucket. |

**DSCP ct mark encoding:**
```sh
ct mark set ip  dscp or 128 counter;
ct mark set ip6 dscp or 128 counter;
```
Meaning: take the packet's current DSCP value (0–63), OR it with 128 (sets bit 7), store as `ct mark`. Bit 7 is the "marktrack flag" — the UI uses this to distinguish marktrack-tagged connections from other conntrack marks. DSCP is recovered as `mark & 0x3F` (lower 6 bits).

**Custom rules validation:**  
Before including `custom_rules.nft`, the script wraps it in a throw-away table/chain and runs `nft --check`. If syntax is invalid, the file is silently excluded and a warning is logged. This protects the main ruleset from bad user input.

**nft file lifecycle:**
1. Written to `/tmp/marktrack/marktrack.nft`
2. Applied via `nft -f`
3. Deleted after successful apply (no temp file left behind)

**Concrete UCI → nftables translation example:**

Given this UCI config:
```uci
config settings 'settings'
    option NFT_HOOK 'forward'
    option NFT_PRIORITY '0'

config rule 'gaming'
    option name 'gaming'
    option proto 'udp'
    list src_ip '192.168.1.50'
    list src_ip '192.168.1.51'
    option dest_port '27000-65535'
    option class 'cs5'
    option counter '1'
    option enabled '1'
```

`marktrack.sh` generates and applies this nftables table:
```nftables
table inet marktrack

delete table inet marktrack

table inet marktrack {

    chain marktrack {
        type filter hook forward priority 0; policy accept;

        iif "lo" accept;

        meta l4proto udp ip saddr { 192.168.1.50,192.168.1.51 } th dport { 27000-65535 } ip dscp set cs5 counter comment "ipv4_gaming";

        ct mark set ip  dscp or 128 counter;
        ct mark set ip6 dscp or 128 counter;
    }
}
```

Key translation rules:
- `proto udp` → `meta l4proto udp`
- `src_ip '192.168.1.50' '192.168.1.51'` → `ip saddr { 192.168.1.50,192.168.1.51 }` (family detected per address)
- `dest_port '27000-65535'` → `th dport { 27000-65535 }`
- `class 'cs5'` → `ip dscp set cs5`
- `counter '1'` → appends `counter`
- `name 'gaming'` → appends `comment "ipv4_gaming"` (prefixed with `ipv4_` or `ipv6_`)
- IPv6 rule would emit `ip6 dscp set cs5 comment "ipv6_gaming"` separately if IPv6 addresses were present

---

### 5.2 Init Script — `/etc/init.d/marktrack`

**Inherits:** `/etc/rc.common` with `USE_PROCD=1`  
**Start order:** `START=95 STOP=95` (late in boot, after network)

| Command | Behavior |
|---|---|
| `start` | Checks `global.enabled`, execs `marktrack.sh`, registers one-shot procd instance (using `/bin/true` as the command — keeps procd satisfied while the real work is done by the shell script). |
| `stop` | Runs `nft delete table inet marktrack` (idempotent, ignores error if table absent). |
| `reload` | Calls `stop_service` then `start_service`. |
| `validate_custom_rules` | Wraps `custom_rules.nft` in a dummy table/chain, runs `nft --check --file`, reports OK or errors to stdout. |
| `health_check` | Verifies: (1) table exists, (2) marktrack chain present, (3) `ct mark set` rule present, (4) reports active DSCP rule count. |

**Note on procd one-shot pattern:** The `procd_open_instance` / `procd_set_param command /bin/true` / `procd_close_instance` sequence registers a service instance that immediately exits. This is a standard OpenWrt pattern for scripts that do their work during startup and do not run as persistent daemons.

---

### 5.3 UCI Config — `/etc/config/marktrack`

Three section types exist:

**`config global 'global'`**

| Option | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | bool | `1` | Master on/off switch |

**`config settings 'settings'`**

| Option | Type | Default | Meaning |
|---|---|---|---|
| `NFT_HOOK` | string | `forward` | Netfilter hook point (see §7) |
| `NFT_PRIORITY` | int | `0` | Hook priority within the chain |
| `MAX_CONNECTIONS` | int | `0` | Cap for connections UI (0 = unlimited) |

**`config rule '<name>'`**

| Option | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Human-readable name; used as nft rule comment (`ipv4_<name>` / `ipv6_<name>`) |
| `enabled` | bool | — | Default `1`. Set `0` to disable without deleting |
| `proto` | string | — | Protocol(s): `tcp`, `udp`, `icmp`, `ipv6-icmp` (space-separated) |
| `src_ip` | list | — | Source IP(s)/CIDR(s), or `::suffix/::mask`. Prefix with `!=` to negate |
| `dest_ip` | list | — | Destination IP(s)/CIDR(s) (same formats as src_ip) |
| `src_port` | list | — | Source port(s) or ranges (e.g., `80`, `8000-9000`) |
| `dest_port` | list | — | Destination port(s) or ranges |
| `class` | string | yes | DSCP class: `ef`, `cs5`, `cs4`, `af41`, `af42`, `cs2`, `cs1`, `cs0`, etc. |
| `counter` | bool | — | If `1`, adds `counter` to the nft rule → enables live hit counters in UI |
| `trace` | bool | — | If `1`, adds `meta nftrace set 1` → enables nft tracing for this rule (debug only) |

---

### 5.4 Custom Rules File

**Path:** `/etc/marktrack.d/custom_rules.nft`  
**Format:** Standard nftables **chain-level statements** (no `table` or `chain` declaration).  
**Position in chain:** After all UCI-defined DSCP rules, before the `ct mark` encoding rules.

Example:
```nftables
meta l4proto tcp th dport 443 ip dscp set cs4 counter comment "HTTPS priority";
ip saddr 10.0.0.5 ip dscp set ef comment "VoIP phone";
```

Validate with: `/etc/init.d/marktrack validate_custom_rules`  
Apply with: `/etc/init.d/marktrack reload`

---

### 5.5 Shell RPC — `luci.marktrack`

**Path:** `/usr/libexec/rpcd/luci.marktrack`  
**Language:** POSIX shell + `awk` (busybox-compatible) — **no `lua` / `luci-lib-jsonc` dependency**  
**Protocol:** Standard rpcd exec-plugin `list` / `call <method>` argv protocol  
**Method:** `getConntrackDSCP`

> **v0.2 note:** This backend was originally Lua (requiring `lua` + `luci-lib-jsonc`). On apk-based OpenWrt (24.10+) those packages are not installed by default, which caused the Connections page to fail with "No connection data received". It was rewritten in shell + `awk` (matching the sibling `luci.marktrack_stats`) so it runs with only busybox present.

**What it does:**
1. Reads UCI `marktrack.settings.MAX_CONNECTIONS` via `uci -q get` subprocess
2. Opens `/proc/net/nf_conntrack` line by line
3. For each line: parses `layer3`, `protocol`, `timeout`, `src`, `dst`, `sport`, `dport`, `in_packets`, `in_bytes`, `out_packets`, `out_bytes`, `mark`
4. Decodes DSCP: `dscp = mark % 64` (= `mark & 0x3F`)
5. Maps DSCP number to label via hardcoded table
6. Returns JSON keyed by `protocol_src_sport_dst_dport`

**Exact `/proc/net/nf_conntrack` line format:**

The Lua parser reads this file directly. Each line represents one tracked connection. Understanding the format is essential for any agent modifying the parser.

TCP/UDP line (two directions — original then reply):
```
ipv4     2 tcp      6 86399 ESTABLISHED src=192.168.1.50 dst=1.2.3.4 sport=54321 dport=443 packets=100 bytes=5000 src=1.2.3.4 dst=192.168.1.50 sport=443 dport=54321 packets=80 bytes=3000 [ASSURED] mark=168 zone=0 use=2
│        │ │         │ │     │           ──────── direction 1 ────────────────────────────── ──────── direction 2 ──────────────────────────────            │
│        │ │         │ │     └─ TCP state (ESTABLISHED, SYN_SENT, TIME_WAIT, etc.)           └─ reply direction                                             └─ ct mark (dscp=40, 40|128=168)
│        │ │         │ └─ timeout in seconds remaining
│        │ └─ proto name
│        └─ L4 proto number (6=TCP, 17=UDP, 1=ICMP)
└─ L3 family (ipv4 / ipv6)
```

ICMP line (two directions — request then reply):
```
ipv4     2 icmp     1 29 src=192.168.1.1 dst=8.8.8.8 type=8 code=0 id=1 packets=5 bytes=500 src=8.8.8.8 dst=192.168.1.1 type=0 code=0 id=1 packets=5 bytes=500 mark=128 zone=0 use=2
```

IPv6 TCP line (same structure, `ipv6` prefix, IPv6 addresses):
```
ipv6    10 tcp      6 86399 ESTABLISHED src=2001:db8::1 dst=2606:4700::1 sport=54321 dport=443 packets=10 bytes=800 src=2606:4700::1 dst=2001:db8::1 sport=443 dport=54321 packets=8 bytes=600 [ASSURED] mark=168 zone=0 use=2
```

Fields extracted by the parser and their destinations in the returned JSON:

| Raw field | Regex capture | JSON field | Notes |
|---|---|---|---|
| `ipv4`/`ipv6` | `layer3` | not returned | Used internally only |
| `tcp`/`udp`/`icmp` | `protocol` | `protocol` | |
| timeout number | `timeout` | `timeout` | Seconds remaining |
| dir1 `src=` | `src` | `src` | Original source IP |
| dir1 `dst=` | `dst` | `dst` | Original destination IP |
| dir1 `sport=` | `sport` | `sport` | |
| dir1 `dport=` | `dport` | `dport` | |
| dir1 `packets=` | `in_packets` | `in_packets` | |
| dir1 `bytes=` | `in_bytes` | `in_bytes` | |
| dir2 `packets=` | `out_packets` | `out_packets` | |
| dir2 `bytes=` | `out_bytes` | `out_bytes` | |
| `mark=` | `mark` | `mark` | Raw ct mark |
| derived | `dscp = mark & 0x3F` | `dscp` | Numeric DSCP value |
| derived | `dscp_to_label(dscp)` | `dscp_label` | Human-readable string |
| derived | `in_bytes + out_bytes` | `bytes` | Total both directions |
| derived | `in_packets + out_packets` | `packets` | Total both directions |

**DSCP label map (both Lua and JS maintain this — must be kept in sync):**

| Value | Label | Meaning |
|---|---|---|
| 0 | CS0 | Best Effort |
| 8 | CS1 | Background/Bulk |
| 10–14 | AF11–AF13 | Low-priority data |
| 16 | CS2 | OAM |
| 18–22 | AF21–AF23 | High-throughput data |
| 24 | CS3 | Broadcast video |
| 26–30 | AF31–AF33 | Multimedia streaming |
| 32 | CS4 | Real-time interactive |
| 34–38 | AF41–AF43 | Multimedia conferencing |
| 40 | CS5 | Signaling |
| 46 | EF | Expedited Forwarding (VoIP, gaming) |
| 48 | CS6 | Network control |
| 56 | CS7 | Network control (highest) |

---

### 5.6 Shell RPC — `luci.marktrack_stats`

**Path:** `/usr/libexec/rpcd/luci.marktrack_stats`  
**Protocol:** Standard rpcd shell dispatch (`list` / `call` subcommands)  
**Method:** `getRuleCounters`

**What it does:**
1. Checks `jq` is available and the `inet marktrack` table exists
2. Runs `nft -j list table inet marktrack` → gets JSON representation of the entire table
3. Pipes through `jq` to extract rules that have:
   - A `comment` field (= rule name, e.g. `ipv4_gaming`)
   - A `counter` expression in their `expr` array
4. Returns: `{ "rule_counters": [ { "name": "ipv4_gaming", "packets": N, "bytes": N } ] }`

**Dependency:** Requires `jq` and `nftables` compiled with JSON support (`nft -j`). The `jq` package is declared as a dependency in the frontend Makefile.

---

### 5.7 LuCI Views

All three views live under **`admin/network/marktrack/`** — i.e. marktrack appears inside the **Network** menu, and its three sections render as LuCI's native content tabs (no separate top-level menu, no custom nav bar).

**Shared design system — `resources/marktrack/marktrack.css`:** All three views share one stylesheet, loaded once via an injected `<link>` (a small idempotent `injectCss()` helper in each view; the `<link>` is cached by the browser after first load). It defines a self-contained dark "network-ops console" theme, **scoped entirely under `.mt-app`** so it never leaks into the rest of the LuCI admin skin. Each view wraps its root node in `<div class="mt-app">`. The single accent, the surface colors, and the per-class **DSCP signal hues** (`.mt-sig--ef`, `.mt-sig--cs5`, …, which set a `--sig` CSS variable consumed by both the DSCP tags and the transfer bars) all live here — so re-theming means editing one file. No web fonts or external assets are referenced (system font stack only), keeping it offline-safe and light on low-spec hardware.

#### `rules.js` — DSCP Rules

- Renders a `form.GridSection` over all `rule` UCI sections, wrapped in the themed `.mt-app` panel
- **DSCP Class Reference:** rendered as colored **signal-tag cards** (`.mt-ref`) — each class shown as its tag + typical use — instead of a plain table
- **Live counters:** Polls `luci.marktrack_stats` every 8 seconds, updates an "Activity" column (`.mt-activity`) with packet counts
- **Save & Apply:** Saves UCI → applies changes → restarts marktrack service
- **IP validation:** Validates IPv4/IPv6/CIDR, `::suffix/::mask` format, negation prefix `!=`
- **Multi-protocol:** Proto field is a `MultiValue`, stored as space-separated string in UCI

#### `custom_rules.js` — Custom Rules

- One text area: **Custom nftables Rules** — chain-level nftables statements saved directly to `/etc/marktrack.d/custom_rules.nft`
- **Validate** button: writes current textarea content to disk, calls `/etc/init.d/marktrack validate_custom_rules`, reads back `/tmp/marktrack_custom_rules_validation.txt` and displays pass/fail inline
- **Erase** button: writes empty string to `custom_rules.nft`, applies changes, reloads service
- **Save & Apply:** saves file, calls `validate_custom_rules`, then restarts marktrack via `luci.setInitAction`
- File format constraint: content must be chain-level statements only — no `table` or `chain` wrapper. The backend (`marktrack.sh`) includes this file inline inside the `marktrack` chain body.

#### `connections.js` — Live Connections

- **Layout:** a fully custom `.mt-app` dashboard — title bar with a live/paused status dot, a row of **stat chips** (active flows, aggregate throughput, marked count, top DSCP class), a toolbar, then the flow table
- **DSCP as signal tags:** each row's class renders as a colored `.mt-tag`; the row carries a `.mt-sig--<token>` class so the tag **and** the mini **transfer bar** (`.mt-bar`, width ∝ share of the largest flow) share one hue
- **Columns:** Protocol, Source, Destination, DSCP, **Transfer** (bar + total bytes), Packets, Avg PPS, Avg BPS — all sortable
- **Polling:** fixed interval chosen from a **segmented control** (1 s / 3 s / 10 s / 30 s / 1 min, default 3 s) plus Pause/Resume — no adaptive logic
- **Rate calculation:** per-connection **exponential moving average** (EMA) of pps/bps from the byte/packet delta between polls — cheap, no per-connection sample arrays
- **Rendering:** rows are built into a single `DocumentFragment` and swapped in one `replaceChildren` call per poll (one reflow → smooth, low CPU)
- **Memory:** per-connection rate state is dropped as soon as a flow disappears from conntrack
- **Filter:** multi-token AND filter across protocol, src:sport, dst:dport, DSCP label
- **Backend:** `luci.marktrack` (shell + awk); the view stops its timer when navigated away

---

### 5.8 Package Makefiles

**`marktrack/Makefile`** — Backend package:
- Section: `net`, Category: `Network`
- Runtime deps: `kmod-nf-conntrack`, `nftables`
- Installs: `marktrack.sh` (executable), `init.d/marktrack` (executable), `config/marktrack` (conffile), `marktrack.d/custom_rules.nft` (conffile)
- No build step (pure shell/config package)

**`luci-app-marktrack/Makefile`** — Frontend package:
- Uses `luci.mk` build system
- Runtime deps: `marktrack`, `jq`
- Installs: menu JSON, ACL JSON, two rpcd scripts (executable), three JS view files, and the shared `marktrack.css` design system

---

### 5.9 ACL & Menu

**`luci-app-marktrack.json` (ACL)** — grants the LuCI web session:

| Permission | Resource |
|---|---|
| read ubus | `luci.marktrack:getConntrackDSCP`, `luci.marktrack_stats:getRuleCounters` |
| read uci | `marktrack` config |
| read file | `/etc/marktrack.d/custom_rules.nft`, `/proc/net/nf_conntrack` |
| write uci | `marktrack` config |
| write file | `/etc/marktrack.d/custom_rules.nft` |
| write ubus | `luci:setInitAction` |

**`luci-app-marktrack.json` (menu)** — registers marktrack **under the Network menu** (`admin/network/marktrack`, title `marktrack`, `firstchild`) with three child views that render as native tabs:

| Menu node | View path | Order |
|---|---|---|
| `admin/network/marktrack/rules` | `marktrack/rules` | 10 |
| `admin/network/marktrack/custom_rules` | `marktrack/custom_rules` | 30 |
| `admin/network/marktrack/connections` | `marktrack/connections` | 40 |

---

## 6. DSCP Encoding Scheme

marktrack uses a specific bit encoding for conntrack marks to coexist with other tools that may also write `ct mark`:

```
ct mark bit layout (32-bit value):

Bit:  31 ... 8  |  7  |  6  5  4  3  2  1  0
      (unused)  | MT  |     DSCP value (0-63)

MT  = "marktrack flag" (bit 7 = 128)
DSCP = 6-bit DSCP value (0-63)
```

**Encoding:** `ct mark = dscp_value | 128`  
**Decoding:** `dscp_value = ct mark & 0x3F` (lower 6 bits, ignoring bit 7)

The `128` flag lets the Connections UI distinguish:
- `mark & 128 == 128` → connection was processed by marktrack (even if DSCP=0/CS0)
- `mark == 0` → connection was NOT processed by marktrack

Currently the UI does not filter on this flag (it shows all connections regardless), but the field is available in the data (`conn.mark`) for future filtering.

---

## 7. Hook Points & Marking Positions

The `NFT_HOOK` setting controls WHERE in the packet path DSCP marking occurs. This is the core "mark at any point" capability.

```
Ingress (packets arriving at router)
  │
  ├─ prerouting   ← HOOK OPTION: mark before routing decision
  │                  Use: mark traffic destined for ANY interface (LAN/WAN/router)
  │                  Note: ct mark persists to conntrack here
  │
  ├─ [routing decision]
  │
  ├─ forward      ← HOOK OPTION (DEFAULT): mark transit traffic only
  │                  Use: traffic passing THROUGH the router (LAN→WAN, WAN→LAN)
  │                  Does NOT catch traffic TO/FROM the router itself
  │
  ├─ input        ← mark traffic destined FOR the router
  │                  (SSH, DNS responses, web UI traffic)
  │
  └─ output       ← mark traffic ORIGINATING FROM the router
                     (DNS queries, NTP, router-generated traffic)

Egress
  └─ postrouting  ← HOOK OPTION: mark after routing, before sending out
                     Use: final DSCP override before packet leaves
```

**Choosing the right hook:**

| Goal | Recommended Hook | Priority |
|---|---|---|
| Mark forwarded LAN↔WAN traffic | `forward` | `0` |
| Mark ALL traffic including router-to-router | `prerouting` | `0` (mangle) |
| Mark before existing QoS/mangle rules | `prerouting` | `-100` |
| Mark after other rules have run | `forward` | `10` |
| Mark egress from router itself | `output` | `0` |

**Warning:** Setting hook to `input` or `output` affects traffic to/from the router process itself. Setting `postrouting` may conflict with MASQUERADE rules. Test carefully.

---

## 8. Installation Guide

### 8.1 Prerequisites

| Requirement | Minimum Version | Notes |
|---|---|---|
| OpenWrt | 21.02 | nftables available since 21.02 |
| nftables | 1.0.0+ | Replaces iptables in OpenWrt 22.03+ |
| kmod-nf-conntrack | kernel module | Usually pre-installed |
| jq | 1.6+ | Required for rule counters only |
| lua | 5.1 | Required for conntrack UI |
| luci-lib-jsonc | any | Required for LuCI rpcd |

> **OpenWrt 21.02:** nftables is available but iptables is still the default. You may need to manually install `nftables` and ensure `kmod-nf-conntrack` is loaded.
> **OpenWrt 22.03+:** nftables is the default firewall backend. marktrack integrates cleanly.
> **OpenWrt 23.05+:** Fully supported. Use this version for best compatibility.

---

### 8.2 Method A — Install from Source (SDK / buildroot)

Use this method for production deployments or when building a firmware image.

**Step 1 — Set up OpenWrt SDK**
```bash
# Download the SDK for your target platform from downloads.openwrt.org
# Example for x86_64 / OpenWrt 23.05.3:
wget https://downloads.openwrt.org/releases/23.05.3/targets/x86/64/openwrt-sdk-23.05.3-x86-64_gcc-12.3.0_musl.Linux-x86_64.tar.xz
tar xf openwrt-sdk-*.tar.xz
cd openwrt-sdk-*/
```

**Step 2 — Add marktrack to the package feed**
```bash
# Option A: Clone directly into package/
git clone https://github.com/xSandy03/marktrack package/marktrack-pkg
# This gives you both packages from one clone

# OR — Option B: Add as a feed (if you publish it as one)
echo "src-git marktrack https://github.com/xSandy03/marktrack.git" >> feeds.conf
./scripts/feeds update marktrack
./scripts/feeds install -a -p marktrack
```

**Step 3 — Configure and build**
```bash
make menuconfig
# Navigate to: Network → marktrack  (enable with M or Y)
# Navigate to: LuCI → Applications → luci-app-marktrack  (enable)
make package/marktrack/compile V=sc
make package/luci-app-marktrack/compile V=sc
```

**Step 4 — Locate and transfer IPKs**
```bash
ls bin/packages/*/base/marktrack*.ipk
ls bin/packages/*/base/luci-app-marktrack*.ipk

# Transfer to router:
scp bin/packages/*/base/marktrack*.ipk root@192.168.1.1:/tmp/
scp bin/packages/*/base/luci-app-marktrack*.ipk root@192.168.1.1:/tmp/
```

**Step 5 — Install on router**
```bash
ssh root@192.168.1.1
opkg install /tmp/marktrack*.ipk /tmp/luci-app-marktrack*.ipk
```

---

### 8.3 Method B — Manual Install (Development / Testing)

Use this when you want to install files directly without building IPKs. Useful for development iteration.

```bash
# On your development machine:
ROUTER=root@192.168.1.1

# Create directories
ssh $ROUTER "mkdir -p /etc/marktrack.d /tmp/marktrack"

# Install backend files
scp etc/marktrack.sh                $ROUTER:/etc/marktrack.sh
scp etc/init.d/marktrack            $ROUTER:/etc/init.d/marktrack
scp etc/config/marktrack            $ROUTER:/etc/config/marktrack
scp etc/marktrack.d/custom_rules.nft $ROUTER:/etc/marktrack.d/custom_rules.nft

# Set permissions
ssh $ROUTER "chmod 755 /etc/marktrack.sh /etc/init.d/marktrack"

# Install LuCI frontend files
ssh $ROUTER "mkdir -p \
  /usr/libexec/rpcd \
  /usr/share/luci/menu.d \
  /usr/share/rpcd/acl.d \
  /www/luci-static/resources/view/marktrack \
  /www/luci-static/resources/marktrack"

scp luci-app-marktrack/root/usr/libexec/rpcd/luci.marktrack \
    luci-app-marktrack/root/usr/libexec/rpcd/luci.marktrack_stats \
    $ROUTER:/usr/libexec/rpcd/

scp luci-app-marktrack/root/usr/share/luci/menu.d/luci-app-marktrack.json \
    $ROUTER:/usr/share/luci/menu.d/

scp luci-app-marktrack/root/usr/share/rpcd/acl.d/luci-app-marktrack.json \
    $ROUTER:/usr/share/rpcd/acl.d/

scp luci-app-marktrack/htdocs/luci-static/resources/view/marktrack/*.js \
    $ROUTER:/www/luci-static/resources/view/marktrack/

scp luci-app-marktrack/htdocs/luci-static/resources/marktrack/marktrack.css \
    $ROUTER:/www/luci-static/resources/marktrack/

ssh $ROUTER "chmod 755 /usr/libexec/rpcd/luci.marktrack /usr/libexec/rpcd/luci.marktrack_stats"
```

**Install runtime dependencies:**
```bash
ssh $ROUTER "opkg update && opkg install kmod-nf-conntrack nftables jq lua luci-lib-jsonc"
```

**Enable and start:**
```bash
ssh $ROUTER "/etc/init.d/marktrack enable && /etc/init.d/marktrack start"
```

**Restart rpcd and LuCI to register the new rpcd scripts:**
```bash
ssh $ROUTER "/etc/init.d/rpcd restart && /etc/init.d/uhttpd restart"
```

---

### 8.4 Post-Install Verification

Run the built-in health check:
```bash
/etc/init.d/marktrack health_check
```

Expected output:
```
── Mark and Track Health Check ──
  [OK] nftables table 'inet marktrack' is active.
  [OK] marktrack chain found.
  [OK] ct mark rule present — connections UI will work.
  [INFO] Active DSCP marking rules: 0
────────────────────────────────
```

Verify the nftables table manually:
```bash
nft list table inet marktrack
```

Check conntrack marks are being applied:
```bash
# Generate some traffic, then:
cat /proc/net/nf_conntrack | awk '{for(i=1;i<=NF;i++) if($i~/mark=/) print $i}' | sort | uniq -c
# mark=128 means CS0 (DSCP=0) marked by marktrack
# mark=168 means CS5 (DSCP=40) marked by marktrack (40|128=168)
```

---

### 8.5 Version-Specific Notes

**OpenWrt 21.02:**
- nftables must be installed manually: `opkg install nftables kmod-nft-core kmod-nft-netdev`
- The firewall is still iptables-based; marktrack runs in parallel without conflict
- `nft -j` JSON output may require `kmod-nft-core` compiled with libnftnl-json

**OpenWrt 22.03:**
- nftables is the default firewall4 backend
- marktrack table `inet marktrack` coexists with `fw4` table `inet fw4`
- No conflicts expected

**OpenWrt 23.05 (Recommended):**
- Full nftables support
- Best compatibility with LuCI modern JS framework
- `jq` available in standard repos

**OpenWrt Snapshot / Main:**
- May have LuCI API changes; test `form.GridSection` and `rpc.declare` behavior
- Monitor for breaking changes in rpcd Lua dispatch

---

### 8.6 Updating From a Previous Version

marktrack keeps all state in `/etc/config/marktrack`; every update path below preserves it.

| Install method | How to update | Notes |
|---|---|---|
| One-line (`uclient-fetch`) | Re-run the installer block from the README | Overwrites backend + views + `marktrack.css` and restarts the service; only fetches `/etc/config/marktrack` if it is missing |
| SDK / IPK | `opkg install --force-reinstall ./luci-app-marktrack_*.ipk ./marktrack_*.ipk` (or `apk add`) | The package manager adds/removes files (e.g. drops `ipsets.js`) automatically |
| Manual (`scp`) | Re-copy the files with the same `scp` commands | Remember the new `resources/marktrack/marktrack.css` |

**Stale-file cleanup (updating from ≤ 0.2 by hand):** the one-line and manual methods only *write* files — they never delete files a newer version dropped. After updating from 0.2, remove the obsolete IP Sets view and reload LuCI:
```bash
rm -f /www/luci-static/resources/view/marktrack/ipsets.js
/etc/init.d/rpcd restart && /etc/init.d/uhttpd restart
```
(IPK updates handle this automatically.)

**Browser cache:** the JS views and `marktrack.css` are static assets the browser caches aggressively. After any update, hard-refresh (Ctrl/Cmd-Shift-R) or the previous UI may persist.

**Config migration 0.2 → 0.3 (IP Sets removed):**
- `config ipset` sections are now ignored — harmless; leave or delete them.
- Rules whose `src_ip`/`dest_ip` used `@setname` will no longer match. Replace the `@setname` entry with the literal IP/CIDR list (an IP field accepts multiple values), e.g. `@gaming_devices` → `192.168.1.50 192.168.1.51`.
- `settings`, `global`, and `rule` section shapes are otherwise unchanged.

Run `/etc/init.d/marktrack health_check` afterward to confirm the table, chain, and ct-mark rule are present.

---

### 8.7 Uninstalling

**IPK / package install:**
```bash
apk del luci-app-marktrack marktrack       # OpenWrt 24.10+ (apk)
opkg remove luci-app-marktrack marktrack   # OpenWrt 23.05 and older (opkg)
```
Package removal leaves `/etc/config/marktrack` (a conffile) in place; delete it manually for a clean slate: `rm -f /etc/config/marktrack`.

**One-line / manual install** (no package database — remove the files directly):
```bash
# 1. Stop the service and tear down the nftables table
/etc/init.d/marktrack stop
/etc/init.d/marktrack disable
nft delete table inet marktrack 2>/dev/null

# 2. Backend
rm -f  /etc/init.d/marktrack /etc/marktrack.sh
rm -rf /etc/marktrack.d /tmp/marktrack
rm -f  /etc/config/marktrack            # omit to keep your configuration

# 3. Frontend (LuCI app)
rm -rf /www/luci-static/resources/view/marktrack
rm -rf /www/luci-static/resources/marktrack
rm -f  /usr/libexec/rpcd/luci.marktrack /usr/libexec/rpcd/luci.marktrack_stats
rm -f  /usr/share/luci/menu.d/luci-app-marktrack.json
rm -f  /usr/share/rpcd/acl.d/luci-app-marktrack.json
rm -f  /tmp/marktrack_custom_rules_validation.txt

# 4. Re-register rpcd + LuCI so the menu entry disappears
/etc/init.d/rpcd restart
/etc/init.d/uhttpd restart
```

**Verify removal:**
```bash
nft list table inet marktrack 2>&1     # → "No such file or directory" = gone
```

---

## 9. Configuration Reference

### 9.1 Quick-Start Example

```uci
# /etc/config/marktrack

config global 'global'
    option enabled '1'

config settings 'settings'
    option NFT_HOOK 'forward'
    option NFT_PRIORITY '0'
    option MAX_CONNECTIONS '500'

# Mark gaming UDP traffic as CS5 (high priority)
config rule 'gaming'
    option name 'gaming'
    option proto 'udp'
    option src_ip '192.168.1.50'
    option dest_port '27000-65535'
    option class 'cs5'
    option counter '1'
    option enabled '1'

# Mark video streaming as CS4
config rule 'streaming'
    option name 'streaming'
    option proto 'tcp'
    list dest_ip '1.2.3.0/24'
    list dest_ip '5.6.7.8'
    option class 'cs4'
    option counter '1'
    option enabled '1'

# Mark a group of gaming devices as CS5 (list multiple source IPs)
config rule 'gaming_devices'
    option name 'gaming_devices'
    list src_ip '192.168.1.50'
    list src_ip '192.168.1.51'
    option class 'cs5'
    option counter '1'
    option enabled '1'
```

### 9.2 Custom Rules Examples

```nftables
# /etc/marktrack.d/custom_rules.nft
# These run inside the marktrack chain, after UCI rules, before ct mark encoding.

# VoIP SIP signaling — Expedited Forwarding
udp dport 5060 ip dscp set ef counter comment "SIP";

# Mark all HTTPS traffic as CS4
tcp dport 443 ip dscp set cs4 counter comment "HTTPS";

# Rate-limit and downgrade bulk TCP
meta l4proto tcp ct bytes > 10000000 ip dscp set cs1 counter comment "Bulk TCP";

# Mark traffic from a specific subnet as low priority
ip saddr 192.168.100.0/24 ip dscp set cs1 counter comment "Guest network bulk";
```

---

## 10. Change Impact Reference

Use this table before making any modification. It maps what you change to everything else that must also change.

| You want to… | Files to change | What to watch for |
|---|---|---|
| **Add a new DSCP class** (e.g., `le`) | `rules.js` (`ListValue` values + `dscpToken`) · `luci.marktrack` (`dscp_to_label` map) · `connections.js` (`DSCP_MAP` + `dscpToken`) · `marktrack.css` (a `.mt-sig--<token>` hue) | The DSCP label maps, the `dscpToken()` copies in both JS views, and the signal-hue class must all agree — otherwise the class shows an uncolored/fallback tag |
| **Re-theme / restyle the UI** | `marktrack.css` only | Everything visual (colors, accent, DSCP signal hues via `--sig`, spacing, tags, bars) lives in this one scoped stylesheet; the three views just emit `.mt-*` class names |
| **Add a new rule match field** (e.g., `ct state`) | `marktrack.sh` (`create_nft_rule` — add match generation) · `etc/config/marktrack` (document new option) · `rules.js` (add form field) | The shell rule builder in `marktrack.sh` and the UCI form in `rules.js` must both know about the new field |
| **Add a new conntrack field to the UI** (e.g., interface, state) | `luci.marktrack` (parse field from `/proc/net/nf_conntrack`, add to returned JSON) · `connections.js` (add table column, update sort function, update connection key if needed) | See conntrack line format in §5.5 for available fields |
| **Add a new rpcd method** | `luci.marktrack` or `luci.marktrack_stats` (implement method) · `luci-app-marktrack.json` (ACL — add ubus read permission) · relevant JS view (declare with `rpc.declare`, call it) | rpcd must be restarted after changing scripts: `/etc/init.d/rpcd restart` |
| **Change the ct mark encoding** (e.g., use different flag bit) | `marktrack.sh` (the two `ct mark set` lines) · `luci.marktrack` (`dscp_num = mark % 64` decode logic) · `connections.js` (`dscpToString` uses `mark & 0x3F`) | All three must use the same encode/decode scheme |
| **Change the hook or priority default** | `etc/config/marktrack` (default values) · `marktrack.sh` (`config_get` fallback values) · `DOCS.md` (§7 hook table) | |
| **Add a new LuCI page** | New JS view file in `htdocs/luci-static/resources/view/marktrack/` · `luci-app-marktrack.json` (menu — add route entry) · `luci-app-marktrack.json` (ACL — add any new ubus/file permissions) · `luci-app-marktrack/Makefile` (add `INSTALL_DATA` line) | Without the Makefile entry, the file won't be installed from IPK |
| **Change UCI section or option names** | `marktrack.sh` (`config_get` calls) · `init.d/marktrack` (`config_get` calls) · `luci.marktrack` (if it reads UCI directly) · All JS views that call `uci.get()` / `uci.set()` | UCI option names are strings in both shell and JS — no compiler catches mismatches |
| **Change validation result file path** | `init.d/marktrack` (`result_file` variable) · `custom_rules.js` (`fs.read(...)` path) · `luci-app-marktrack.json` (ACL read permission for the file) | |

---

## 11. Bugs Found & Historical Record

> **Status:** All 9 bugs listed below were identified during the initial audit and have been fixed in the current codebase. This section is retained as a historical record explaining what was wrong and why each fix was made. Do not treat the "Problem" code blocks as the current state of the code — they show the original broken code.

The following issues were identified during the full code audit. They are listed by severity.

---

### BUG-01 — CRITICAL: Custom Rules Format Mismatch Between UI and Backend

**Severity:** Critical — custom rules entered in the UI are NEVER applied  
**Files:** `custom_rules.js` (write function, line 137) vs `marktrack.sh` (line 477)

**Problem:**  
`custom_rules.js` wraps user input in a full table declaration before saving:
```javascript
const newRules = `table inet marktrack_custom {\n${formvalue.trim()}\n}`;
fs.write('/etc/marktrack.d/custom_rules.nft', newRules);
```
But `marktrack.sh` includes `custom_rules.nft` as **chain-level statements** inside the existing `marktrack` chain body. The validation also wraps the file in a dummy chain, expecting chain-level content. A file containing `table inet marktrack_custom { }` will fail the validation check and be excluded.

**Fix:** Remove the table wrapper from `custom_rules.js`. The file should contain only chain statements:
```javascript
// In custom_rules.js, o.write function:
o.write = function(section_id, formvalue) {
    return fs.write('/etc/marktrack.d/custom_rules.nft', formvalue.trim() || '');
};
```
Accordingly update `o.load` to not strip the table wrapper (since we're not writing one anymore):
```javascript
o.load = function(section_id) {
    return customRules;  // customRules is already just chain statements
};
```
And in `load`:
```javascript
fs.read('/etc/marktrack.d/custom_rules.nft')
    .then(content => content.trim())
    .catch(() => ''),
```

---

### BUG-02 — CRITICAL: `inline_dscptag.nft` Read/Written by UI But Never Processed by Backend

**Severity:** Critical — "Inline Extra Rules" textarea in the UI has no effect  
**Files:** `custom_rules.js` (lines 43–44, 157–191) vs `marktrack.sh` (no reference)

**Problem:**  
`custom_rules.js` reads, writes, and validates `/etc/marktrack.d/inline_dscptag.nft`. However, `marktrack.sh` has no `include` or reference to this file. It is written to disk but never applied.

**Fix:** Either:
- **Option A (recommended):** Remove the "Inline Extra Rules" textarea entirely. Consolidate into the single `custom_rules.nft` file (chain-level statements) which `marktrack.sh` already handles correctly.
- **Option B:** Add `inline_dscptag.nft` processing to `marktrack.sh` similar to the existing `custom_rules.nft` include, validating and including it after the main custom rules.

---

### BUG-03 — CRITICAL: Validation Result File Never Written

**Severity:** High — validation result UI always shows "No validation performed yet"  
**Files:** `custom_rules.js` (line 234: reads `/tmp/marktrack_custom_rules_validation.txt`) vs `init.d/marktrack` `validate_custom_rules()` (outputs to stdout only)

**Problem:**  
The `validate_custom_rules` function in the init script writes to stdout. The JS tries to `fs.read('/tmp/marktrack_custom_rules_validation.txt')` which never exists.

**Fix:** In `init.d/marktrack`, redirect validation output to the file:
```sh
validate_custom_rules() {
    local rules_file="$MARKTRACK_CUSTOM_RULES_FILE"
    local tmp_check="/tmp/marktrack_validate_check.nft"
    local result_file="/tmp/marktrack_custom_rules_validation.txt"
    # ... existing setup ...
    if nft --check --file "$tmp_check" 2>&1 | tee "$result_file"; then
        echo "Overall validation: PASSED" >> "$result_file"
    else
        echo "Overall validation: FAILED" >> "$result_file"
    fi
    rm -f "$tmp_check"
}
```

---

### BUG-04 — CRITICAL: `connections.js` Reads MAX_CONNECTIONS from Wrong UCI Section

**Severity:** High — connection limit dropdown shows and saves incorrect value  
**Files:** `connections.js` lines 85 and 125

**Problem:**  
```javascript
// Line 85 — reads from 'advanced' section (does not exist)
var current_uci_limit = uci.get('marktrack', 'advanced', 'MAX_CONNECTIONS') || '0';

// Line 125 — writes to 'advanced' section
uci.set('marktrack', 'advanced', 'MAX_CONNECTIONS', newLimit.toString());
```
The UCI config defines `MAX_CONNECTIONS` under `config settings 'settings'`, not `'advanced'`. The Lua backend also reads from `settings`.

**Fix:**
```javascript
var current_uci_limit = uci.get('marktrack', 'settings', 'MAX_CONNECTIONS') || '0';
// ...
uci.set('marktrack', 'settings', 'MAX_CONNECTIONS', newLimit.toString());
```

---

### BUG-05 — HIGH: Rule Counter Field Names Don't Match Between Backend and Frontend

**Severity:** High — Activity column in rules.js always shows "no activity" or "-" even when rules fire  
**Files:** `luci.marktrack_stats` (outputs `name`, `packets`, `bytes`) vs `rules.js` (reads `rule_name`, `total_packets`, `total_bytes`, `ipv4_packets`, `ipv6_packets`)

**Problem:**  
Backend outputs:
```json
{ "name": "ipv4_gaming", "packets": 1234, "bytes": 567890 }
```
Frontend reads:
```javascript
rule.rule_name      // undefined — backend uses 'name'
rule.total_packets  // undefined — backend uses 'packets'
rule.total_bytes    // undefined — backend uses 'bytes'
rule.ipv4_packets   // undefined — backend has no IPv4/IPv6 breakdown
```

Additionally, the nft comment for a rule named `gaming` is `"ipv4_gaming"` or `"ipv6_gaming"`, but the UI looks up by the UCI name `"gaming"`. These will never match.

**Fix — in `luci.marktrack_stats`:** Normalize the comment to strip the `ipv4_`/`ipv6_` prefix and aggregate both:
```sh
printf '%s\n' "$table_json" | jq '{
    rule_counters: [
        .nftables[] | .rule?
        | select(. != null)
        | select(.comment != null)
        | {
            base_name: (.comment | ltrimstr("ipv4_") | ltrimstr("ipv6_")),
            is_v4: (.comment | startswith("ipv4_")),
            packets: ([ .expr[]? | select(.counter?) | .counter.packets ] | first // 0),
            bytes:   ([ .expr[]? | select(.counter?) | .counter.bytes ]   | first // 0)
          }
    ]
    | group_by(.base_name)
    | map({
        name:          .[0].base_name,
        total_packets: (map(.packets) | add // 0),
        total_bytes:   (map(.bytes) | add // 0),
        ipv4_packets:  (map(select(.is_v4) | .packets) | add // 0),
        ipv6_packets:  (map(select(.is_v4 | not) | .packets) | add // 0)
      })
  }' 2>/dev/null || printf '{"rule_counters":[]}\n'
```

---

### BUG-06 — MEDIUM: Page Title Says "QoSmate Connections" (Fork Artifact)

**Severity:** Medium — wrong product name displayed in the UI  
**File:** `connections.js` line 469

**Problem:**
```javascript
E('h2', _('QoSmate Connections')),
```

**Fix:**
```javascript
E('h2', _('Mark and Track — Connections')),
```

---

### BUG-07 — MEDIUM: Error Messages Reference "QoSmate" Instead of "marktrack"

**Severity:** Medium — confusing to users  
**Files:** `rules.js` line 317, `ipsets.js` line 37

**Problem:**
```javascript
_('Failed to save settings or update QoSmate service: ')
```

**Fix (both files):**
```javascript
_('Failed to save settings or update marktrack service: ')
```

---

### BUG-08 — MEDIUM: ACL Missing Permissions for `inline_dscptag.nft` and Init Script Exec

**Severity:** Medium — `custom_rules.js` operations fail for non-root LuCI sessions  
**File:** `luci-app-marktrack.json` (ACL)

**Problem:** The ACL is missing:
- Read/write for `/etc/marktrack.d/inline_dscptag.nft`
- Execute permission for `/etc/init.d/marktrack`

Without exec permission, `fs.exec_direct('/etc/init.d/marktrack', ['restart'])` fails for restricted users.

**Fix:**
```json
"read": {
    "file": {
        "/etc/marktrack.d/custom_rules.nft": [ "read" ],
        "/etc/marktrack.d/inline_dscptag.nft": [ "read" ],
        "/proc/net/nf_conntrack": [ "read" ]
    }
},
"write": {
    "file": {
        "/etc/marktrack.d/custom_rules.nft": [ "write" ],
        "/etc/marktrack.d/inline_dscptag.nft": [ "write" ],
        "/etc/init.d/marktrack": [ "exec" ]
    }
}
```

---

### BUG-09 — LOW: ICMP Byte/Packet Counting Is Incorrect

**Severity:** Low — cosmetic; ICMP connections are minor traffic  
**File:** `luci.marktrack` lines 36–41

**Problem:** ICMP conntrack lines also have two directions (request + reply), but the Lua parser only captures the first `packets=N bytes=N` and assigns it to both in and out. Total bytes is therefore doubled.

**Fix:** Use the same two-direction match pattern for ICMP as for TCP/UDP, matching both direction fields:
```lua
if conn.protocol == "icmp" or conn.protocol == "icmpv6" then
    local src1, dst1, pkts1, bytes1, src2, dst2, pkts2, bytes2 =
        line:match("src=(%S+)%s+dst=(%S+)%s+[^\n]-packets=(%d+)%s+bytes=(%d+)"
                .. "%s+src=(%S+)%s+dst=(%S+)%s+[^\n]-packets=(%d+)%s+bytes=(%d+)")
    conn.src = src1; conn.dst = dst1
    conn.sport = "-"; conn.dport = "-"
    conn.in_packets  = pkts1  or "0"
    conn.in_bytes    = bytes1 or "0"
    conn.out_packets = pkts2  or "0"
    conn.out_bytes   = bytes2 or "0"
```

---

### Bug Summary Table

| ID | Severity | File | Issue | Status |
|---|---|---|---|---|
| BUG-01 | Critical | `custom_rules.js` | UI wraps rules in table declaration; backend expects chain statements | **Fixed** |
| BUG-02 | Critical | `custom_rules.js` + `marktrack.sh` | `inline_dscptag.nft` written but never included by backend | **Fixed** (removed inline_rules textarea) |
| BUG-03 | Critical | `init.d/marktrack` | Validation output never written to file the UI reads | **Fixed** |
| BUG-04 | Critical | `connections.js` | MAX_CONNECTIONS reads/writes wrong UCI section (`advanced` vs `settings`) | **Fixed** |
| BUG-05 | High | `luci.marktrack_stats` + `rules.js` | Counter field names and rule name format mismatch | **Fixed** |
| BUG-06 | Medium | `connections.js` | Page title says "QoSmate" | **Fixed** |
| BUG-07 | Medium | `rules.js`, `ipsets.js` | Error messages say "QoSmate" | **Fixed** |
| BUG-08 | Medium | ACL JSON | Missing exec permission and validation result file read permission | **Fixed** |
| BUG-09 | Low | `luci.marktrack` | ICMP direction counting doubles bytes | **Fixed** |

---

## 12. Version 0.2 Changes

Version 0.2 is a full functional-verification pass over the entire project. Every backend↔frontend link was traced and tested. The following additional issues (beyond the BUG-01…BUG-09 set already fixed) were found and fixed in this version.

| ID | Severity | File | Issue | Fix |
|---|---|---|---|---|
| V02-01 | **Critical** | `luci.marktrack` | The Lua rpcd backend used a non-standard stdin JSON loop instead of the rpcd exec-plugin `list`/`call` argv protocol. rpcd could not enumerate `getConntrackDSCP`, so the Connections page always received an empty result. | Rewrote dispatch to the standard `list` / `call <method>` argv protocol (matching the sibling `luci.marktrack_stats`). |
| V02-02 | **Critical** | `luci.marktrack` | The returned connection objects omitted `in_bytes`, `out_bytes`, `in_packets`, `out_packets`, and `layer3` — but `connections.js` relies on all of them for the In/Out columns, bandwidth (BPS), and packet-rate (PPS) calculations. All those columns rendered as `undefined`/`NaN`. | Added the per-direction counters and `layer3` to the returned object; counters are emitted as numbers to avoid JS string-concatenation bugs in sorting. |
| V02-03 | **High** | `luci.marktrack_stats` | The counter backend emitted `name`, but `rules.js` reads `rule_name`. The Activity column never populated. | Renamed the output field to `rule_name`; verified end-to-end with sample nft JSON. |
| V02-04 | **Low** | `luci.marktrack` | The conntrack line parser captured only 4 prefix fields, so `timeout` actually held the L4 protocol number, not the real timeout. | Parser now captures the 5-field prefix; `timeout` is the real seconds-remaining value. |
| V02-05 | Medium | `custom_rules.js` | Description claimed "the nftables rule wrapper will be added automatically" and the example showed a full `chain forward { … }` block. After the BUG-01 fix the backend expects **chain statements only**, so that example would fail validation. | Rewrote the description and examples to show correct chain-level statements. |
| V02-06 | Low | `custom_rules.js` | Leftover "restart QoSmate" error string. | Renamed to "restart marktrack". |
| V02-07 | Low | `connections.js` | RPC handle was named `callQoSmateConntrackDSCP` (fork artifact). | Renamed to `callConntrackDSCP`. |
| V02-08 | Medium (UX) | `rules.js` | The rule page showed HFSC (`1:11`…`1:15`) and CAKE `diffserv4` shaping-class tables inherited from QoSmate. marktrack does not shape traffic, so these were misleading. An empty "DSCP Mapping" tab was also registered. | Replaced with a simple **DSCP Class Reference** table (class, decimal value, typical use) and a note clarifying that marktrack only tags packets. Removed the empty tab. |

### Verification performed for 0.2

- **Lua backend** executed against sample `/proc/net/nf_conntrack` data (TCP/UDP/ICMP): DSCP decoding (`mark & 0x3F`), per-direction byte/packet splits, ICMP totals, and `timeout` all confirmed correct; `list` and `call` dispatch confirmed.
- **Counter jq** run against representative `nft -j list table` output: IPv4/IPv6 rules aggregate to one `rule_name`, unnamed rules excluded, field names match the frontend.
- **All four JS views** pass `node --check`.
- **Generated nftables ruleset** and the **custom-rules validation wrapper** pass `nft --check`.
- **All shell scripts** pass `sh -n`; both JSON config files pass `jq empty`.

---

## 13. Version 0.2.1 Changes

Follow-up fixes after real-router testing (Cudy / OpenWrt 24.10, apk-based).

| ID | Area | Change |
|---|---|---|
| V021-01 | **Connections fix** | The Lua conntrack backend needed `lua` + `luci-lib-jsonc`, absent by default on apk-based 24.10, causing "No connection data received". Rewrote `luci.marktrack` in **shell + awk** (busybox-verified) — zero extra language deps. Output validated identical under gawk and busybox awk for TCP/UDP/ICMP/IPv6. |
| V021-02 | **Dependencies** | Removed `+lua +luci-lib-jsonc` from `luci-app-marktrack` Makefile and from the installer's dependency list (now just `nftables kmod-nf-conntrack jq ca-bundle`). |
| V021-03 | **In-page navigation** | Added a section navigation bar rendered at the top of all four views (DSCP Rules / IP Sets / Custom Rules / Connections). Users can switch sections from within the page instead of the top menu bar; the active section is highlighted. |
| V021-04 | **Installer** | Package-manager auto-detection (`apk` on 24.10+, `opkg` on 23.05 and older). |

---

## 14. Version 0.2.2 Changes

UI simplification, navigation restructure, and performance pass on the Connections view.

| ID | Area | Change |
|---|---|---|
| V022-01 | **Navigation** | marktrack moved into the **Network** menu (`admin/network/marktrack`) instead of a standalone top-level menu with its own dropdown. Its four sections render as LuCI's native content tabs. The custom in-page nav bar added in 0.2.1 was removed (redundant with native tabs; lighter). |
| V022-02 | **Naming** | Menu title changed to `marktrack`. |
| V022-03 | **Connections — columns** | Removed the **Max PPS** column; renamed **Bytes → Transfer** (shows total transferred, single value). Cells are now single values instead of split In/Out, reducing DOM nodes per row. |
| V022-04 | **Connections — polling** | Replaced adaptive polling with a **Refresh interval dropdown** (1 s / 3 s / 10 s / 30 s / 1 min, default 3 s) plus Pause/Resume. |
| V022-05 | **Connections — performance** | Rewrote the view to be lightweight: EMA-smoothed rates (no per-connection sample arrays), rows built in one `DocumentFragment` and swapped with a single `replaceChildren` per poll (one reflow), stale rate-state pruned when flows close, and the poll timer stops when the view is navigated away. |

### Verification performed for 0.2.2

- `connections.js` loaded into a stubbed environment: EMA rate calc, sort-by-column, multi-token filter, and full table render all verified (8 columns incl. Transfer, no Max PPS; correct row/cell counts).
- All four JS views pass `node --check`; `menu.d` and `acl.d` JSON pass `jq empty`.
- No remaining references to the removed custom nav.

---

## 15. Version 0.3 Changes

The **IP Sets** feature was removed entirely. marktrack no longer manages `nftables` named sets; rules match on literal IPs/CIDRs (a rule's `src_ip`/`dest_ip` can still list multiple addresses), IPv6 suffix masks (`::suffix/::mask`), and negation (`!=`) exactly as before.

| ID | Area | Change |
|---|---|---|
| V03-01 | **Backend** | Removed `create_nft_sets()`, the `is_set_ref()` / `get_set_family()` helpers, the `@setname` branches in `separate_ips_by_family()` and `gen_rule()`, the `SETS` generation, and the `${SETS}` emission block in the generated `nftables` table (`marktrack.sh`). No more `/tmp/marktrack_set_families` temp file. |
| V03-02 | **Init script** | Dropped the `rm -f /tmp/marktrack_set_families` cleanup from `stop_service` (`init.d/marktrack`). |
| V03-03 | **UCI config** | Removed the commented `config ipset` example from `etc/config/marktrack`. Existing `ipset` sections in a user's config are simply ignored. |
| V03-04 | **Frontend** | Deleted `ipsets.js`; removed its menu entry (`admin/network/marktrack/ipsets`) and its `INSTALL_DATA` line from the LuCI Makefile. The app now ships **three** views (DSCP Rules, Custom Rules, Connections). |
| V03-05 | **Rules view** | Removed `@setname` validation from `rules.js`; the Source/Destination IP placeholders now read `IP address or ::suffix/::mask`. |
| V03-06 | **Docs** | Reconciled `README.md` and `DOCS.md` (architecture diagram, data flow, file map, component deep-dives, config reference, and change-impact table) to match the set-free codebase. Historical records in §11–§14 are retained as written. |

### Verification performed for 0.3

- `marktrack.sh` and `init.d/marktrack` pass `sh -n`.
- All three JS views pass `node --check`; `menu.d` and `acl.d` JSON pass `jq empty`.
- Repository-wide grep confirms no residual `ipset` / set-reference identifiers remain in code (documentation history excepted).

---

## 16. Version 0.3.1 Changes

A full UI redesign giving marktrack its own visual identity — a self-contained dark **"network-ops console"** — distinct from the stock LuCI admin skin and from its QoSmate origins. No backend, rpcd, ACL, or polling behavior changed; this is purely presentation.

**Design intent:** fit the feature (DSCP tag-and-track), read clearly at a glance, and stay light on low-spec OpenWrt hardware.

| ID | Area | Change |
|---|---|---|
| V031-01 | **Design system** | New shared stylesheet `htdocs/luci-static/resources/marktrack/marktrack.css`, loaded once via an injected `<link>`. Everything is scoped under `.mt-app` (no leakage into the wider LuCI theme). Tokens: dark surfaces, one cyan-green accent, monospace for machine values, and nine **DSCP signal hues** exposed as `.mt-sig--*` → `--sig`. |
| V031-02 | **Connections** | Rebuilt as a console dashboard: title bar + live/paused status dot, **stat chips** (active flows, throughput, marked, top class), colored **DSCP signal tags**, per-row **transfer bars** (hue shared with the tag, width ∝ share of the largest flow), and a **segmented** refresh control. Kept the existing single-`replaceChildren`-per-poll render and EMA rate math. |
| V031-03 | **Rules** | Form wrapped in the themed panel; the DSCP Class Reference is now colored **signal-tag cards**; the live Activity cell uses theme classes instead of inline colors. All form logic unchanged. |
| V031-04 | **Custom Rules** | Wrapped in the themed panel; example and validation blocks now use the shared `.mt-code` / callout styling instead of inline `rgba()` styles. |
| V031-05 | **Packaging & installer** | `marktrack.css` added to the LuCI Makefile install, the one-line installer (`uclient-fetch`), and both manual-install guides. |
| V031-06 | **Low-resource pass** | No web fonts or external assets (system font stack); router serves the ~one static CSS file once (then browser-cached) and does no extra work — same rpcd calls, same 3 s/8 s poll cadence. Per-row glows and the bar transition were dropped and the live-dot pulse switched to a compositor-only opacity animation (gated by `prefers-reduced-motion`) to keep client repaint cheap. |

### Verification performed for 0.3.1

- All three JS views pass `node --check`; `menu.d` and `acl.d` JSON pass `jq empty`.
- `marktrack.css` brace/paren balance checked; all generic and LuCI-class selectors (`input`, `.table`, `.btn`, `.cbi-*`) are `.mt-app`-scoped and component styles use unique `.mt-*` names, so nothing leaks into the wider admin skin; a `@supports` fallback covers engines without `color-mix()`.
- Confirmed no new rpcd methods, ACL entries, or polling — router-side load is unchanged from 0.3.
