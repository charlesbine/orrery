# syntax=docker/dockerfile:1

# ── Target 1: networkless, socketless roster sync worker ──────────────────
FROM node:22-alpine AS sync
WORKDIR /app

COPY package.json ./
COPY bin/ ./bin/
COPY dev/sync.js dev/layout.js ./dev/
RUN mkdir -p /generated && chown node:node /generated

USER node
ENV ORRERY_OUTPUT=/generated/services.js \
    ORRERY_HEARTBEAT=/tmp/.orrery-sync-heartbeat
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e 'const fs=require("fs"),out=process.env.ORRERY_OUTPUT||"/generated/services.js",hb=process.env.ORRERY_HEARTBEAT||"/tmp/.orrery-sync-heartbeat",maxAge=Number(process.env.ORRERY_HEARTBEAT_MAX_AGE_MS||120000);const os=fs.statSync(out),hs=fs.statSync(hb);if(!os.size||Date.now()-hs.mtimeMs>maxAge)process.exit(1);'

ENTRYPOINT ["node", "/app/bin/orrery.js"]
CMD ["sync", "--config", "/config/orrery.config.json", "--root", "/config", "--output", "/generated/services.js", "--watch"]

# ── Target 2: static web server (default) ─────────────────────────────────
FROM caddy:2-alpine AS web
COPY Caddyfile /etc/caddy/Caddyfile
COPY src/ /srv/
RUN mkdir -p /srv/generated && chown -R 1000:1000 /srv/generated
EXPOSE 8080
