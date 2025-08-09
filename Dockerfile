# Multi-stage build: Frontend (Vite) + Backend (Express + discord.js)

# --- Build frontend (npm) ---
FROM node:20-slim AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install --no-audit --no-fund
COPY web/ .
# Umgebungsvariable für React Build verfügbar machen (Vite liest nur VITE_*)
ARG VITE_BUILD_CHANNEL=stable
ENV VITE_BUILD_CHANNEL=$VITE_BUILD_CHANNEL
RUN npm run build

# --- Build server (npm) ---
FROM node:20-slim AS server-build
WORKDIR /app/server
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY server/package*.json ./
RUN npm install --no-audit --no-fund
COPY server/ .
RUN npm run build
# Nur Prod-Dependencies für Runtime behalten
RUN npm prune --omit=dev

# --- Runtime image ---
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV SOUNDS_DIR=/data/sounds

RUN apt-get update && apt-get install -y ffmpeg curl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && yt-dlp --version || true

COPY --from=server-build /app/server/dist ./server/dist
COPY --from=server-build /app/server/node_modules ./server/node_modules
COPY --from=server-build /app/server/package.json ./server/package.json
COPY --from=web-build /app/web/dist ./web/dist

EXPOSE 8080
VOLUME ["/data/sounds"]
CMD ["node", "server/dist/index.js"]



