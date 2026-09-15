#!/bin/bash
# === MIDI Emulator Setup Script ===
# Загружает виртуальные MIDI порты для тестирования роутера
# Работает после перезагрузки системы

set -e

echo "[MIDI SETUP] Starting virtual MIDI port setup..."

# Проверяем что модули ещё не загружены
if lsmod | grep -q snd_seq_dummy; then
    echo "[MIDI SETUP] Removing existing modules..."
    sudo rmmod snd_seq_virmidi 2>/dev/null || true
    sudo rmmod snd_seq_dummy 2>/dev/null || true
fi

# Проверяем текущий режим UMP
UMP_ENABLED=$(cat /sys/module/snd_seq/parameters/enable_ump 2>/dev/null || echo "1")
echo "[MIDI SETUP] Current UMP mode: $UMP_ENABLED"

if [ "$UMP_ENABLED" = "1" ]; then
    echo "[MIDI SETUP] Disabling UMP mode..."
    
    # Пытаемся отключить через sysfs (работает если модуль ещё не в use)
    if echo 0 | sudo tee /sys/module/snd_seq/parameters/enable_ump >/dev/null 2>&1; then
        echo "[MIDI SETUP] UMP disabled via sysfs"
    else
        # Перегружаем модуль с параметрами (нужен чистый kernel)
        echo "[MIDI SETUP] Reloading snd_seq with enable_ump=0..."
        
        # Удаляем зависимые модули
        sudo rmmod snd_seq_virmidi 2>/dev/null || true
        sudo rmmod snd_seq_dummy 2>/dev/null || true
        
        # Удаляем сам seq (может не сработать если используется)
        if ! sudo modprobe -r snd_seq 2>/dev/null; then
            echo "[MIDI SETUP] WARNING: Cannot remove snd_seq — it's in use"
            echo "[MIDI SETUP] Continuing with UMP mode enabled..."
            
            # Если не можем удалить, пробуем загрузить dummy/virmidi как есть
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
        
        # Загружаем seq с отключённым UMP
        sudo modprobe snd-seq enable_ump=0 midi_devs=2 virmidi_midi_devs=2 dummy_midi_devs=2
    fi
    
    # Загружаем дополнительные модули
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

# Ожидание загрузки модулей
sleep 2

# Проверяем что порты появились
PORTS=$(aconnect -o 2>/dev/null | grep -c "client [0-9]" || true)
if [ "$PORTS" -gt 0 ]; then
    echo "[MIDI SETUP] ✓ Virtual MIDI ports ready:"
    aconnect -o
    
    # Показываем input порты тоже
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
