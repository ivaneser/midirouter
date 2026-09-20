#!/usr/bin/env bash
#
# start-ap.sh — Start midirouter WiFi Access Point
#
# Sets up the Raspberry Pi as a WiFi access point with SSID "midirouter"
# and password "midirouter". Connected clients can reach the web interface
# at http://10.0.0.1:3000 or via captive portal redirect.
#
# Usage: sudo ./start-ap.sh

set -e

# ---- Configuration ----
SSID="midirouter"
PASSPHRASE="midirouter"
SUBNET="10.0.0.1/24"
AP_INTERFACE="wlan0"
WEB_PORT=3000

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOSTAPD_CONF="${SCRIPT_DIR}/etc/hostapd.conf"
DNSMASQ_CONF="${SCRIPT_DIR}/etc/dnsmasq.conf"

echo "[AP] Starting midirouter WiFi Access Point..."
echo "  SSID: ${SSID}"
echo "  Password: ${PASSPHRASE}"
echo "  Subnet: ${SUBNET}"
echo "  Interface: ${AP_INTERFACE}"

# ---- Check for root privileges ----
if [ "$EUID" -ne 0 ]; then
    echo "[AP] ERROR: This script must be run as root (use sudo)" >&2
    exit 1
fi

# ---- Check if hostapd is installed ----
if ! command -v hostapd &> /dev/null; then
    echo "[AP] hostapd not found. Installing..."
    apt-get update
    apt-get install -y hostapd dnsmasq iptables
fi

# ---- Stop existing services on the AP interface ----
echo "[AP] Stopping any existing hostapd/dnsmasq on ${AP_INTERFACE}..."
systemctl stop hostapd 2>/dev/null || true
systemctl stop dnsmasq 2>/dev/null || true

# Kill any leftover hostapd/dnsmasq processes for this interface
pkill -f "hostapd ${HOSTAPD_CONF}" 2>/dev/null || true
pkill -f "dnsmasq --conf-file=${DNSMASQ_CONF}" 2>/dev/null || true

# ---- Bring down the AP interface and reconfigure it ----
echo "[AP] Configuring ${AP_INTERFACE} with static IP..."
ip link set down "${AP_INTERFACE}" 2>/dev/null || true
sleep 1
ip addr flush dev "${AP_INTERFACE}" 2>/dev/null || true
ip addr add "${SUBNET}" dev "${AP_INTERFACE}"
ip link set up "${AP_INTERFACE}"
sleep 1

# Verify the interface is up
if ! ip link show "${AP_INTERFACE}" | grep -q "UP"; then
    echo "[AP] ERROR: Failed to bring up ${AP_INTERFACE}" >&2
    exit 1
fi

# ---- Configure iptables for NAT and captive portal redirect ----
echo "[AP] Setting up iptables rules..."

# Enable IP forwarding
echo 1 > /proc/sys/net/ipv4/ip_forward

# Flush existing rules for our chains
iptables -t nat -F MIDIRouter 2>/dev/null || true
iptables -t nat -N MIDIRouter 2>/dev/null || true
iptables -t filter -F MIDIRouter 2>/dev/null || true
iptables -t filter -N MIDIRouter 2>/dev/null || true

# NAT: Masquerade traffic from the AP subnet to the internet (via eth0)
iptables -t nat -A POSTROUTING -s 10.0.0.0/24 -o eth0 -j MASQUERADE 2>/dev/null || true

# Redirect HTTP (port 80) and HTTPS (port 443) traffic to the web server on port 3000
# This creates the captive portal effect — clients are redirected to the midirouter UI
iptables -t nat -A MIDIRouter -p tcp --dport 80 -j REDIRECT --to-port ${WEB_PORT} 2>/dev/null || true
iptables -t nat -A MIDIRouter -p tcp --dport 443 -j REDIRECT --to-port ${WEB_PORT} 2>/dev/null || true

# Apply the captive portal redirect to traffic from AP clients
iptables -t nat -A PREROUTING -i wlan0 -s 10.0.0.0/24 -j MIDIRouter 2>/dev/null || true

# Allow DNS queries from AP clients (port 53) to dnsmasq on the Pi
iptables -t filter -A MIDIRouter -p udp --dport 53 -s 10.0.0.0/24 -j ACCEPT 2>/dev/null || true
iptables -t filter -A MIDIRouter -p tcp --dport 53 -s 10.0.0.0/24 -j ACCEPT 2>/dev/null || true

# Allow traffic to the web server (port 3000) from AP clients
iptables -t filter -A MIDIRouter -p tcp --dport ${WEB_PORT} -s 10.0.0.0/24 -j ACCEPT 2>/dev/null || true

# Apply the chain to incoming traffic on wlan0
iptables -t filter -A PREROUTING -i wlan0 -s 10.0.0.0/24 -j MIDIRouter 2>/dev/null || true

echo "[AP] iptables rules configured."

# ---- Start dnsmasq (DHCP + DNS) ----
echo "[AP] Starting dnsmasq..."
dnsmasq --conf-file="${DNSMASQ_CONF}" \
        --user=dnsmasq \
        --group=dnsmasq \
        --pidfile=/run/midirouter-dnsmasq.pid \
        --log-facility=/var/log/midirouter-dnsmasq.log

if ! pidof dnsmasq &> /dev/null; then
    echo "[AP] ERROR: dnsmasq failed to start" >&2
    exit 1
fi
echo "[AP] dnsmasq started (PID: $(pidof dnsmasq))"

# ---- Start hostapd ----
echo "[AP] Starting hostapd..."
hostapd "${HOSTAPD_CONF}" -B \
    --logger-stdout=1 \
    --logger-stdout-level=2 \
    -P /run/midirouter-hostapd.pid

if ! pidof hostapd &> /dev/null; then
    echo "[AP] ERROR: hostapd failed to start" >&2
    exit 1
fi
echo "[AP] hostapd started (PID: $(pidof hostapd))"

# ---- Verify the AP is running ----
sleep 2
if ! iwconfig "${AP_INTERFACE}" 2>/dev/null | grep -q "ESSID:\"${SSID}\""; then
    echo "[AP] WARNING: AP may not be broadcasting SSID ${SSID}" >&2
fi

echo ""
echo "============================================================"
echo "  midirouter WiFi Access Point is ACTIVE"
echo "  Network: ${SSID} (password: ${PASSPHRASE})"
echo "  Connect to: http://10.0.0.1:${WEB_PORT}"
echo "  Or use the captive portal redirect after connecting"
echo "============================================================"
echo ""

# Save PID files for cleanup
echo "$(pidof hostapd)" > /run/midirouter-hostapd.pid
echo "$(pidof dnsmasq)" > /run/midirouter-dnsmasq.pid
