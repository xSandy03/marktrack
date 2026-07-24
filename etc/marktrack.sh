#!/bin/sh
# shellcheck disable=SC3043,SC1091,SC2155,SC3020,SC3010,SC2016,SC2317,SC3060,SC3057,SC3003

# Mark and Track — Main nftables setup script
# Applies DSCP marking rules from UCI config and saves marks to conntrack.

_NL_='
'
DEFAULT_IFS=" 	${_NL_}"
IFS="$DEFAULT_IFS"

. /lib/functions.sh

error_out() { log_msg -err "${@}"; }

# Prints each argument to a separate line
print_msg() {
    local _arg msgs_dest="/dev/stdout" msgs_prefix=''
    for _arg in "$@"
    do
        case "${_arg}" in
            -err)  msgs_dest="/dev/stderr" msgs_prefix="Error: " ;;
            -warn) msgs_dest="/dev/stderr" msgs_prefix="Warning: " ;;
            '') printf '\n' ;;
            *)
                printf '%s\n' "${msgs_prefix}${_arg}" > "$msgs_dest"
                msgs_prefix=''
        esac
    done
    :
}

# Logs each argument via logger and prints to stdout/stderr
# Optional flags: '-err', '-warn'
log_msg() {
    local msgs_prefix='' _arg err_l=info msgs_dest
    local IFS="$DEFAULT_IFS"
    for _arg in "$@"
    do
        case "${_arg}" in
            "-err")  err_l=err  msgs_prefix="Error: " ;;
            "-warn") err_l=warn msgs_prefix="Warning: " ;;
            '') printf '\n' ;;
            *)
                case "$err_l" in
                    err|warn) msgs_dest="/dev/stderr" ;;
                    *)        msgs_dest="/dev/stdout"
                esac
                printf '%s\n' "${msgs_prefix}${_arg}" > "$msgs_dest"
                logger -t marktrack -p user."$err_l" "${msgs_prefix}${_arg}"
                msgs_prefix=''
        esac
    done
    :
}

config_load 'marktrack' || { error_out "Failed to get UCI config."; exit 1; }

# Read global hook/priority settings
config_get NFT_HOOK     settings NFT_HOOK     'forward'
config_get NFT_PRIORITY settings NFT_PRIORITY '0'

# Debug helper — set MARKTRACK_DEBUG=1 to enable
debug_log() {
    [ -n "$MARKTRACK_DEBUG" ] || return 0
    logger -s -t marktrack "$1" >&2
}

##############################
# DSCP Rule generation
##############################

# Generates a single nftables DSCP marking rule from a UCI 'rule' section.
# Handles IPv4, IPv6, mixed addresses, negation, port ranges.
# shellcheck disable=SC2329
create_nft_rule() {
    # Trim leading/trailing whitespace in variable $1
    trim_spaces() {
        local tr_in tr_out
        eval "tr_in=\"\${$1}\""
        tr_out="${tr_in%"${tr_in##*[! 	]}"}"
        tr_out="${tr_out#"${tr_out%%[! 	]*}"}"
        eval "$1=\"\${tr_out}\""
    }

    # Checks whether a string is an IPv6 suffix mask (::suffix/::mask)
    is_ipv6_mask() {
        case "$1" in
            ::*/::*) ;;
            *) return 1
        esac
        local inp="${1#"::"}"
        case "${inp%"/:::"*}" in *"/"*) return 1; esac
        return 0
    }

    # Checks whether a single IP address is IPv6 (handles CIDR notation)
    is_ipv6() {
        local ip="${1%/*}"
        case "$ip" in
            *:*) return 0 ;;
            *)   return 1 ;;
        esac
    }

    local config="$1"
    local proto class counter name enabled trace

    config_get      proto   "$config" proto
    config_get      class   "$config" class
    config_get_bool counter "$config" counter 0
    config_get_bool trace   "$config" trace   0
    config_get      name    "$config" name
    config_get_bool enabled "$config" enabled 1

    [ "$enabled" = "0" ] && return 0

    # Normalise class to lowercase
    class=$(echo "$class" | tr 'A-Z' 'a-z')

    if [ -z "$class" ]; then
        print_msg -err "Class for rule '$config' is empty."
        return 1
    fi

    # Separates a space-separated list of IPs into IPv4 and IPv6 buckets
    separate_ips_by_family() {
        local ips="$3" ip prefix ipv4_result="" ipv6_result=""

        for ip in $ips; do
            prefix=""
            case "$ip" in '!='*)
                prefix="!="
                ip="${ip#"!="}"
            esac

            if is_ipv6_mask "$ip"; then
                ipv6_result="${ipv6_result}${ipv6_result:+ }${prefix}${ip}"
            elif is_ipv6 "$ip"; then
                ipv6_result="${ipv6_result}${ipv6_result:+ }${prefix}${ip}"
            else
                ipv4_result="${ipv4_result}${ipv4_result:+ }${prefix}${ip}"
            fi
        done

        eval "${1}=\"\${ipv4_result}\" ${2}=\"\${ipv6_result}\""
    }

    local src_ip dest_ip \
        src_ip_v4='' src_ip_v6='' dest_ip_v4='' dest_ip_v6='' \
        has_ipv4=0 has_ipv6=0 ip_val ip_type

    for ip_type in src_ip dest_ip; do
        config_get "${ip_type}" "$config" "${ip_type}"
        eval "ip_val=\"\${$ip_type}\""
        if [ -n "$ip_val" ]; then
            separate_ips_by_family "${ip_type}_v4" "${ip_type}_v6" "$ip_val"
            eval "
                [ -n \"\${${ip_type}_v4}\" ] && has_ipv4=1
                [ -n \"\${${ip_type}_v6}\" ] && has_ipv6=1
            "
        fi
    done

    if [ "$has_ipv4" -eq 1 ] && [ "$has_ipv6" -eq 1 ]; then
        log_msg "" "Info: Mixed IPv4/IPv6 addresses in rule '$name' ($config). Splitting into separate rules." >&2
    fi

    if [ -z "$src_ip" ] && [ -z "$dest_ip" ] && [ "$has_ipv4" -eq 0 ] && [ "$has_ipv6" -eq 0 ]; then
        debug_log "Rule '$name' ($config): No IP specified, generating rules for both IPv4 and IPv6."
        has_ipv4=1
        has_ipv6=1
    fi

    # Builds a nftables match expression for a set of values with a given prefix
    gen_rule() {
        add_res_rule() {
            if [ -z "$res_set_neg" ] && [ -z "$res_set_pos" ]; then
                error_out "no valid $1 found in '$values'. Rule skipped."
                return 1
            fi
            [ -n "$res_set_neg" ] && result="${result}${result:+ }${prefix} != { ${res_set_neg} }"
            [ -n "$res_set_pos" ] && result="${result}${result:+ }${prefix} { ${res_set_pos} }"
            :
        }

        local value suffix mask comp_op negation \
            result='' res_set_neg='' res_set_pos='' \
            has_ipv4='' has_ipv6='' ipv6_mask_seen='' reg_val_seen='' \
            values="$1" prefix="$2"

        for value in $values; do
            if [ -n "$ipv6_mask_seen" ]; then
                error_out "invalid entry '$values'. IPv6 mask must be alone."
                return 1
            fi

            negation=
            comp_op="=="
            case "$value" in '!='*)
                negation=" !="
                comp_op="!="
                value="${value#"!="}"
            esac

            if is_ipv6_mask "$value"; then
                [ -n "$reg_val_seen" ] && {
                    error_out "invalid entry '$values'. IPv6 mask must be alone."
                    return 1
                }
                ipv6_mask_seen=1
                suffix="${value%%"/:::"*}"
                mask="${value#"${suffix}/"}"
                result="${prefix//ip /ip6 } & ${mask} ${comp_op} ${suffix}"
                continue
            fi

            case "$prefix" in
                "ip saddr"|"ip daddr"|"ip6 saddr"|"ip6 daddr"|"th sport"|"th dport"|"meta l4proto") ;;
                *)
                    error_out "unexpected prefix '$prefix'."
                    return 1
                    ;;
            esac

            case "$prefix" in *addr*)
                if is_ipv6 "$value"; then
                    has_ipv6=1
                else
                    has_ipv4=1
                fi
            esac

            if [ -n "$negation" ]; then
                res_set_neg="${res_set_neg}${res_set_neg:+,}${value}"
            else
                res_set_pos="${res_set_pos}${res_set_pos:+,}${value}"
            fi
            reg_val_seen=1
        done

        if [ -n "$ipv6_mask_seen" ]; then
            printf '%s\n' "$result"
            return 0
        fi

        if [ -n "$has_ipv4" ] && [ -n "$has_ipv6" ]; then
            error_out "Mixed IPv4/IPv6 addresses within a set: { $values }. Rule skipped."
            return 1
        fi

        [ -n "$has_ipv6" ] && prefix="${prefix//ip /ip6 }"

        case "$prefix" in
            *addr*)                  add_res_rule addresses  || return 1 ;;
            "th sport"|"th dport")   add_res_rule ports      || return 1 ;;
            "meta l4proto")          add_res_rule protocols  || return 1 ;;
        esac

        printf '%s\n' "$result"
    }

    local rule_cmd=""

    # Protocol match
    if [ -n "$proto" ]; then
        local proto_result
        if ! proto_result="$(gen_rule "$proto" "meta l4proto")"; then
            return 0
        fi
        rule_cmd="$rule_cmd $proto_result"
    fi

    # Port matches
    local port port_type port_res port_seen=''
    for port_type in src_port dest_port; do
        config_get port "$config" "$port_type"
        if [ -n "$port" ]; then
            if ! port_res="$(gen_rule "$port" "th ${port_type%%"${port_type#?}"}port")"; then
                return 0
            fi
            rule_cmd="$rule_cmd $port_res"
            port_seen=1
        fi
    done

    # Build per-family rules
    local final_rule_v4="" final_rule_v6="" common_rule_part="$rule_cmd"
    trim_spaces common_rule_part

    # IPv4 rule
    if [ "$has_ipv4" -eq 1 ]; then
        local rule_cmd_v4="$common_rule_part"

        if [ -n "$src_ip_v4" ]; then
            local src_result
            if ! src_result="$(gen_rule "$src_ip_v4" "ip saddr")"; then return 0; fi
            rule_cmd_v4="$rule_cmd_v4 $src_result"
        fi
        if [ -n "$dest_ip_v4" ]; then
            local dest_result
            if ! dest_result="$(gen_rule "$dest_ip_v4" "ip daddr")"; then return 0; fi
            rule_cmd_v4="$rule_cmd_v4 $dest_result"
        fi

        if [ -n "$proto" ] || [ -n "$src_ip_v4" ] || [ -n "$dest_ip_v4" ] || [ -n "$port_seen" ]; then
            rule_cmd_v4="$rule_cmd_v4 ip dscp set $class"
        fi
        [ "$counter" -eq 1 ] && rule_cmd_v4="$rule_cmd_v4 counter"
        [ "$trace"   -eq 1 ] && rule_cmd_v4="$rule_cmd_v4 meta nftrace set 1"
        [ -n "$name" ]       && rule_cmd_v4="$rule_cmd_v4 comment \"ipv4_$name\""

        trim_spaces rule_cmd_v4
        if [ -n "$rule_cmd_v4" ] && [ "$rule_cmd_v4" != ";" ]; then
            final_rule_v4="$rule_cmd_v4;"
        fi
    fi

    # IPv6 rule
    if [ "$has_ipv6" -eq 1 ]; then
        local rule_cmd_v6="$common_rule_part"

        if [ -n "$src_ip_v6" ]; then
            local src_result
            if ! src_result="$(gen_rule "$src_ip_v6" "ip6 saddr")"; then return 0; fi
            rule_cmd_v6="$rule_cmd_v6 $src_result"
        fi
        if [ -n "$dest_ip_v6" ]; then
            local dest_result
            if ! dest_result="$(gen_rule "$dest_ip_v6" "ip6 daddr")"; then return 0; fi
            rule_cmd_v6="$rule_cmd_v6 $dest_result"
        fi

        if [ -n "$proto" ] || [ -n "$src_ip_v6" ] || [ -n "$dest_ip_v6" ] || [ -n "$port_seen" ]; then
            rule_cmd_v6="$rule_cmd_v6 ip6 dscp set $class"
        fi
        [ "$counter" -eq 1 ] && rule_cmd_v6="$rule_cmd_v6 counter"
        [ "$trace"   -eq 1 ] && rule_cmd_v6="$rule_cmd_v6 meta nftrace set 1"
        [ -n "$name" ]       && rule_cmd_v6="$rule_cmd_v6 comment \"ipv6_$name\""

        trim_spaces rule_cmd_v6
        if [ -n "$rule_cmd_v6" ] && [ "$rule_cmd_v6" != ";" ]; then
            final_rule_v6="$rule_cmd_v6;"
        fi
    fi

    [ -n "$final_rule_v4" ] && echo "        $final_rule_v4"
    [ -n "$final_rule_v6" ] && echo "        $final_rule_v6"
}

# Iterates all UCI 'rule' sections and emits nftables rules
generate_dynamic_nft_rules() {
    local global_enabled
    config_get_bool global_enabled global enabled 1
    if [ "$global_enabled" = "1" ]; then
        config_foreach create_nft_rule rule
    else
        echo "        # Mark and Track is globally disabled"
    fi
}

##############################
# Custom rules include check
##############################

INLINE_FILE="/etc/marktrack.d/custom_rules.nft"
INLINE_INCLUDE=""

if [ -s "$INLINE_FILE" ]; then
    TMP_CHECK_FILE="/tmp/marktrack_inline_check.nft"
    {
        printf '%s\n\t%s\n' "table inet __marktrack_check {" "chain __check {"
        cat "$INLINE_FILE"
        printf "\n\t%s\n%s\n" "}" "}"
    } > "$TMP_CHECK_FILE"

    if nft --check --file "$TMP_CHECK_FILE" 2>/dev/null; then
        INLINE_INCLUDE="include \"$INLINE_FILE\""
        debug_log "Custom rules file is valid, will include."
    else
        log_msg -warn "Custom rules file '$INLINE_FILE' has syntax errors — skipping include."
    fi
    rm -f "$TMP_CHECK_FILE"
fi

##############################
# Generate sets and rules
##############################

DYNAMIC_RULES=$(generate_dynamic_nft_rules)

##############################
# Write and apply nftables table
##############################

mkdir -p /tmp/marktrack
NFT_FILE="/tmp/marktrack/marktrack.nft"

cat > "$NFT_FILE" << NFTEOF

# Mark and Track — generated $(date)
# Do not edit manually; managed by /etc/marktrack.sh

# Forward declaration (allows delete even on first run)
table inet marktrack

# Flush previous rules
delete table inet marktrack

table inet marktrack {

    chain marktrack {
        type filter hook ${NFT_HOOK} priority ${NFT_PRIORITY}; policy accept;

        # Skip loopback traffic
        iif "lo" accept;

        # ── User DSCP rules ──
${DYNAMIC_RULES}

        # ── User custom rules ──
        ${INLINE_INCLUDE}

        # ── Save DSCP into conntrack mark ──
        # Encoding: ct mark = (dscp_value) | 128
        # The 128 flag identifies marktrack-tagged flows in the Connections UI
        ct mark set ip  dscp or 128 counter;
        ct mark set ip6 dscp or 128 counter;
    }
}
NFTEOF

log_msg "Applying Mark and Track nftables rules (hook: ${NFT_HOOK}, priority: ${NFT_PRIORITY})..."

if nft -f "$NFT_FILE"; then
    log_msg "Mark and Track rules applied successfully."
else
    error_out "Failed to apply nftables rules. Check syntax with: nft -f $NFT_FILE"
    cat "$NFT_FILE" >&2
    rm -f "$NFT_FILE"
    exit 1
fi

rm -f "$NFT_FILE"
exit 0
