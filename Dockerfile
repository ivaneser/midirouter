FROM node:20-slim

# Устанавливаем зависимости ALSA и systemd
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libasound2-dev \
        alsa-utils \
        udev \
        supervisor \
    && rm -rf /var/lib/apt/lists/*

# Рабочая директория
WORKDIR /app

# Копируем package.json сначала для кэша npm
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install --production

# Копируем весь проект
COPY . .

# Создаём пользователя midi (не root)
RUN groupadd -g 1000 midi && \
    useradd -m -u 1000 -g midi -s /bin/bash midi

# Настраиваем supervisor для автозапуска
RUN mkdir -p /etc/supervisor/conf.d

EXPOSE 3000

# Запуск от имени пользователя midi с доступом к ALSA
USER midi
CMD ["supervisord", "-c", "/app/docker/etc/supervisord.conf"]
