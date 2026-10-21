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

# Stop wpa_supplicant service — it conflicts with hostapd on the same interface
# (hostapd needs exclusive access to the WiFi interface to set channels and broadcast)
systemctl stop wpa_supplicant.service 2>/dev/null || true
systemctl disable --now wpa_supplicant.service 2>/dev/null || true

# Kill any leftover hostapd/dnsmasq/wpa_supplicant processes for this interface
pkill -f "hostapd ${HOSTAPD_CONF}" 2>/dev/null || true
pkill -f "dnsmasq --conf-file=${DNSMASQ_CONF}" 2>/dev/null || true
pkill -f "wpa_supplicant" 2>/dev/null || true

# ---- Tell NetworkManager to ignore the AP interface ----
# (prevents NM from managing wlan0 and restarting wpa_supplicant)
echo "[AP] Telling NetworkManager to ignore ${AP_INTERFACE}..."
nmcli device set "${AP_INTERFACE}" managed no 2>/dev/null || true

# ---- Bring down the AP interface and reconfigure it ----
echo "[AP] Configuring ${AP_INTERFACE} with static IP..."
ip link set down "${AP_INTERFACE}" 2>/dev/null || true
sleep 1
ip addr flush dev "${AP_INTERFACE}" 2>/dev/null || true

# Set the interface to AP mode (required for hostapd)
echo "[AP] Setting ${AP_INTERFACE} to AP mode..."
iw dev "${AP_INTERFACE}" set type __ap 2>/dev/null || \
    (echo "[AP] WARNING: Could not set AP mode via iw, trying with nl80211 driver" && \
     iw dev "${AP_INTERFACE}" set type __ap 2>/dev/null || \
     echo "[AP] WARNING: Interface mode change skipped - hostapd may handle this")

ip addr add "${SUBNET}" dev "${AP_INTERFACE}"
ip link set up "${AP_INTERFACE}"
sleep 1

# Verify the interface is up
if ! ip link show "${AP_INTERFACE}" | grep -q "UP"; then
    echo "[AP] ERROR: Failed to bring up ${AP_INTERFACE}" >&2
    exit 1
fi

# ---- Configure iptables for captive portal redirect (no internet sharing) ----
echo "[AP] Setting up iptables rules..."

# Standalone mode: no routing between the AP and the Pi's other networks.
# IP forwarding stays off, and any leftover NAT rule from older runs is removed.
echo 0 > /proc/sys/net/ipv4/ip_forward
iptables -t nat -D POSTROUTING -s 10.0.0.0/24 -o eth0 -j MASQUERADE 2>/dev/null || true
iptables -D FORWARD -i wlan0 -j DROP 2>/dev/null || true
iptables -D FORWARD -o wlan0 -j DROP 2>/dev/null || true
iptables -I FORWARD 1 -i wlan0 -j DROP
iptables -I FORWARD 1 -o wlan0 -j DROP

# Flush existing rules for our chains
iptables -t nat -F MIDIRouter 2>/dev/null || true
iptables -t nat -N MIDIRouter 2>/dev/null || true
iptables -t filter -F MIDIRouter 2>/dev/null || true
iptables -t filter -N MIDIRouter 2>/dev/null || true


# Redirect ALL TCP traffic from AP clients to the midirouter web server on
# port 3000 (10.0.0.1). This makes the captive portal catch every request —
# no matter which URL or port a client tries — and always serve the UI.
iptables -t nat -A MIDIRouter -p tcp -j REDIRECT --to-port ${WEB_PORT} 2>/dev/null || true

# Apply the captive portal redirect to traffic from AP clients
iptables -t nat -A PREROUTING -i wlan0 -s 10.0.0.0/24 -j MIDIRouter 2>/dev/null || true

# Allow DHCP requests (UDP 67) so dnsmasq can still hand out IPs.
# DNS (port 53) and web traffic (port 3000) are handled by the redirect above,
# which sends everything to the midirouter UI on port 3000.
iptables -t filter -A MIDIRouter -i "${AP_INTERFACE}" -p udp --dport 67 -j ACCEPT 2>/dev/null || true

# The filter table has no PREROUTING chain. Attach our allow-list to INPUT,
# before any default-deny rules; check first to avoid duplicate jumps on restart.
iptables -t filter -C INPUT -i "${AP_INTERFACE}" -s 10.0.0.0/24 -j MIDIRouter 2>/dev/null || \
    iptables -t filter -I INPUT 1 -i "${AP_INTERFACE}" -s 10.0.0.0/24 -j MIDIRouter 2>/dev/null || true

echo "[AP] iptables rules configured."

# ---- Start dnsmasq (DHCP + DNS) ----
echo "[AP] Starting dnsmasq..."
# Ensure the dnsmasq user exists
if ! id dnsmasq &>/dev/null; then
    echo "[AP] Creating dnsmasq system user..."
    useradd -r -s /usr/sbin/nologin -d /var/lib/misc dnsmasq 2>/dev/null || true
fi
# Ensure the lease file directory exists and is writable
mkdir -p /var/lib/misc
chown -R $(id -u dnsmasq):$(id -g dnsmasq) /var/lib/misc 2>/dev/null || true
touch /var/lib/misc/dnsmasq.leases 2>/dev/null || true
chmod 644 /var/lib/misc/dnsmasq.leases 2>/dev/null || true

# Use the actual username (not numeric UID) — this version of dnsmasq
# can't resolve numeric UIDs via nsswitch in some environments.
DNSMASQ_USER="dnsmasq"
DNSMASQ_GROUP="nogroup"

dnsmasq --conf-file="${DNSMASQ_CONF}" \
        --user="${DNSMASQ_USER}" \
        --group="${DNSMASQ_GROUP}" \
        --pid-file=/run/midirouter-dnsmasq.pid \
        --log-facility=/var/log/midirouter-dnsmasq.log

if ! pidof dnsmasq &> /dev/null; then
    echo "[AP] ERROR: dnsmasq failed to start" >&2
    exit 1
fi
echo "[AP] dnsmasq started (PID: $(pidof dnsmasq))"

# ---- Start hostapd ----
echo "[AP] Starting hostapd..."
hostapd "${HOSTAPD_CONF}" -B \
    -f /var/log/midirouter-hostapd.log \
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
