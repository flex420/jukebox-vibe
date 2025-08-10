# Jukebox 420 – Discord Soundboard (v1.1.2)

A modern, self‑hosted Discord soundboard with a slick web UI and a Discord bot that plays sounds into your voice channels. Easy to run via Docker, fun to use with friends.

![Version](https://img.shields.io/badge/version-1.1.2-blue)
![Docker](https://img.shields.io/badge/docker-ready-green)
![Discord](https://img.shields.io/badge/discord-bot-purple)

## ✨ Features

- Web UI (Vite + React + TypeScript), 3 themes (Dark, Rainbow, 420)
- Discord bot (discord.js + @discordjs/voice)
- MP3 & WAV playback, ffmpeg normalization
- Favorites, search, folders view (auto counters)
- Live counters and a clean header/footer
- Admin area: bulk delete, inline rename, categories (CRUD) + bulk assign, remove custom badges
- Partymode: server‑side random playback every 30–90 seconds, globally synced via SSE; Panic stops for everyone
- Persistent state: volumes, plays, totalPlays, categories, badges in `/data/sounds/state.json`
- Entrance/Exit sounds: per‑user sounds played when joining/leaving voice; users set them via DM (`?entrance`, `?exit`); Exit plays only on disconnect (not on channel switch)

## 🚀 Quick start

### 1. Requirements
- Docker & Docker Compose
- Discord bot token with intents: `Guilds`, `GuildVoiceStates`, `DirectMessages`

### 2. Setup
```bash
# Clone repository
git clone https://github.com/flex420/jukebox-vibe.git
cd jukebox-vibe

# Create .env
cp .env.example .env
```

### 3. Configuration
```env
# Edit the .env file
DISCORD_TOKEN=your_discord_bot_token_here
ADMIN_PWD=choose-a-strong-password
PORT=8080
SOUNDS_DIR=/data/sounds

# Optionally restrict allowed guilds
ALLOWED_GUILD_IDS=GUILD_ID_1,GUILD_ID_2
```

### 4. Deployment
```bash
# Start container
docker compose up --build -d

# Logs
docker compose logs -f

# Status
docker compose ps
```

### 5. Access
- **Web-Interface**: `http://localhost:8199`
- **Health Check**: `http://localhost:8199/api/health`

## 🎯 Usage

### **Getting started**
1. Invite the Discord bot with voice permissions
2. Upload sounds via DM to the bot (MP3/WAV)
3. Open the web UI and choose a theme
4. Select a voice channel and play sounds

### **Admin panel**
1. Log in with the admin password
2. Select sounds via checkboxes
3. Perform bulk delete or rename
4. Logout to finish

### **URL downloads**
- Enter MP3/WAV links into the URL field
- Click Download
- The file will be added automatically to the soundboard

## 🎨 Themes

### **Dark Theme**
- Klassisches dunkles Design
- Blaue Akzente (#0a84ff)
- Glassmorphism-Effekte

### **Rainbow Theme**
- Animierter Regenbogen-Hintergrund
- Bunte Borders und Effekte
- 15s Animation-Loop

### **420 Theme**
- Cannabis-grüne Farbpalette
- Trippy animierte Gradienten
- 20s Animation-Loop
- Grüne Glow-Effekte

## 📊 API endpoints

### **Public Endpoints**
```http
GET  /api/health          # Health Check + Statistiken
GET  /api/sounds          # Sound-Liste mit Ordner-Struktur
GET  /api/channels        # Voice-Channel Liste
POST /api/play            # Sound abspielen
POST /api/play-url        # URL downloaden & abspielen
POST /api/stop            # Aktuellen Sound stoppen
GET  /api/volume          # Volume abrufen
POST /api/volume          # Volume setzen
```

### **Admin endpoints**
```http
POST /api/admin/login     # Admin-Login
POST /api/admin/logout    # Admin-Logout
GET  /api/admin/status    # Login-Status
POST /api/admin/sounds/delete  # Sounds löschen
POST /api/admin/sounds/rename  # Sound umbenennen
```

## 🔧 Discord bot commands

### **DM commands**
- `?help` – show help
- `?list` – list all sounds
- `?entrance <file.mp3|file.wav> | remove` – set or remove your entrance sound
- `?exit <file.mp3|file.wav> | remove` – set or remove your exit sound

### **Upload via DM**
- Send MP3/WAV files directly to the bot
- Files are stored under `/data/sounds`
- Immediately available in the frontend

## 🐳 Docker deployment

### **Docker Compose (Empfohlen)**
```yaml
# docker-compose.yml
services:
  app:
    build: .
    container_name: discord-soundboard
    ports:
      - "8199:8080"
    env_file:
      - .env
    volumes:
      - ./data/sounds:/data/sounds
    restart: unless-stopped
```

### **Docker Run**
```bash
docker run -d \
  --name jukebox-420 \
  -p 8199:8080 \
  --env-file .env \
  -v $(pwd)/data/sounds:/data/sounds \
  flex420/jukebox-vibe:latest
```

### **Docker Hub**
```bash
# Image pullen
docker pull flex420/jukebox-vibe:latest

# Container starten
docker run -d --name jukebox-420 -p 8199:8080 --env-file .env -v $(pwd)/data/sounds:/data/sounds flex420/jukebox-vibe:latest
```

## 🔒 SSL/HTTPS Hinweis (wichtig für Discord)

- Das Web-Frontend MUSS hinter HTTPS (SSL) ausgeliefert werden. Empfohlen ist ein Domain‑Mapping (Reverse Proxy) mit gültigem Zertifikat (z. B. Traefik, Nginx, Caddy, Cloudflare).
- Hintergrund: Ohne TLS kann es zu Verschlüsselungs-/Encrypt‑Fehlern kommen, und Audio wird in Discord nicht korrekt wiedergegeben.
- Praxis: Richte eine Domain wie `https://soundboard.deinedomain.tld` auf das Frontend ein und aktiviere SSL (Let’s Encrypt). Danach sollten Uploads/Playback stabil funktionieren.

## 📁 Project structure

```
jukebox-vibe/
├── server/                 # Backend (Node.js/Express)
│   ├── src/
│   │   ├── index.ts       # Main Server + Discord Bot
│   │   └── types/         # TypeScript Definitions
│   ├── package.json
│   └── tsconfig.json
├── web/                   # Frontend (React/Vite)
│   ├── src/
│   │   ├── App.tsx        # Main React Component
│   │   ├── api.ts         # API Client
│   │   ├── styles.css     # Theme Styles
│   │   └── types.ts       # TypeScript Types
│   ├── package.json
│   └── index.html
├── docker-compose.yml     # Docker Compose Config
├── Dockerfile            # Multi-Stage Build
├── .env.example          # Environment Template
└── README.md             # Diese Datei
```

## 🔧 Development

### **Lokale Entwicklung**
```bash
# Backend
cd server
npm install
npm run dev

# Frontend (neues Terminal)
cd web
npm install
npm run dev
```

### **Build**
```bash
# Production Build
docker build -t jukebox-vibe .

# Development Build
docker build --target development -t jukebox-vibe:dev .
```

## 📈 Stats

### **Persistent data**
- Sounds: `/data/sounds/` (volume mount)
- State: `/data/sounds/state.json` (volume, channel, plays)
- Favorites: browser cookies
- Theme: browser localStorage

### **Monitoring**
- Health check: `/api/health`
- Docker logs: `docker compose logs -f`
- Container status: `docker compose ps`

## 🛠️ Troubleshooting

### **Häufige Probleme**

**Bot does not join the voice channel:**
- Check bot permissions (Connect, Speak, Request to Speak for Stage)
- Verify gateway intents in the Discord Developer Portal (GuildVoiceStates, DirectMessages, MessageContent)
- Check network/firewall

**Sounds do not show up:**
- Verify volume mount `/data/sounds`
- Check file permissions
- Confirm uploads via DM

**Admin login fails:**
- Check browser cookies
- Confirm admin password
- Inspect server logs

### **Logs anzeigen**
```bash
# Docker Compose Logs
docker compose logs -f

# Container-spezifische Logs
docker compose logs -f app

# Letzte 100 Zeilen
docker compose logs --tail=100 app
```

## 🤝 Contributing

1. **Fork** das Repository
2. **Feature Branch** erstellen (`git checkout -b feature/AmazingFeature`)
3. **Commit** Änderungen (`git commit -m 'Add AmazingFeature'`)
4. **Push** zum Branch (`git push origin feature/AmazingFeature`)
5. **Pull Request** erstellen

## 📄 Lizenz

Dieses Projekt ist unter der MIT Lizenz lizenziert - siehe [LICENSE](LICENSE) Datei für Details.

## 🙏 Credits

- **Discord.js** für Bot-Funktionalität
- **React** für das Frontend
- **Vite** für Build-Tooling
- **Docker** für Containerisierung
- **Tailwind CSS** für Styling

---

**🎵 Jukebox 420** - Dein ultimatives Discord Soundboard! 🚀





