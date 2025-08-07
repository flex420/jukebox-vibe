import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { Client, GatewayIntentBits, Partials, ChannelType, Events, type Message } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  getVoiceConnection,
  type VoiceConnection,
  type AudioResource,
  generateDependencyReport,
  entersState,
  VoiceConnectionStatus
} from '@discordjs/voice';
import sodium from 'libsodium-wrappers';
import nacl from 'tweetnacl';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config ---
const PORT = Number(process.env.PORT ?? 8080);
const SOUNDS_DIR = process.env.SOUNDS_DIR ?? '/data/sounds';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? '';
const ALLOWED_GUILD_IDS = (process.env.ALLOWED_GUILD_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!DISCORD_TOKEN) {
  console.error('Fehlende Umgebungsvariable DISCORD_TOKEN');
  process.exit(1);
}

fs.mkdirSync(SOUNDS_DIR, { recursive: true });

// --- Voice Abhängigkeiten prüfen ---
await sodium.ready;
// init nacl to ensure it loads
void nacl.randomBytes(1);
console.log(generateDependencyReport());

// --- Discord Client ---
const client = new Client({
  // 32385 = Guilds + GuildVoiceStates + GuildMessages + GuildMessageReactions + GuildMessageTyping
  //        + DirectMessages + DirectMessageReactions + DirectMessageTyping
  // (ohne privilegierte Intents wie MessageContent/GuildMembers/Presences)
  intents: 32385,
  partials: [Partials.Channel]
});

type GuildAudioState = {
  connection: VoiceConnection;
  player: ReturnType<typeof createAudioPlayer>;
  guildId: string;
  channelId: string;
  currentResource?: AudioResource;
  currentVolume: number; // 0..1
};
const guildAudioState = new Map<string, GuildAudioState>();

async function ensureConnectionReady(connection: VoiceConnection, channelId: string, guildId: string, guild: any): Promise<VoiceConnection> {
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    console.log(`${new Date().toISOString()} | VoiceConnection ready`);
    return connection;
  } catch (e) {
    console.warn(`${new Date().toISOString()} | VoiceConnection not ready, trying rejoin...`, e);
  }

  try {
    connection.rejoin({ channelId, selfDeaf: false, selfMute: false });
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    console.log(`${new Date().toISOString()} | VoiceConnection ready after rejoin`);
    return connection;
  } catch (e2) {
    console.error(`${new Date().toISOString()} | VoiceConnection still not ready after rejoin`, e2);
  }

  try {
    connection.destroy();
  } catch {}
  const newConn = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator as any,
    selfMute: false,
    selfDeaf: false
  });
  await entersState(newConn, VoiceConnectionStatus.Ready, 15_000).catch((e3) => {
    console.error(`${new Date().toISOString()} | VoiceConnection not ready after fresh join`, e3);
  });
  return newConn;
}

function attachVoiceLifecycle(state: GuildAudioState, guild: any) {
  const { connection } = state;
  connection.on('stateChange', async (oldS: any, newS: any) => {
    console.log(`${new Date().toISOString()} | VoiceConnection: ${oldS.status} -> ${newS.status}`);
    try {
      if (newS.status === VoiceConnectionStatus.Disconnected) {
        // Versuche, die Verbindung kurzfristig neu auszuhandeln, sonst rejoin
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
          ]);
        } catch {
          connection.rejoin({ channelId: state.channelId, selfDeaf: false, selfMute: false });
        }
      } else if (newS.status === VoiceConnectionStatus.Destroyed) {
        // Komplett neu beitreten
        const newConn = joinVoiceChannel({
          channelId: state.channelId,
          guildId: state.guildId,
          adapterCreator: guild.voiceAdapterCreator as any,
          selfMute: false,
          selfDeaf: false
        });
        state.connection = newConn;
        newConn.subscribe(state.player);
        attachVoiceLifecycle(state, guild);
      } else if (newS.status === VoiceConnectionStatus.Connecting || newS.status === VoiceConnectionStatus.Signalling) {
        try {
          await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
        } catch (e) {
          console.warn(`${new Date().toISOString()} | Voice not ready from ${newS.status}, rejoin`, e);
          connection.rejoin({ channelId: state.channelId, selfDeaf: false, selfMute: false });
        }
      }
    } catch (e) {
      console.error(`${new Date().toISOString()} | Voice lifecycle handler error`, e);
    }
  });
}

client.once(Events.ClientReady, () => {
  console.log(`Bot eingeloggt als ${client.user?.tag}`);
});

client.on(Events.MessageCreate, async (message: Message) => {
  try {
    if (message.author?.bot) return;
    if (!message.channel?.isDMBased?.()) return;
    if (message.attachments.size === 0) return;

    for (const [, attachment] of message.attachments) {
      const name = attachment.name ?? 'upload.mp3';
      const lower = name.toLowerCase();
      if (!lower.endsWith('.mp3')) continue;

      const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
      let targetPath = path.join(SOUNDS_DIR, safeName);
      if (fs.existsSync(targetPath)) {
        const base = path.parse(safeName).name;
        const ext = path.parse(safeName).ext || '.mp3';
        let i = 2;
        while (fs.existsSync(targetPath)) {
          targetPath = path.join(SOUNDS_DIR, `${base}-${i}${ext}`);
          i += 1;
        }
      }

      const res = await fetch(attachment.url);
      if (!res.ok) throw new Error(`Download fehlgeschlagen: ${attachment.url}`);
      const arrayBuffer = await res.arrayBuffer();
      fs.writeFileSync(targetPath, Buffer.from(arrayBuffer));
      await message.reply(`Sound gespeichert: ${path.basename(targetPath)}`);
    }
  } catch (err) {
    console.error('Fehler bei DM-Upload:', err);
  }
});

await client.login(DISCORD_TOKEN);

// --- Express App ---
const app = express();
app.use(express.json());
app.use(cors());

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get('/api/sounds', (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').toLowerCase();

  const rootEntries = fs.readdirSync(SOUNDS_DIR, { withFileTypes: true });
  const rootFiles = rootEntries
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.mp3'))
    .map((d) => ({ fileName: d.name, name: path.parse(d.name).name, folder: '', relativePath: d.name }));

  const folders: Array<{ key: string; name: string; count: number }> = [];

  const subFolders = rootEntries.filter((d) => d.isDirectory());
  const folderItems: Array<{ fileName: string; name: string; folder: string; relativePath: string }> = [];
  for (const dirent of subFolders) {
    const folderName = dirent.name;
    const folderPath = path.join(SOUNDS_DIR, folderName);
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    const mp3s = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.mp3'));
    for (const f of mp3s) {
      folderItems.push({
        fileName: f.name,
        name: path.parse(f.name).name,
        folder: folderName,
        relativePath: path.join(folderName, f.name)
      });
    }
    folders.push({ key: folderName, name: folderName, count: mp3s.length });
  }

  const allItems = [...rootFiles, ...folderItems].sort((a, b) => a.name.localeCompare(b.name));
  const filteredItems = allItems.filter((s) => (q ? s.name.toLowerCase().includes(q) : true));

  const total = allItems.length;
  const rootCount = rootFiles.length;
  const foldersOut = [{ key: '__all__', name: 'Alle', count: total }, { key: '', name: 'Root', count: rootCount }, ...folders];

  res.json({ items: filteredItems, total, folders: foldersOut });
});

app.get('/api/channels', (_req: Request, res: Response) => {
  if (!client.isReady()) return res.status(503).json({ error: 'Bot noch nicht bereit' });

  const allowed = new Set(ALLOWED_GUILD_IDS);
  const result: Array<{ guildId: string; guildName: string; channelId: string; channelName: string }> = [];
  for (const [, guild] of client.guilds.cache) {
    if (allowed.size > 0 && !allowed.has(guild.id)) continue;
    const channels = guild.channels.cache;
    for (const [, ch] of channels) {
      if (ch?.type === ChannelType.GuildVoice || ch?.type === ChannelType.GuildStageVoice) {
        result.push({ guildId: guild.id, guildName: guild.name, channelId: ch.id, channelName: ch.name });
      }
    }
  }
  result.sort((a, b) => a.guildName.localeCompare(b.guildName) || a.channelName.localeCompare(b.channelName));
  res.json(result);
});

app.post('/api/play', async (req: Request, res: Response) => {
  try {
    const { soundName, guildId, channelId, volume, folder, relativePath } = req.body as {
      soundName?: string;
      guildId?: string;
      channelId?: string;
      volume?: number; // 0..1
      folder?: string; // optional subfolder key
      relativePath?: string; // optional direct relative path
    };
    if (!soundName || !guildId || !channelId) return res.status(400).json({ error: 'soundName, guildId, channelId erforderlich' });

    let filePath: string;
    if (relativePath) filePath = path.join(SOUNDS_DIR, relativePath);
    else if (folder) filePath = path.join(SOUNDS_DIR, folder, `${soundName}.mp3`);
    else filePath = path.join(SOUNDS_DIR, `${soundName}.mp3`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Sound nicht gefunden' });

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Guild nicht gefunden' });
    const channel = guild.channels.cache.get(channelId);
    if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) {
      return res.status(400).json({ error: 'Ungültiger Voice-Channel' });
    }

    let state = guildAudioState.get(guildId);
    if (!state) {
      const connection = joinVoiceChannel({
        channelId,
        guildId,
        adapterCreator: guild.voiceAdapterCreator as any,
        selfMute: false,
        selfDeaf: false
      });
      const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
      connection.subscribe(player);
      state = { connection, player, guildId, channelId, currentVolume: 1 };
      guildAudioState.set(guildId, state);

      // Connection State Logs
      connection.on('stateChange', (oldState, newState) => {
        console.log(`${new Date().toISOString()} | VoiceConnection: ${oldState.status} -> ${newState.status}`);
      });
      player.on('stateChange', (oldState, newState) => {
        console.log(`${new Date().toISOString()} | AudioPlayer: ${oldState.status} -> ${newState.status}`);
      });
      player.on('error', (err) => {
        console.error(`${new Date().toISOString()} | AudioPlayer error:`, err);
      });

      state.connection = await ensureConnectionReady(connection, channelId, guildId, guild);
      attachVoiceLifecycle(state, guild);

      // Stage-Channel Entstummung anfordern/setzen
      try {
        const me = guild.members.me;
        if (me && (channel.type === ChannelType.GuildStageVoice)) {
          if ((me.voice as any)?.suppress) {
            await me.voice.setSuppressed(false).catch(() => me.voice.setRequestToSpeak(true));
            console.log(`${new Date().toISOString()} | StageVoice: suppression versucht zu deaktivieren`);
          }
        }
      } catch (e) {
        console.warn(`${new Date().toISOString()} | StageVoice unsuppress/requestToSpeak fehlgeschlagen`, e);
      }

      state.player.on(AudioPlayerStatus.Idle, () => {
        // optional: Verbindung bestehen lassen oder nach Timeout trennen
      });
    } else {
      // Wechsel in anderen Channel, wenn nötig
      const current = getVoiceConnection(guildId);
      if (current && (current.joinConfig.channelId !== channelId)) {
        current.destroy();
        const connection = joinVoiceChannel({
          channelId,
          guildId,
          adapterCreator: guild.voiceAdapterCreator as any,
          selfMute: false,
          selfDeaf: false
        });
        const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
        connection.subscribe(player);
        state = { connection, player, guildId, channelId, currentVolume: 1 };
        guildAudioState.set(guildId, state);

        state.connection = await ensureConnectionReady(connection, channelId, guildId, guild);
        attachVoiceLifecycle(state, guild);

        connection.on('stateChange', (o, n) => {
          console.log(`${new Date().toISOString()} | VoiceConnection: ${o.status} -> ${n.status}`);
        });
        player.on('stateChange', (o, n) => {
          console.log(`${new Date().toISOString()} | AudioPlayer: ${o.status} -> ${n.status}`);
        });
        player.on('error', (err) => {
          console.error(`${new Date().toISOString()} | AudioPlayer error:`, err);
        });
      }
    }

    console.log(`${new Date().toISOString()} | createAudioResource: ${filePath}`);
    // Volume bestimmen: bevorzugt Request-Volume, sonst bisheriger State-Wert, sonst 1
    const volumeToUse = typeof volume === 'number' && Number.isFinite(volume)
      ? Math.max(0, Math.min(1, volume))
      : (state.currentVolume ?? 1);
    const resource = createAudioResource(filePath, { inlineVolume: true });
    if (resource.volume) {
      resource.volume.setVolume(volumeToUse);
      console.log(`${new Date().toISOString()} | setVolume(${volumeToUse}) for ${soundName}`);
    }
    state.player.stop();
    state.player.play(resource);
    state.currentResource = resource;
    state.currentVolume = volumeToUse;
    console.log(`${new Date().toISOString()} | player.play() called for ${soundName}`);
    return res.json({ ok: true });
  } catch (err: any) {
    console.error('Play-Fehler:', err);
    return res.status(500).json({ error: err?.message ?? 'Unbekannter Fehler' });
  }
});

// Lautstärke zur Laufzeit ändern (0..1). Wirken sofort auf aktuelle Resource, sonst als Default für nächste Wiedergabe.
app.post('/api/volume', (req: Request, res: Response) => {
  try {
    const { guildId, volume } = req.body as { guildId?: string; volume?: number };
    if (!guildId || typeof volume !== 'number' || !Number.isFinite(volume)) {
      return res.status(400).json({ error: 'guildId und volume (0..1) erforderlich' });
    }
    const safeVolume = Math.max(0, Math.min(1, volume));
    const state = guildAudioState.get(guildId);
    if (!state) {
      return res.status(404).json({ error: 'Kein Voice-State für diese Guild' });
    }
    state.currentVolume = safeVolume;
    if (state.currentResource?.volume) {
      state.currentResource.volume.setVolume(safeVolume);
      console.log(`${new Date().toISOString()} | live setVolume(${safeVolume}) guild=${guildId}`);
    }
    return res.json({ ok: true, volume: safeVolume });
  } catch (e: any) {
    console.error('Volume-Fehler:', e);
    return res.status(500).json({ error: e?.message ?? 'Unbekannter Fehler' });
  }
});

// Static Frontend ausliefern (Vite build)
const webDistPath = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDistPath)) {
  app.use(express.static(webDistPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(webDistPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Server läuft auf http://0.0.0.0:${PORT}`);
});




