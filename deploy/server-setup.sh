#!/usr/bin/env bash
# One-time setup + start on a fresh Ubuntu server (e.g. Oracle Cloud Always Free).
# Run from the bot folder:   bash deploy/server-setup.sh
# Safe to re-run: it also rebuilds and restarts the bot after you upload new code.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
    echo "❌ .env is missing. Upload it next to docker-compose.yml first." >&2
    exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
    echo "→ Installing Docker..."
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER"
fi

# Chromium + WhatsApp Web need ~1 GB. Small VMs (e.g. 1 GB AMD micro) get 2 GB swap.
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$mem_mb" -lt 2048 ] && ! swapon --show | grep -q .; then
    echo "→ Only ${mem_mb} MB RAM, adding 2 GB swap..."
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "→ Building and starting the bot..."
sudo docker compose up -d --build

echo
echo "✅ Bot is running. Watch the log (and scan the QR the first time):"
echo "   sudo docker compose logs -f"
