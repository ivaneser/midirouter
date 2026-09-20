#!/usr/bin/env bash
#
# stop-ap.sh — Stop midirouter WiFi Access Point
#
# Tears down the WiFi access point, stops dnsmasq, and removes iptables rules.
# Restores the wlan0 interface to managed mode (if it was previously connected).
#
# Usage: sudo ./stop-ap.sh

set -e

AP_INTERFACE="wlan0"
SSID="midirouter"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOSTAPD_CONF="${SCRIPT_DIR}/etc/hostapd.conf"

echo "[AP] Stopping midirouter WiFi Access Point..."

# ---- Check for root privileges ----
if [ "$EUID" -ne 0 ]; then
    echo "[AP] ERROR: This script must be run as root (use sudo)" >&2
    exit 1
fi

# ---- Stop hostapd ----
echo "[AP] Stopping hostapd..."
HOSTAPD_PID=$(cat /run/midirouter-hostapd.pid 2>/dev/null || pidof hostapd)
if [ -n "$HOSTAPD_PID" ]; then
    kill "$HOSTAPD_PID" 2>/dev/null || true
    sleep 1
    # Force kill if still running
    if pidof hostapd &> /dev/null; then
        pkill -9 -f "hostapd ${HOSTAPD_CONF}" 2>/dev/null || true
        sleep 1
    fi
fi

# ---- Stop dnsmasq ----
echo "[AP] Stopping dnsmasq..."
DNSMASQ_PID=$(cat /run/midirouter-dnsmasq.pid 2>/dev/null || pidof dnsmasq)
if [ -n "$DNSMASQ_PID" ]; then
    kill "$DNSMASQ_PID" 2>/dev/null || true
    sleep 1
    if pidof dnsmasq &> /dev/null; then
        pkill -9 -f "dnsmasq" 2>/dev/null || true
        sleep 1
    fi
fi

# ---- Remove iptables rules ----
echo "[AP] Removing iptables rules..."
iptables -t nat -D POSTROUTING -s 10.0.0.0/24 -o eth0 -j MASQUERADE 2>/dev/null || true
iptables -t nat -F MIDIRouter 2>/dev/null || true
iptables -t nat -X MIDIRouter 2>/dev/null || true
iptables -t filter -D PREROUTING -i wlan0 -s 10.0.0.0/24 -j MIDIRouter 2>/dev/null || true
iptables -t filter -F MIDIRouter 2>/dev/null || true
iptables -t filter -X MIDIRouter 2>/dev/null || true

# Disable IP forwarding for this interface
echo 0 > /proc/sys/net/ipv4/ip_forward 2>/dev/null || true

# ---- Bring down the AP interface ----
echo "[AP] Bringing down ${AP_INTERFACE}..."
ip link set down "${AP_INTERFACE}" 2>/dev/null || true
ip addr flush dev "${AP_INTERFACE}" 2>/dev/null || true

# Clean up PID files
rm -f /run/midirouter-hostapd.pid
rm -f /run/midirouter-dnsmasq.pid

echo "[AP] WiFi Access Point stopped."
echo ""
echo "  To reconnect to your existing WiFi network, use:"
echo "    sudo nmcli device wifi connect <SSID> password <password>"
echo ""
