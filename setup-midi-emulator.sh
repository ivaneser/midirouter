#!/bin/bash
# === MIDI Emulator Setup Script ===
# Loads virtual MIDI ports for testing the router
# Works after a system reboot

set -e

echo "[MIDI SETUP] Starting virtual MIDI port setup..."

# Check that the modules are not loaded yet
if lsmod | grep -q snd_seq_dummy; then
    echo "[MIDI SETUP] Removing existing modules..."
    sudo rmmod snd_seq_virmidi 2>/dev/null || true
    sudo rmmod snd_seq_dummy 2>/dev/null || true
fi

# Check the current UMP mode
UMP_ENABLED=$(cat /sys/module/snd_seq/parameters/enable_ump 2>/dev/null || echo "1")
echo "[MIDI SETUP] Current UMP mode: $UMP_ENABLED"

if [ "$UMP_ENABLED" = "1" ]; then
    echo "[MIDI SETUP] Disabling UMP mode..."
    
    # Try to disable it via sysfs (works if the module is not in use yet)
    if echo 0 | sudo tee /sys/module/snd_seq/parameters/enable_ump >/dev/null 2>&1; then
        echo "[MIDI SETUP] UMP disabled via sysfs"
    else
        # Reload the module with parameters (needs a clean kernel)
        echo "[MIDI SETUP] Reloading snd_seq with enable_ump=0..."
        
        # Remove dependent modules
        sudo rmmod snd_seq_virmidi 2>/dev/null || true
        sudo rmmod snd_seq_dummy 2>/dev/null || true
        
        # Remove seq itself (may fail if it is in use)
        if ! sudo modprobe -r snd_seq 2>/dev/null; then
            echo "[MIDI SETUP] WARNING: Cannot remove snd_seq — it's in use"
            echo "[MIDI SETUP] Continuing with UMP mode enabled..."
            
            # If we cannot remove it, try loading dummy/virmidi as is
            sudo modprobe snd-seq-dummy midi_devs=2 2>/dev/null || {
                echo "[MIDI SETUP] ERROR: Failed to load snd-seq-dummy"
                exit 1
            }
            sudo modprobe snd-seq-virmidi midi_devs=2 2>/dev/null || {
                echo "[MIDI SETUP] ERROR: Failed to load snd-seq-virmidi"
                exit 1
            }
            
            sleep 1
            PORTS=$(aconnect -o 2>/dev/null | grep -c "client [0-9]" || true)
            if [ "$PORTS" -gt 0 ]; then
                echo "[MIDI SETUP] ✓ Ports ready (UMP mode):"
                aconnect -o
                exit 0
            else
                echo "[MIDI SETUP] ✗ No ports detected in UMP mode"
                exit 1
            fi
        fi
        
        sleep 1
        
        # Load seq with UMP disabled
        sudo modprobe snd-seq enable_ump=0 midi_devs=2 virmidi_midi_devs=2 dummy_midi_devs=2
    fi
    
    # Load additional modules
    sudo modprobe snd-seq-dummy midi_devs=2 2>/dev/null || true
    sudo modprobe snd-seq-virmidi midi_devs=2 2>/dev/null || true
else
    echo "[MIDI SETUP] UMP already disabled, loading modules..."
    sudo modprobe snd-seq-dummy midi_devs=2 2>/dev/null || {
        echo "[MIDI SETUP] ERROR: Failed to load snd-seq-dummy"
        exit 1
    }
    sudo modprobe snd-seq-virmidi midi_devs=2 2>/dev/null || {
        echo "[MIDI SETUP] ERROR: Failed to load snd-seq-virmidi"
        exit 1
    }
fi

# Wait for the modules to load
sleep 2

# Check that the ports appeared
PORTS=$(aconnect -o 2>/dev/null | grep -c "client [0-9]" || true)
if [ "$PORTS" -gt 0 ]; then
    echo "[MIDI SETUP] ✓ Virtual MIDI ports ready:"
    aconnect -o
    
    # Show the input ports too
    INPUT_PORTS=$(aconnect -i 2>/dev/null | grep -c "client [0-9]" || true)
    if [ "$INPUT_PORTS" -gt 0 ]; then
        echo ""
        echo "[MIDI SETUP] Input ports:"
        aconnect -i
    fi
    
    echo ""
    echo "[MIDI SETUP] Setup complete! Ready for testing."
    exit 0
else
    echo "[MIDI SETUP] ✗ No virtual ports detected"
    echo "[MIDI SETUP] Check dmesg | grep snd_seq for errors:"
    dmesg | grep -i snd_seq || true
    exit 1
fi
