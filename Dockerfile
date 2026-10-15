FROM node:20-slim

# Install ALSA and systemd dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libasound2-dev \
        alsa-utils \
        udev \
        supervisor \
    && rm -rf /var/lib/apt/lists/*

# Working directory
WORKDIR /app

# Copy package.json first for npm caching
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the whole project
COPY . .

# Create user midi (not root)
RUN groupadd -g 1000 midi && \
    useradd -m -u 1000 -g midi -s /bin/bash midi

# Set up supervisor for autostart
RUN mkdir -p /etc/supervisor/conf.d

EXPOSE 3000

# Run as user midi with access to ALSA
USER midi
CMD ["supervisord", "-c", "/app/docker/etc/supervisord.conf"]
