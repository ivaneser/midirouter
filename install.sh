#!/bin/bash
# === Install script for Raspberry Pi 4 — MIDI Router ===
# Minimal routing latency (<2 ms) via Worker Thread + ALSA
# Run: chmod +x install.sh && sudo ./install.sh

set -e

echo "=========================================="
echo "  MIDI Router — Installation on Raspberry Pi"
echo "  Goal: minimal routing latency"
echo "=========================================="

# Check that this is a Raspberry Pi
if [ ! -f /proc/device-tree/model ]; then
    echo "❌ This script is intended only for Raspberry Pi"
    exit 1
fi

echo "✅ Detected: $(cat /proc/device-tree/model)"
uname -r

# Update the system (minimal)
echo ""
echo "📦 Updating packages..."
apt-get update -y --quiet
apt-get upgrade -y --quiet

# Install dependencies for ALSA and Node.js
echo ""
echo "🔧 Installing dependencies..."
apt-get install -y \
    libasound2-dev \
    alsa-utils \
    udev \
    curl \
    git-core \
    jq \
    supervisor \
    sudo

# Create user midi (if it does not exist)
if ! id -u midi >/dev/null 2>&1; then
    echo "👤 Creating user 'midi'..."
    addgroup --system midi
    adduser --system --ingroup midi midi
fi

# Install Node.js if it is missing
if ! command -v node &> /dev/null; then
    echo "📦 Installing Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

echo "✅ Node.js: $(node --version)"

# Clone the project (or update it if it already exists)
PROJECT_DIR="/home/midi/myprojects/midirouter"
if [ ! -d "$PROJECT_DIR/.git" ]; then
    echo ""
    echo "📂 Cloning the project..."
    mkdir -p /home/midi/myprojects
    git clone https://github.com/ivaneser/midirouter.git "$PROJECT_DIR"
else
    echo "✅ Project already present, updating..."
    cd "$PROJECT_DIR" && git pull || true
fi

# Install npm dependencies
echo ""
echo "📦 npm install..."
cd "$PROJECT_DIR"
npm install --production --quiet
bash "${PROJECT_DIR}/setup-shutdown-permissions.sh" midi

# ==========================================
# PREEMPT_RT KERNEL — for minimal latency
# ==========================================
echo ""
echo "⚙️ Configuring the REAL-TIME kernel..."

RT_KERNEL_PKG="linux-image-rt-rpi"

# Check the supported kernel version
if dpkg -l | grep -q linux-image-6.1; then
    RT_KERNEL_PKG="linux-image-rt-rpi-6.1"
elif dpkg -l | grep -q linux-image-6.6; then
    RT_KERNEL_PKG="linux-image-rt-rpi-6.6"
fi

# Try to install the PREEMPT_RT kernel
if apt-cache search "$RT_KERNEL_PKG" | grep -q "$RT_KERNEL_PKG"; then
    echo "🔧 Installing PREEMPT_RT kernel: $RT_KERNEL_PKG"
    apt-get install -y --allow-change-held-packages "$RT_KERNEL_PKG" || {
        echo "⚠️ PREEMPT_RT is not available for the current kernel, continuing with the standard one..."
    }
else
    echo "ℹ️  PREEMPT_RT not found — using the standard kernel"
fi

# sysctl settings for realtime scheduling
cat > /etc/sysctl.d/99-midi-rt.conf << 'EOF'
# Real-time scheduling limits for MIDI worker
kernel.sched_rt_runtime_us=950000
kernel.sched_rt_period_us=1000000

# Increase shared memory for IPC (MIDI messages)
kernel.shmmax=68719476736
kernel.shmall=4294967296

# Reduce swappiness — keep MIDI data in RAM
vm.swappiness=10

# ALSA buffer settings
fs.inotify.max_user_watches=524288
EOF

sysctl -p /etc/sysctl.d/99-midi-rt.conf 2>/dev/null || true

# ==========================================
# Process priority and access rights
# ==========================================
echo ""
echo "⚙️ Configuring ALSA permissions..."

# UDEV rules for MIDI devices
cat > /etc/udev/rules.d/99-midi.rules << 'EOF'
# Access to ALSA devices for group midi
SUBSYSTEM=="snd", GROUP="midi", MODE="0660"
KERNEL=="seq", GROUP="midi", MODE="0660"
KERNEL=="timer", GROUP="midi", MODE="0660"

# USB MIDI devices — apply permissions immediately
ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="*", ATTR{idProduct}=="*", GROUP="midi"
EOF

udevadm control --reload-rules 2>/dev/null || true

# ==========================================
# Supervisor — autostart for worker + server
# ==========================================
echo ""
echo "🔄 Configuring autostart..."

cat > /etc/supervisor/conf.d/midirouter.conf << 'EOF'
[program:midirouter-worker]
command=node /home/midi/myprojects/midirouter/worker-midi.js
directory=/home/midi/myprojects/midirouter
user=midi
autostart=true
autorestart=true
stderr_logfile=/var/log/midirouter-worker.err.log
stdout_logfile=/var/log/midirouter-worker.out.log
environment=NODE_ENV="production",ALSA_RT_PRIORITY="true"

[program:midirouter-server]
command=node /home/midi/myprojects/midirouter/server.js
directory=/home/midi/myprojects/midirouter
user=midi
autostart=true
autorestart=true
stderr_logfile=/var/log/midirouter-server.err.log
stdout_logfile=/var/log/midarouter-server.out.log
environment=NODE_ENV="production"

# Wait for the worker to be ready before starting the server
[program:midirouter]
command=node /home/midi/myprojects/midirouter/server.js
directory=/home/midi/myprojects/midirouter
user=midi
autostart=true
autorestart=true
stderr_logfile=/var/log/midarouter.err.log
stdout_logfile=/var/log/midarouter.out.log
environment=NODE_ENV="production"
EOF

# ==========================================
# Start the services
# ==========================================
echo ""
echo "🚀 Starting MIDI Router..."

supervisorctl reread 2>/dev/null || true
supervisorctl update 2>/dev/null || true

# Try to start directly if the supervisor does not work
if ! supervisorctl status midirouter-worker &>/dev/null; then
    echo "⚠️ Supervisor unavailable, starting manually..."
    cd "$PROJECT_DIR" && node server.js &
else
    sleep 3
fi

# Check
sleep 2
echo ""
echo "=========================================="
if supervisorctl status midirouter-worker &>/dev/null || pgrep -f "midirouter" >/dev/null; then
    echo "✅ MIDI Router is running!"
    echo ""
    echo "🌐 Web interface: http://<IP_RASPBERRY_PI>:3000"
    echo "📋 Worker logs:   sudo tail -f /var/log/midarouter-worker.out.log"
    echo "📋 Server logs:    sudo tail -f /var/log/midirouter-server.out.log"
    echo ""
    echo "⚡ Architecture:"
    echo "   Worker Thread → ALSA callback (<2 ms routing)"
    echo "   WebSocket     → UI control"
    echo "=========================================="
else
    echo "❌ Startup error! Check the logs:"
    echo "   sudo tail -10 /var/log/midirouter-worker.err.log"
    echo "   sudo tail -10 /var/log/midarouter-server.err.log"
fi
