#!/bin/bash
# === Install Script для Raspberry Pi 4 — MIDI Router ===
# Минимальная задержка роутинга (<2мс) через Worker Thread + ALSA
# Запуск: chmod +x install.sh && sudo ./install.sh

set -e

echo "=========================================="
echo "  MIDI Router — Установка на Raspberry Pi"
echo "  Цель: минимальная задержка роутинга"
echo "=========================================="

# Проверка что это Raspberry Pi
if [ ! -f /proc/device-tree/model ]; then
    echo "❌ Этот скрипт предназначен только для Raspberry Pi"
    exit 1
fi

echo "✅ Обнаружен: $(cat /proc/device-tree/model)"
uname -r

# Обновляем систему (минимально)
echo ""
echo "📦 Обновление пакетов..."
apt-get update -y --quiet
apt-get upgrade -y --quiet

# Устанавливаем зависимости для ALSA и Node.js
echo ""
echo "🔧 Установка зависимостей..."
apt-get install -y \
    libasound2-dev \
    alsa-utils \
    udev \
    curl \
    git-core \
    jq \
    supervisor

# Создаём пользователя midi (если не существует)
if ! id -u midi >/dev/null 2>&1; then
    echo "👤 Создание пользователя 'midi'..."
    addgroup --system midi
    adduser --system --ingroup midi midi
fi

# Устанавливаем Node.js если нет
if ! command -v node &> /dev/null; then
    echo "📦 Установка Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

echo "✅ Node.js: $(node --version)"

# Клонирование проекта (или обновление если уже есть)
PROJECT_DIR="/home/midi/myprojects/midirouter"
if [ ! -d "$PROJECT_DIR/.git" ]; then
    echo ""
    echo "📂 Клонирование проекта..."
    mkdir -p /home/midi/myprojects
    git clone https://github.com/ivaneser/midirouter.git "$PROJECT_DIR"
else
    echo "✅ Проект уже есть, обновляем..."
    cd "$PROJECT_DIR" && git pull || true
fi

# Установка npm зависимостей
echo ""
echo "📦 npm install..."
cd "$PROJECT_DIR"
npm install --production --quiet

# ==========================================
# PREEMPT_RT ЯДРО — для минимальной задержки
# ==========================================
echo ""
echo "⚙️ Настройка REAL-TIME ядра..."

RT_KERNEL_PKG="linux-image-rt-rpi"

# Проверяем поддерживаемую версию ядра
if dpkg -l | grep -q linux-image-6.1; then
    RT_KERNEL_PKG="linux-image-rt-rpi-6.1"
elif dpkg -l | grep -q linux-image-6.6; then
    RT_KERNEL_PKG="linux-image-rt-rpi-6.6"
fi

# Пытаемся установить PREEMPT_RT ядро
if apt-cache search "$RT_KERNEL_PKG" | grep -q "$RT_KERNEL_PKG"; then
    echo "🔧 Установка PREEMPT_RT ядра: $RT_KERNEL_PKG"
    apt-get install -y --allow-change-held-packages "$RT_KERNEL_PKG" || {
        echo "⚠️ PREEMPT_RT недоступен для текущего ядра, продолжаем с обычным..."
    }
else
    echo "ℹ️  PREEMPT_RT не найден — используем стандартное ядро"
fi

# Настройка sysctl для realtime планирования
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
# Приоритет процесса и права доступа
# ==========================================
echo ""
echo "⚙️ Настройка прав ALSA..."

# UDEV правила для MIDI устройств
cat > /etc/udev/rules.d/99-midi.rules << 'EOF'
# Доступ к ALSA устройствам для группы midi
SUBSYSTEM=="snd", GROUP="midi", MODE="0660"
KERNEL=="seq", GROUP="midi", MODE="0660"
KERNEL=="timer", GROUP="midi", MODE="0660"

# USB MIDI устройства — мгновенное назначение прав
ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="*", ATTR{idProduct}=="*", GROUP="midi"
EOF

udevadm control --reload-rules 2>/dev/null || true

# ==========================================
# Supervisor — автозапуск worker + server
# ==========================================
echo ""
echo "🔄 Настройка автозапуска..."

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

# Ждём готовности воркера перед запуском сервера
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
# Запуск сервисов
# ==========================================
echo ""
echo "🚀 Запуск MIDI Router..."

supervisorctl reread 2>/dev/null || true
supervisorctl update 2>/dev/null || true

# Пробуем запустить напрямую если supervisor не работает
if ! supervisorctl status midirouter-worker &>/dev/null; then
    echo "⚠️ Supervisor недоступен, запускаем вручную..."
    cd "$PROJECT_DIR" && node server.js &
else
    sleep 3
fi

# Проверка
sleep 2
echo ""
echo "=========================================="
if supervisorctl status midirouter-worker &>/dev/null || pgrep -f "midirouter" >/dev/null; then
    echo "✅ MIDI Router запущен!"
    echo ""
    echo "🌐 Веб-интерфейс: http://<IP_RASPBERRY_PI>:3000"
    echo "📋 Логи воркера:   sudo tail -f /var/log/midarouter-worker.out.log"
    echo "📋 Логи сервера:    sudo tail -f /var/log/midirouter-server.out.log"
    echo ""
    echo "⚡ Архитектура:"
    echo "   Worker Thread → ALSA callback (<2мс роутинг)"
    echo "   WebSocket     → UI управление"
    echo "=========================================="
else
    echo "❌ Ошибка запуска! Проверьте логи:"
    echo "   sudo tail -10 /var/log/midirouter-worker.err.log"
    echo "   sudo tail -10 /var/log/midarouter-server.err.log"
fi
