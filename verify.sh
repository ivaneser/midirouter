#!/usr/bin/env bash
# =============================================================================
#  verify.sh  —  Check that midirouter is healthy and ready
# =============================================================================
set -uo pipefail

RED='\033[0;31m'; GRN='\033[0;32m'; YEL='\033[1;33m'; BLU='\033[0;34m'; NC='\033[0m'
PASS=0; FAIL=0; WARN=0

pass() { echo -e "  ${GRN}✔${NC} $1"; ((PASS++)); }
fail() { echo -e "  ${RED}✘${NC} $1"; ((FAIL++)); }
warn() { echo -e "  ${YEL}⚠${NC} $1"; ((WARN++)); }
info() { echo -e "  ${BLU}ℹ${NC} $1"; }

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "========================================"
echo "  MIDI Router — System Verification"
echo "  Repo: ${REPO_DIR}"
echo "========================================"

# ---- 1. Node.js + npm --------------------------------------------
echo ""
echo "--- 1. Node.js & Dependencies ---"
if command -v node &>/dev/null; then
    NODEV=$(node --version)
    pass "Node.js installed: ${NODEV}"
else
    fail "Node.js not found (run bootstrap.sh)"; fi

if [ -d "${REPO_DIR}/node_modules" ]; then
    pass "node_modules exists"
else
    warn "node_modules missing — run: npm install"; fi

# ---- 2. systemd services ------------------------------------------
echo ""
echo "--- 2. Systemd Services ---"
for svc in midirouter metronome; do
    if systemctl is-enabled "${svc}.service" &>/dev/null; then
        pass "${svc}.service: enabled"
    else
        fail "${svc}.service: NOT enabled (run enable-autostart.sh)"; fi

    if systemctl is-active --quiet "${svc}.service"; then
        pass "${svc}.service: running"
    else
        fail "${svc}.service: NOT running"; fi
done

# ---- 3. WebSocket server port --------------------------------------
echo ""
echo "--- 3. Web Server ---"
if ss -tlnp 2>/dev/null | grep -q ':3000'; then
    PID=$(lsof -t -i:3000 2>/dev/null || true)
    pass "Port 3000 is listening (PID: ${PID:-?})"
else
    fail "Port 3000 is NOT listening"; fi

# ---- 4. MIDI ports (ALSA) ------------------------------------------
echo ""
echo "--- 4. ALSA MIDI Ports ---"
if command -v aconnect &>/dev/null; then
    IN_COUNT=$(aconnect -i 2>/dev/null | grep -c 'client ' || echo 0)
    OUT_COUNT=$(aconnect -o 2>/dev/null | grep -c 'client ' || echo 0)
    if [ "$IN_COUNT" -gt 0 ] || [ "$OUT_COUNT" -gt 0 ]; then
        pass "ALSA MIDI ports found: ${IN_COUNT} inputs, ${OUT_COUNT} outputs"
        echo ""
        echo "    Inputs:"
        aconnect -i 2>/dev/null | grep '^client ' | sed 's/^/      /'
        echo "    Outputs:"
        aconnect -o 2>/dev/null | grep '^client ' | sed 's/^/      /'
    else
        warn "No ALSA MIDI ports detected — plug in a controller/synth"
    fi
else
    fail "aconnect not found — install alsa-utils"; fi

# ---- 5. Audio output (headphones) ----------------------------------
echo ""
echo "--- 5. Audio Output ---"
HP=$(aplay -L 2>/dev/null | grep -i 'headphone' | head -1)
bcm=$(grep -ic 'headphone\|bcm2835' /proc/asound/cards 2>/dev/null || echo 0)
if [ -n "$HP" ] || [ "$bcm" -gt 0 ]; then
    pass "Headphone device found ($(if [ -n "$HP" ]; then echo "$HP"; else echo "bcm2835"; fi))"
    ALSA_MIXER=$(amixer scontrols 2>/dev/null | grep -i 'headphone\|master\|PCM' | head -1)
    if [ -n "$ALSA_MIXER" ]; then
        info "Mixer control: ${ALSA_MIXER}"
    fi
else
    warn "Headphone device not found in aplay -L"; fi

if pgrep -f "metronome.py" >/dev/null; then
    pass "metronome.py process is running"
else
    warn "metronome.py process NOT running"; fi

# ---- 6. Node processes ---------------------------------------------
echo ""
echo "--- 6. Node.js Processes ---"
NODE_PIDS=$(pgrep -f "node server.js" || true)
if [ -n "$NODE_PIDS" ]; then
    for PID in $NODE_PIDS; do
        CPU=$(ps -p "$PID" -o %cpu= 2>/dev/null || echo "?")
        MEM=$(ps -p "$PID" -o %mem= 2>/dev/null || echo "?")
        pass "server.js PID ${PID}: CPU ${CPU}% / MEM ${MEM}%"
    done
else
    fail "node server.js NOT running"; fi

WRK_PIDS=$(pgrep -f "worker-midi.js" || true)
if [ -n "$WRK_PIDS" ]; then
    for PID in $WRK_PIDS; do
        CPU=$(ps -p "$PID" -o %cpu= 2>/dev/null || echo "?")
        MEM=$(ps -p "$PID" -o %mem= 2>/dev/null || echo "?")
        pass "worker-midi.js PID ${PID}: CPU ${CPU}% / MEM ${MEM}%"
    done
else
    warn "worker-midi.js worker PID not visible (normal if inside threads)"; fi

# ---- 7. Python processes -------------------------------------------
echo ""
echo "--- 7. Python Processes ---"
PY_PIDS=$(pgrep -f "metronome.py" || true)
if [ -n "$PY_PIDS" ]; then
    for PID in $PY_PIDS; do
        CPU=$(ps -p "$PID" -o %cpu= 2>/dev/null || echo "?")
        MEM=$(ps -p "$PID" -o %mem= 2>/dev/null || echo "?")
        pass "metronome.py PID ${PID}: CPU ${CPU}% / MEM ${MEM}%"
    done
else
    warn "No metronome.py running (OK if not yet started)"; fi

# ---- 8. Logs last lines --------------------------------------------
echo ""
echo "--- 8. Recent Logs ---"
for svc in midirouter metronome; do
    if systemctl is-active --quiet "${svc}.service"; then
        LAST_LINE=$(journalctl -u "${svc}.service" --no-pager -n 1 --quiet 2>/dev/null || true)
        if [ -n "$LAST_LINE" ]; then
            echo "  ${BLU}${svc}:${NC} ${LAST_LINE:0:90}"
        fi
    fi
done

# ---- 9. Web UI accessibility ---------------------------------------
echo ""
echo "--- 9. Web UI ---"
LOCAL_TEST=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000 2>/dev/null || echo "000")
if [ "$LOCAL_TEST" = "200" ]; then
    pass "Web UI reachable at http://127.0.0.1:3000"
else
    warn "Web UI returned HTTP ${LOCAL_TEST} on localhost"
fi
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "$IP" ]; then
    info "Try from another device: http://${IP}:3000"
fi

# ---- 10. Files check -----------------------------------------------
echo ""
echo "--- 10. Files ---"
for f in server.js worker-midi.js daw.js metronome.py metronome-controller.js frontend/index.html; do
    if [ -f "${REPO_DIR}/${f}" ]; then
        pass "${f} present"
    else
        fail "${f} MISSING"; fi
done

# ---- Summary -------------------------------------------------------
echo ""
echo "========================================"
echo "  Results: ${GRN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${YEL}${WARN} warnings${NC}"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "Fix failures, then rerun:"
    echo "  bash verify.sh"
    exit 1
fi

if [ "$WARN" -gt 0 ]; then
    echo ""
    echo "Warnings are only informational — system should still work."
fi

echo ""
echo "Quick commands:"
echo "  bash enable-autostart.sh    — enable services"
echo "  bash disable-autostart.sh   — disable services"
echo "  sudo systemctl restart midirouter.service"
echo "  sudo systemctl restart metronome.service"
echo ""
