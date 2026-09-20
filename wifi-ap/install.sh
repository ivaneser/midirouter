#!/usr/bin/env bash
#
# install.sh — Install and configure midirouter WiFi Access Point
#
# Installs hostapd, dnsmasq, and iptables, then configures them for the
# "midirouter" access point. Also sets up a systemd service so the AP
# starts automatically on boot (optional).
#
# Usage: sudo ./install.sh

set -e

SSID="midirouter"
PASSPHRASE="midirouter"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "============================================================"
echo "  midirouter WiFi Access Point — Installer"
echo "============================================================"
echo ""
echo "  This will:"
echo "    1. Install hostapd, dnsmasq, and iptables"
echo "    2. Configure the AP with SSID '${SSID}' and password '${PASSPHRASE}'"
echo "    3. Set up a systemd service for automatic startup (optional)"
echo ""

# ---- Check for root privileges ----
if [ "$EUID" -ne 0 ]; then
    echo "[ERROR] This script must be run as root (use sudo)" >&2
    exit 1
fi

# ---- Update package list ----
echo ""
echo "[1/4] Updating package lists..."
apt-get update

# ---- Install required packages ----
echo ""
echo "[2/4] Installing hostapd, dnsmasq, and iptables..."
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    hostapd \
    dnsmasq \
    iptables \
    iproute2 \
    net-tools

# ---- Configure hostapd to use our config file ----
echo ""
echo "[3/4] Configuring hostapd..."

# Backup existing hostapd config
if [ -f /etc/hostapd/hostapd.conf ]; then
    cp /etc/hostapd/hostapd.conf /etc/hostapd/hostapd.conf.bak.$(date +%s)
fi

# Copy our config
cp "${SCRIPT_DIR}/etc/hostapd.conf" /etc/hostapd/hostapd.conf

# Update the default hostapd configuration to point to our config file
if [ -f /etc/default/hostapd ]; then
    sed -i 's|^#DAEMON_CONF=.*|DAEMON_CONF="/etc/hostapd/hostapd.conf"|' /etc/default/hostapd
    # Disable the automatic starting of hostapd via systemd (we manage it ourselves)
    sed -i 's/^DAEMON_CONF=.*/# DAEMON_CONF is managed by midirouter start-ap.sh/' /etc/default/hostapd
fi

# ---- Configure dnsmasq ----
echo ""
echo "[4/4] Configuring dnsmasq..."

# Backup existing dnsmasq config
if [ -f /etc/dnsmasq.conf ]; then
    cp /etc/dnsmasq.conf /etc/dnsmasq.conf.bak.$(date +%s)
fi

# Create a dedicated dnsmasq configuration directory for midirouter
mkdir -p /etc/dnsmasq.d/midirouter
cp "${SCRIPT_DIR}/etc/dnsmasq.conf" /etc/dnsmasq.d/midirouter/dnsmasq.conf

# Disable the default dnsmasq that might be running with NetworkManager
systemctl disable dnsmasq 2>/dev/null || true

# ---- Optional: Set up systemd service for automatic AP startup ----
read -p "  Start the AP automatically on boot? (y/N): " START_ON_BOOT
if [[ "$START_ON_BOOT" =~ ^[Yy]$ ]]; then
    echo ""
    echo "  Setting up midirouter-ap.service..."
    
    cat > /etc/systemd/system/midirouter-ap.service << 'EOF'
[Unit]
Description=midirouter WiFi Access Point
After=network.target

[Service]
Type=forking
ExecStart=/home/pi/myprojects/midirouter/wifi-ap/start-ap.sh
ExecStop=/home/pi/myprojects/midirouter/wifi-ap/stop-ap.sh
Restart=on-failure
RestartSec=3s

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable midirouter-ap.service
    
    echo "  ✓ Service enabled. Starting now..."
    systemctl start midirouter-ap.service
    
    # Show status
    sleep 2
    systemctl status midirouter-ap.service --no-pager 2>/dev/null || true
fi

echo ""
echo "============================================================"
echo "  Installation complete!"
echo ""
echo "  To start the AP manually:"
echo "    sudo ${SCRIPT_DIR}/start-ap.sh"
echo ""
echo "  To stop the AP manually:"
echo "    sudo ${SCRIPT_DIR}/stop-ap.sh"
echo ""
echo "  Access the web interface at: http://10.0.0.1:3000"
echo "============================================================"
echo ""
