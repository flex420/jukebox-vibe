import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { Request, Response } from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
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
  StreamType,
  generateDependencyReport,
  entersState,
  VoiceConnectionStatus
} from '@discordjs/voice';
import sodium from 'libsodium-wrappers';
import nacl from 'tweetnacl';
import ytdl from 'ytdl-core';
import { createRequire } from 'node:module';
import child_process from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config ---
const PORT = Number(process.env.PORT ?? 8080);
const SOUNDS_DIR = process.env.SOUNDS_DIR ?? '/data/sounds';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? '';
const ADMIN_PWD = process.env.ADMIN_PWD ?? '';
const YTDLP_COOKIES_FILE = process.env.YTDLP_COOKIES_FILE ?? '';
const ALLOWED_GUILD_IDS = (process.env.ALLOWED_GUILD_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!DISCORD_TOKEN) {
  console.error('Fehlende Umgebungsvariable DISCORD_TOKEN');
  process.exit(1);
}

fs.mkdirSync(SOUNDS_DIR, { recursive: true });

function buildYtDlpArgs(url: string, mode: 'stream' | 'download', outPath?: string): string[] {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1';
  const base = [
    '--no-playlist',
    '--no-warnings',
    '--geo-bypass',
    '--user-agent', ua,
    '--referer', 'https://www.youtube.com/',
    '--extractor-args', 'youtube:player_client=android',
  ];
  if (YTDLP_COOKIES_FILE) {
    base.push('--cookies', YTDLP_COOKIES_FILE);
  }
  if (mode === 'stream') {
    return ['-f', 'bestaudio/best', ...base, '-o', '-', url];
  }
  // download
  const out = outPath ?? path.join(SOUNDS_DIR, `media-${Date.now()}.mp3`);
  return ['-x', '--audio-format', 'mp3', '--audio-quality', '0', ...base, '-o', out, url];
}

// Persistente Lautstärke pro Guild speichern
type PersistedState = { volumes: Record<string, number> };
const STATE_FILE = path.join(path.resolve(SOUNDS_DIR, '..'), 'state.json');

function readPersistedState(): PersistedState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return { volumes: parsed.volumes ?? {} } as PersistedState;
    }
  } catch {}
  return { volumes: {} };
}

function writePersistedState(state: PersistedState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn('Persisted state konnte nicht geschrieben werden:', e);
  }
}

const persistedState: PersistedState = readPersistedState();
const getPersistedVolume = (guildId: string): number => {
  const v = persistedState.volumes[guildId];
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
};

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

// --- Admin Auth ---
type AdminPayload = { iat: number; exp: number };
function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function signAdminToken(payload: AdminPayload): string {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', ADMIN_PWD || 'no-admin').update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyAdminToken(token: string | undefined): boolean {
  if (!token || !ADMIN_PWD) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  const expected = crypto.createHmac('sha256', ADMIN_PWD).update(body).digest('base64url');
  if (expected !== sig) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64').toString('utf8')) as AdminPayload;
    if (typeof payload.exp !== 'number') return false;
    return Date.now() < payload.exp;
  } catch {
    return false;
  }
}
function readCookie(req: Request, key: string): string | undefined {
  const c = req.headers.cookie;
  if (!c) return undefined;
  for (const part of c.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === key) return decodeURIComponent(v || '');
  }
  return undefined;
}
function requireAdmin(req: Request, res: Response, next: () => void) {
  if (!ADMIN_PWD) return res.status(503).json({ error: 'Admin nicht konfiguriert' });
  const token = readCookie(req, 'admin');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Nicht eingeloggt' });
  next();
}

app.post('/api/admin/login', (req: Request, res: Response) => {
  if (!ADMIN_PWD) return res.status(503).json({ error: 'Admin nicht konfiguriert' });
  const { password } = req.body as { password?: string };
  if (!password || password !== ADMIN_PWD) return res.status(401).json({ error: 'Falsches Passwort' });
  const token = signAdminToken({ iat: Date.now(), exp: Date.now() + 7 * 24 * 3600 * 1000 });
  res.setHeader('Set-Cookie', `admin=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=Lax`);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (_req: Request, res: Response) => {
  res.setHeader('Set-Cookie', 'admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

app.get('/api/admin/status', (req: Request, res: Response) => {
  res.json({ authenticated: verifyAdminToken(readCookie(req, 'admin')) });
});

app.get('/api/sounds', (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').toLowerCase();
  const folderFilter = typeof req.query.folder === 'string' ? (req.query.folder as string) : '__all__';

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

  // Zeitstempel für Neu-Logik
  type ItemWithTime = { fileName: string; name: string; folder: string; relativePath: string; mtimeMs: number };
  const allWithTime: ItemWithTime[] = [...allItems].map((it) => {
    const stat = fs.statSync(path.join(SOUNDS_DIR, it.relativePath));
    return { ...it, mtimeMs: stat.mtimeMs };
  });
  const sortedByNewest = [...allWithTime].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const recentTop10 = sortedByNewest.slice(0, 10);
  const recentTop5Set = new Set(recentTop10.slice(0, 5).map((x) => x.relativePath));
  let itemsByFolder = allItems;
  if (folderFilter !== '__all__') {
    if (folderFilter === '__recent__') {
      itemsByFolder = recentTop10.map(({ fileName, name, folder, relativePath }) => ({ fileName, name, folder, relativePath }));
    } else {
      itemsByFolder = allItems.filter((it) => (folderFilter === '' ? it.folder === '' : it.folder === folderFilter));
    }
  }
  const filteredItems = itemsByFolder.filter((s) => (q ? s.name.toLowerCase().includes(q) : true));

  const total = allItems.length;
  const recentCount = Math.min(10, total);
  const foldersOut = [
    { key: '__all__', name: 'Alle', count: total },
    { key: '__recent__', name: 'Neu', count: recentCount },
    ...folders
  ];
  // isRecent-Flag für UI (Top 5 der neuesten)
  const withRecentFlag = filteredItems.map((it) => ({
    ...it,
    isRecent: recentTop5Set.has(it.relativePath ?? it.fileName)
  }));

  res.json({ items: withRecentFlag, total, folders: foldersOut });
});

// --- Admin: Bulk-Delete ---
app.post('/api/admin/sounds/delete', requireAdmin, (req: Request, res: Response) => {
  const { paths } = req.body as { paths?: string[] };
  if (!Array.isArray(paths) || paths.length === 0) return res.status(400).json({ error: 'paths[] erforderlich' });
  const results: Array<{ path: string; ok: boolean; error?: string }> = [];
  for (const rel of paths) {
    const full = path.join(SOUNDS_DIR, rel);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        fs.unlinkSync(full);
        results.push({ path: rel, ok: true });
      } else {
        results.push({ path: rel, ok: false, error: 'nicht gefunden' });
      }
    } catch (e: any) {
      results.push({ path: rel, ok: false, error: e?.message ?? 'Fehler' });
    }
  }
  res.json({ ok: true, results });
});

// --- Admin: Umbenennen einer Datei ---
app.post('/api/admin/sounds/rename', requireAdmin, (req: Request, res: Response) => {
  const { from, to } = req.body as { from?: string; to?: string };
  if (!from || !to) return res.status(400).json({ error: 'from und to erforderlich' });
  const src = path.join(SOUNDS_DIR, from);
  // Ziel nur Name ändern, Endung mp3 sicherstellen
  const parsed = path.parse(from);
  const dstRel = path.join(parsed.dir || '', `${to.replace(/[^a-zA-Z0-9_.\-]/g, '_')}.mp3`);
  const dst = path.join(SOUNDS_DIR, dstRel);
  try {
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'Quelle nicht gefunden' });
    if (fs.existsSync(dst)) return res.status(409).json({ error: 'Ziel existiert bereits' });
    fs.renameSync(src, dst);
    res.json({ ok: true, from, to: dstRel });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Rename fehlgeschlagen' });
  }
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
      state = { connection, player, guildId, channelId, currentVolume: getPersistedVolume(guildId) };
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
        state = { connection, player, guildId, channelId, currentVolume: getPersistedVolume(guildId) };
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
    // Persistieren
    persistedState.volumes[guildId] = volumeToUse;
    writePersistedState(persistedState);
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
      // Kein aktiver Player: nur persistieren für nächste Wiedergabe
      persistedState.volumes[guildId] = safeVolume;
      writePersistedState(persistedState);
      return res.json({ ok: true, volume: safeVolume, persistedOnly: true });
    }
    state.currentVolume = safeVolume;
    if (state.currentResource?.volume) {
      state.currentResource.volume.setVolume(safeVolume);
      console.log(`${new Date().toISOString()} | live setVolume(${safeVolume}) guild=${guildId}`);
    }
    persistedState.volumes[guildId] = safeVolume;
    writePersistedState(persistedState);
    return res.json({ ok: true, volume: safeVolume });
  } catch (e: any) {
    console.error('Volume-Fehler:', e);
    return res.status(500).json({ error: e?.message ?? 'Unbekannter Fehler' });
  }
});

// Aktuelle/gespeicherte Lautstärke abrufen
app.get('/api/volume', (req: Request, res: Response) => {
  const guildId = String(req.query.guildId ?? '');
  if (!guildId) return res.status(400).json({ error: 'guildId erforderlich' });
  const state = guildAudioState.get(guildId);
  const v = state?.currentVolume ?? getPersistedVolume(guildId);
  return res.json({ volume: v });
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

// --- Medien-URL abspielen ---
// Unterstützt: YouTube (ytdl-core), generische URLs (yt-dlp), direkte mp3 (Download und Ablage)
app.post('/api/play-url', async (req: Request, res: Response) => {
  try {
    const { url, guildId, channelId, volume, download } = req.body as { url?: string; guildId?: string; channelId?: string; volume?: number; download?: boolean };
    if (!url || !guildId || !channelId) return res.status(400).json({ error: 'url, guildId, channelId erforderlich' });

    // MP3 direkt?
    const lower = url.toLowerCase();
    if (lower.endsWith('.mp3')) {
      const fileName = path.basename(new URL(url).pathname);
      const dest = path.join(SOUNDS_DIR, fileName);
      const r = await fetch(url);
      if (!r.ok) return res.status(400).json({ error: 'Download fehlgeschlagen' });
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(dest, buf);
      // sofort abspielen
      req.body = { soundName: path.parse(fileName).name, guildId, channelId, volume, relativePath: fileName } as any;
      return (app._router as any).handle({ ...req, method: 'POST', url: '/api/play' }, res, () => {});
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Guild nicht gefunden' });
    let state = guildAudioState.get(guildId);
    if (!state) {
      const channel = guild.channels.cache.get(channelId);
      if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) {
        return res.status(400).json({ error: 'Ungültiger Voice-Channel' });
      }
      const connection = joinVoiceChannel({ channelId, guildId, adapterCreator: guild.voiceAdapterCreator as any, selfDeaf: false, selfMute: false });
      const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
      connection.subscribe(player);
      state = { connection, player, guildId, channelId, currentVolume: getPersistedVolume(guildId) };
      guildAudioState.set(guildId, state);
      state.connection = await ensureConnectionReady(connection, channelId, guildId, guild);
      attachVoiceLifecycle(state, guild);
    }

    const useVolume = typeof volume === 'number' ? Math.max(0, Math.min(1, volume)) : state.currentVolume ?? 1;

    // Audio-Stream besorgen
    // Download in Datei (mp3) falls gewünscht
    if (download === true) {
      const safeBase = `media-${Date.now()}`;
      const outPath = path.join(SOUNDS_DIR, `${safeBase}.mp3`);
      const yt = child_process.spawn('yt-dlp', buildYtDlpArgs(url, 'download', outPath));
      yt.stderr.on('data', (d) => console.log(`[yt-dlp] ${String(d)}`));
      yt.on('error', (err) => console.error('yt-dlp spawn error:', err));
      yt.on('close', async (code) => {
        if (code !== 0) {
          console.error('yt-dlp exited with code', code);
          try { res.status(500).json({ error: 'Download fehlgeschlagen' }); } catch {}
          return;
        }
        // Datei abspielen
        try {
          const resource = createAudioResource(outPath, { inlineVolume: true });
          if (resource.volume) resource.volume.setVolume(useVolume);
          state!.player.stop();
          state!.player.play(resource);
          state!.currentResource = resource;
          state!.currentVolume = useVolume;
          try { res.json({ ok: true, saved: path.basename(outPath) }); } catch {}
        } catch (e) {
          console.error('play downloaded file error:', e);
          try { res.status(500).json({ error: 'Abspielen der Datei fehlgeschlagen' }); } catch {}
        }
      });
      return;
    }

    // Streaming: yt-dlp + ffmpeg Transcoding (stabiler als ytdl-core)
    const ytArgs = buildYtDlpArgs(url, 'stream');
    const yt = child_process.spawn('yt-dlp', ytArgs);
    yt.stderr.on('data', (d) => console.log(`[yt-dlp] ${String(d)}`));
    yt.on('error', (err) => console.error('yt-dlp spawn error:', err));
    const ffArgs = ['-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'];
    const ff = child_process.spawn('ffmpeg', ffArgs);
    ff.stderr.on('data', (d) => console.log(`[ffmpeg] ${String(d)}`));
    yt.stdout.pipe(ff.stdin);

    const resource = createAudioResource(ff.stdout as any, { inlineVolume: true, inputType: StreamType.Raw });
    if (resource.volume) resource.volume.setVolume(useVolume);
    state.player.stop();
    state.player.play(resource);
    state.currentResource = resource;
    state.currentVolume = useVolume;
    return res.json({ ok: true });
  } catch (e: any) {
    console.error('play-url error:', e);
    return res.status(500).json({ error: e?.message ?? 'Unbekannter Fehler' });
  }
});




