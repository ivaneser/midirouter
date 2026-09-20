# WiFi Access Point (AP) Mode

This directory contains the configuration and scripts to turn your Raspberry Pi into a WiFi access point, making the midirouter web interface accessible wirelessly from phones, tablets, or laptops.

## Features

- **SSID:** `midirouter`
- **Password:** `midirouter`
- **Captive Portal:** Connected clients are automatically redirected to the midirouter web interface (no manual URL entry required)
- **DHCP & DNS:** Clients receive IP settings automatically via dnsmasq
- **Internet Sharing (NAT):** Connected clients can also access the internet through the Pi's Ethernet connection

## Quick Start

### 1. Install Required Packages

```bash
sudo ./install.sh
```

This will:
- Install `hostapd`, `dnsmasq`, and `iptables`
- Configure the AP with SSID `midirouter` and password `midirouter`
- Optionally set up automatic startup on boot

### 2. Start the Access Point

```bash
sudo ./start-ap.sh
```

The AP will start broadcasting, and clients can connect using:
- **Network:** `midirouter`
- **Password:** `midirouter`

Once connected, open a browser — you'll be automatically redirected to the midirouter web interface at `http://10.0.0.1:3000`.

### 3. Stop the Access Point

```bash
sudo ./stop-ap.sh
```

This stops the AP and restores the WiFi interface to managed mode so it can reconnect to your existing network.

## How It Works

### Architecture

```
┌─────────────┐      WiFi (AP Mode)       ┌──────────────┐
│  Clients     │◄────────────────────►│  Raspberry Pi   │
│  (phone,     │    SSID: midirouter    │  wlan0: 10.0.0.1│
│   laptop)    │    PSK: midirouter      │                │
└─────────────┘                          │  hostapd       │
                                         │  dnsmasq (DHCP) │
                                         │  iptables (NAT) │
                                         │                │
                                         │  server.js     │
                                         │  :3000         │
                                         └──────────────┘
                                                      │
                                              ┌──────────────┐
                                              │  eth0        │
                                              │  (Internet)  │
                                              └──────────────┘
```

### Components

| Component | Purpose |
|-----------|---------|
| **hostapd** | Turns the WiFi adapter into an access point with WPA2 security |
| **dnsmasq** | Provides DHCP (IP assignment) and DNS resolution for connected clients |
| **iptables** | Sets up NAT (internet sharing) and redirects web traffic to port 3000 (captive portal) |
| **server.js** | The midirouter Node.js web server that serves the UI over WebSocket |

### Captive Portal

The captive portal works via iptables rules that redirect all HTTP (port 80) and HTTPS (port 443) traffic from connected clients to port 3000, where the midirouter web server handles the request. This means:
- Clients don't need to manually enter `http://10.0.0.1:3000`
- Any attempt to visit a website is redirected to the midirouter UI
- The redirect works for both HTTP and HTTPS connections

## Configuration Files

| File | Description |
|------|-------------|
| `etc/hostapd.conf` | hostapd configuration (SSID, password, channel, security) |
| `etc/dnsmasq.conf` | dnsmasq configuration (DHCP range, DNS settings) |
| `start-ap.sh` | Starts the access point (brings up wlan0 as AP, starts services, configures iptables) |
| `stop-ap.sh` | Stops the access point and cleans up |
| `install.sh` | Installs packages and sets up systemd service for automatic boot |

## Customization

### Change SSID or Password

Edit `etc/hostapd.conf`:
```conf
ssid=YourNewSSID
wpa_passphrase=YourNewPassword
```

Then restart the AP:
```bash
sudo ./stop-ap.sh && sudo ./start-ap.sh
```

### Change the WiFi Channel

In `etc/hostapd.conf`, modify:
```conf
channel=6   # Try 1, 6, or 11 for best compatibility
```

### Change the Web Server Port

If you're running server.js on a different port, update the `WEB_PORT` variable in `start-ap.sh`:
```bash
WEB_PORT=8080
```

## Troubleshooting

### AP doesn't start — "Interface not found"

Make sure your WiFi adapter supports AP mode:
```bash
iw list | grep -i "AP"
```

If you don't see `AP` in the supported interface modes, your WiFi adapter may not support access point mode.

### Clients can connect but no internet

This is expected — clients only have access to the local midirouter UI unless internet sharing is needed. If you want internet access for clients:
1. Make sure `eth0` has an active internet connection
2. Check that iptables MASQUERADE rule is set: `iptables -t nat -L POSTROUTING -n`

### hostapd fails to start

Check the logs:
```bash
journalctl -u midirouter-ap.service -n 50
# or
tail -f /var/log/hostapd.log
```

Common issues:
- Another process is using `wlan0` (stop NetworkManager or nm-applet first)
- The WiFi adapter doesn't support AP mode
- The channel is occupied or not allowed in your region

### dnsmasq won't start on port 53

Another DNS server (like systemd-resolved) might be using port 53. Disable it:
```bash
systemctl stop systemd-resolved
systemctl disable systemd-resolved
```

## Service Management

If you enabled automatic startup during installation, the AP will start on boot via `midirouter-ap.service`:

```bash
# View status
sudo systemctl status midirouter-ap.service

# Start manually
sudo systemctl start midirouter-ap.service

# Stop
sudo systemctl stop midirouter-ap.service

# Disable auto-start
sudo systemctl disable midirouter-ap.service
```

## Security Notes

- The AP uses WPA2-Personal (PSK) with TKIP/CCMP encryption
- The default password `midirouter` should be changed for production use
- Clients on the AP subnet are isolated from your main network (they only reach the Pi itself)
- Internet sharing via NAT is enabled by default — disable it in `start-ap.sh` if not needed

## License

Part of the midirouter project. See the main README for details.
