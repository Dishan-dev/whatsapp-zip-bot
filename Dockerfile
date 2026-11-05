# WhatsApp ZIP bot. Works on x86 and ARM (e.g. Oracle Cloud's free Ampere VMs).
# Uses Debian's Chromium because Puppeteer's bundled Chrome has no ARM Linux build.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true \
    SESSION_DIR=/data/session \
    HEADLESS=true

WORKDIR /app

# postinstall applies scripts/patch-wwebjs.js, so it has to be here before npm ci
COPY package.json package-lock.json .puppeteerrc.cjs ./
COPY scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js ./

# The WhatsApp login lives on this volume so it survives restarts and updates
RUN mkdir -p /data/session && chown -R node:node /data /app
VOLUME /data
USER node

CMD ["node", "index.js"]
