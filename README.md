# Discord Soundboard (Docker)

Eine Docker-fähige Web-App mit Discord-Bot. Nutzer wählen im Web-Frontend Sound-Dateien, wählen einen Discord-Sprachkanal per Dropdown und lassen den Bot dort den Sound abspielen. Neue Sounds können dem Bot per privater Discord-Nachricht als MP3 gesendet werden; der Bot speichert sie automatisch und sie erscheinen im Frontend.

Inspiration/Referenz: `davefurrer/discordsoundboard` auf Docker Hub ([Link](https://hub.docker.com/r/davefurrer/discordsoundboard)).

## Features
- Schönes Web-Frontend mit Suchfeld und Buttons für Sounds
- Dropdown-Auswahl der verfügbaren Discord-Sprachkanäle (guild-übergreifend)
- Discord-Bot joint den gewählten Voice-Channel und spielt MP3-Sounds
- MP3-Uploads via DM an den Bot; automatische Ablage im Backend und sofort im Frontend sichtbar
- Einfache Installation via Docker Compose

## Architektur
- Ein Container (Node.js):
  - Express REST-API und statische Auslieferung des Frontends
  - Discord-Bot (discord.js, @discordjs/voice, ffmpeg)
  - Gemeinsames Datenverzeichnis `/data/sounds` für MP3s

## Anforderungen
- Docker und Docker Compose
- Discord Bot Token mit Intents: Guilds, GuildVoiceStates, DirectMessages, MessageContent

## Schnellstart

1) `.env` anlegen (siehe `.env.example`).

2) Docker bauen und starten:

```bash
docker compose up --build -d
```

3) Öffne `http://localhost:8080` im Browser.

4) Lade dem Bot per privater Nachricht eine `.mp3` hoch. Der Sound erscheint automatisch im Frontend.

## Umgebungsvariablen (`.env`)

```
DISCORD_TOKEN=dein_discord_bot_token
PORT=8080
SOUNDS_DIR=/data/sounds
```

Optional: Du kannst die Liste der Kanäle auf bestimmte Guilds beschränken:

```
ALLOWED_GUILD_IDS=GUILD_ID_1,GUILD_ID_2
```

## Endpunkte (API)
- `GET /api/health` – Healthcheck
- `GET /api/sounds` – Liste der Sounds
- `GET /api/channels` – Liste der Voice-Channels (mit Guild-Infos)
- `POST /api/play` – Body: `{ soundName, guildId, channelId }`

## Entwicklung lokal (ohne Docker)

1) Server:
```bash
cd server
npm install
npm run dev
```

2) Web:
```bash
cd web
npm install
npm run dev
```

Das Web-Frontend erwartet die API standardmäßig unter `http://localhost:8080/api`. Passe sonst `VITE_API_BASE_URL` an.

## Veröffentlichung auf Docker Hub

1) Image bauen:
```bash
docker build -t <dein-dockerhub-user>/discord-soundboard:latest .
```

2) Einloggen und pushen:
```bash
docker login
docker push <dein-dockerhub-user>/discord-soundboard:latest
```

3) Installation irgendwo:
```bash
docker pull <dein-dockerhub-user>/discord-soundboard:latest
docker run --name discord-soundboard -p 8080:8080 --env-file .env -v $(pwd)/data/sounds:/data/sounds -d <dein-dockerhub-user>/discord-soundboard:latest
```

Hinweis: Dieses Projekt ist eigenständig implementiert, angelehnt an die Funktionsbeschreibung von `davefurrer/discordsoundboard` ([Link](https://hub.docker.com/r/davefurrer/discordsoundboard)).





