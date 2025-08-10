import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { Request, Response } from 'express';
// import multer from 'multer';
import cors from 'cors';
import crypto from 'node:crypto';
import { Client, GatewayIntentBits, Partials, ChannelType, Events, type Message, VoiceState } from 'discord.js';
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
// Streaming externer Plattformen entfernt – nur MP3-URLs werden noch unterstützt
import child_process from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config ---
const PORT = Number(process.env.PORT ?? 8080);
const SOUNDS_DIR = process.env.SOUNDS_DIR ?? '/data/sounds';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? '';
const ADMIN_PWD = process.env.ADMIN_PWD ?? '';
const ALLOWED_GUILD_IDS = (process.env.ALLOWED_GUILD_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!DISCORD_TOKEN) {
  console.error('Fehlende Umgebungsvariable DISCORD_TOKEN');
  process.exit(1);
}

fs.mkdirSync(SOUNDS_DIR, { recursive: true });

// Persistenter Zustand: Lautstärke/Plays + Kategorien
type Category = { id: string; name: string; color?: string; sort?: number };
 type PersistedState = {
  volumes: Record<string, number>;
  plays: Record<string, number>;
  totalPlays: number;
  categories?: Category[];
  fileCategories?: Record<string, string[]>; // relPath or fileName -> categoryIds[]
  fileBadges?: Record<string, string[]>; // relPath or fileName -> custom badges (emoji/text)
    selectedChannels?: Record<string, string>; // guildId -> channelId (serverweite Auswahl)
  entranceSounds?: Record<string, string>; // userId -> relativePath or fileName
  exitSounds?: Record<string, string>; // userId -> relativePath or fileName
};
// Neuer, persistenter Speicherort direkt im Sounds-Volume
const STATE_FILE_NEW = path.join(SOUNDS_DIR, 'state.json');
// Alter Speicherort (eine Ebene über SOUNDS_DIR). Wird für Migration gelesen, falls vorhanden.
const STATE_FILE_OLD = path.join(path.resolve(SOUNDS_DIR, '..'), 'state.json');

function readPersistedState(): PersistedState {
  try {
    // 1) Bevorzugt neuen Speicherort lesen
    if (fs.existsSync(STATE_FILE_NEW)) {
      const raw = fs.readFileSync(STATE_FILE_NEW, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        volumes: parsed.volumes ?? {},
        plays: parsed.plays ?? {},
        totalPlays: parsed.totalPlays ?? 0,
        categories: Array.isArray(parsed.categories) ? parsed.categories : [],
        fileCategories: parsed.fileCategories ?? {},
        fileBadges: parsed.fileBadges ?? {},
        selectedChannels: parsed.selectedChannels ?? {},
        entranceSounds: parsed.entranceSounds ?? {},
        exitSounds: parsed.exitSounds ?? {}
      } as PersistedState;
    }
    // 2) Fallback: alten Speicherort lesen und sofort nach NEW migrieren
    if (fs.existsSync(STATE_FILE_OLD)) {
      const raw = fs.readFileSync(STATE_FILE_OLD, 'utf8');
      const parsed = JSON.parse(raw);
      const migrated: PersistedState = {
        volumes: parsed.volumes ?? {},
        plays: parsed.plays ?? {},
        totalPlays: parsed.totalPlays ?? 0,
        categories: Array.isArray(parsed.categories) ? parsed.categories : [],
        fileCategories: parsed.fileCategories ?? {},
        fileBadges: parsed.fileBadges ?? {},
        selectedChannels: parsed.selectedChannels ?? {},
        entranceSounds: parsed.entranceSounds ?? {},
        exitSounds: parsed.exitSounds ?? {}
      };
      try {
        fs.mkdirSync(path.dirname(STATE_FILE_NEW), { recursive: true });
        fs.writeFileSync(STATE_FILE_NEW, JSON.stringify(migrated, null, 2), 'utf8');
      } catch {}
      return migrated;
    }
  } catch {}
  return { volumes: {}, plays: {}, totalPlays: 0 };
}

function writePersistedState(state: PersistedState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE_NEW), { recursive: true });
    fs.writeFileSync(STATE_FILE_NEW, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn('Persisted state konnte nicht geschrieben werden:', e);
  }
}

const persistedState: PersistedState = readPersistedState();
const getPersistedVolume = (guildId: string): number => {
  const v = persistedState.volumes[guildId];
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
};
function incrementPlaysFor(relativePath: string) {
  try {
    const key = relativePath.replace(/\\/g, '/');
    persistedState.plays[key] = (persistedState.plays[key] ?? 0) + 1;
    persistedState.totalPlays = (persistedState.totalPlays ?? 0) + 1;
    writePersistedState(persistedState);
  } catch {}
}

// Normalisierung (ffmpeg loudnorm) Konfiguration
const NORMALIZE_ENABLE = String(process.env.NORMALIZE_ENABLE ?? 'true').toLowerCase() !== 'false';
const NORMALIZE_I = String(process.env.NORMALIZE_I ?? '-16');
const NORMALIZE_LRA = String(process.env.NORMALIZE_LRA ?? '11');
const NORMALIZE_TP = String(process.env.NORMALIZE_TP ?? '-1.5');

// --- Voice Abhängigkeiten prüfen ---
await sodium.ready;
// init nacl to ensure it loads
void nacl.randomBytes(1);
console.log(generateDependencyReport());

// --- Discord Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
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
// Partymode: serverseitige Steuerung (global pro Guild)
const partyTimers = new Map<string, NodeJS.Timeout>();
const partyActive = new Set<string>();
// SSE-Klienten für Broadcasts (z.B. Partymode Status)
const sseClients = new Set<Response>();
function sseBroadcast(payload: any) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch {}
  }
}

// Hilfsfunktionen für serverweit ausgewählten Channel pro Guild
function getSelectedChannelForGuild(guildId: string): string | undefined {
  const id = String(guildId || '');
  if (!id) return undefined;
  const sc = persistedState.selectedChannels ?? {};
  return sc[id];
}
function setSelectedChannelForGuild(guildId: string, channelId: string): void {
  const g = String(guildId || '');
  const c = String(channelId || '');
  if (!g || !c) return;
  if (!persistedState.selectedChannels) persistedState.selectedChannels = {};
  persistedState.selectedChannels[g] = c;
  writePersistedState(persistedState);
  sseBroadcast({ type: 'channel', guildId: g, channelId: c });
}

async function playFilePath(guildId: string, channelId: string, filePath: string, volume?: number, relativeKey?: string): Promise<void> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error('Guild nicht gefunden');
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
    state.connection = await ensureConnectionReady(connection, channelId, guildId, guild);
    attachVoiceLifecycle(state, guild);
  }
  // Wenn der Bot in einer anderen ChannelId ist, sauber rüberwechseln
  try {
    const current = getVoiceConnection(guildId);
    if (current && current.joinConfig?.channelId !== channelId) {
      current.destroy();
      const connection = joinVoiceChannel({
        channelId,
        guildId,
        adapterCreator: guild.voiceAdapterCreator as any,
        selfMute: false,
        selfDeaf: false
      });
      const player = state.player ?? createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
      connection.subscribe(player);
      state = { connection, player, guildId, channelId, currentVolume: state.currentVolume ?? getPersistedVolume(guildId) };
      guildAudioState.set(guildId, state);
      state.connection = await ensureConnectionReady(connection, channelId, guildId, guild);
      attachVoiceLifecycle(state, guild);
    }
  } catch {}
  const useVolume = typeof volume === 'number' && Number.isFinite(volume)
    ? Math.max(0, Math.min(1, volume))
    : (state.currentVolume ?? 1);
  let resource: AudioResource;
  if (NORMALIZE_ENABLE) {
    const ffArgs = ['-hide_banner', '-loglevel', 'error', '-i', filePath,
      '-af', `loudnorm=I=${NORMALIZE_I}:LRA=${NORMALIZE_LRA}:TP=${NORMALIZE_TP}`,
      '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'];
    const ff = child_process.spawn('ffmpeg', ffArgs);
    resource = createAudioResource(ff.stdout as any, { inlineVolume: true, inputType: StreamType.Raw });
  } else {
    resource = createAudioResource(filePath, { inlineVolume: true });
  }
  if (resource.volume) resource.volume.setVolume(useVolume);
  state.player.stop();
  state.player.play(resource);
  state.currentResource = resource;
  state.currentVolume = useVolume;
  if (relativeKey) incrementPlaysFor(relativeKey);
}

async function handleCommand(message: Message, content: string) {
  const reply = async (txt: string) => {
    try { await message.author.send?.(txt); } catch { await message.reply(txt); }
  };
  const parts = content.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === '?help') {
    await reply(
      'Available commands\n' +
      '?help - zeigt diese Hilfe\n' +
      '?list - listet alle Audio-Dateien (mp3/wav)\n' +
      '?entrance <datei.mp3|datei.wav> - setze deinen Entrance-Sound\n' +
      '?exit <datei.mp3|datei.wav> - setze deinen Exit-Sound (optional)\n'
    );
    return;
  }
  if (cmd === '?list') {
    const files = fs
      .readdirSync(SOUNDS_DIR)
      .filter(f => { const l = f.toLowerCase(); return l.endsWith('.mp3') || l.endsWith('.wav'); });
    await reply(files.length ? files.join('\n') : 'Keine Dateien gefunden.');
    return;
  }
  if (cmd === '?entrance') {
    const [, fileName] = parts;
    if (!fileName) { await reply('Verwendung: ?entrance <datei.mp3|datei.wav>'); return; }
    const lower = fileName.toLowerCase();
    if (!(lower.endsWith('.mp3') || lower.endsWith('.wav'))) { await reply('Nur .mp3 oder .wav Dateien sind erlaubt'); return; }
    const resolve = (() => {
      try {
        const direct = path.join(SOUNDS_DIR, fileName); if (fs.existsSync(direct)) return fileName;
        const dirs = fs.readdirSync(SOUNDS_DIR, { withFileTypes: true });
        for (const d of dirs) { if (!d.isDirectory()) continue; const cand = path.join(SOUNDS_DIR, d.name, fileName); if (fs.existsSync(cand)) return path.join(d.name, fileName).replace(/\\/g, '/'); }
        return '';
      } catch { return ''; }
    })();
    if (!resolve) { await reply('Datei nicht gefunden. Nutze ?list.'); return; }
    const userId = message.author?.id ?? ''; if (!userId) { await reply('Kein Benutzer erkannt.'); return; }
    persistedState.entranceSounds = persistedState.entranceSounds ?? {};
    persistedState.entranceSounds[userId] = resolve;
    writePersistedState(persistedState);
    try {
      console.log(`${new Date().toISOString()} | Entrance set: user=${userId} (${message.author?.tag || 'unknown'}) file=${resolve}`);
    } catch {}
    await reply(`Entrance-Sound gesetzt: ${resolve}`); return;
  }
  if (cmd === '?exit') {
    const [, fileName] = parts;
    if (!fileName) { await reply('Verwendung: ?exit <datei.mp3|datei.wav>'); return; }
    const lower = fileName.toLowerCase();
    if (!(lower.endsWith('.mp3') || lower.endsWith('.wav'))) { await reply('Nur .mp3 oder .wav Dateien sind erlaubt'); return; }
    const resolve = (() => {
      try {
        const direct = path.join(SOUNDS_DIR, fileName); if (fs.existsSync(direct)) return fileName;
        const dirs = fs.readdirSync(SOUNDS_DIR, { withFileTypes: true });
        for (const d of dirs) { if (!d.isDirectory()) continue; const cand = path.join(SOUNDS_DIR, d.name, fileName); if (fs.existsSync(cand)) return path.join(d.name, fileName).replace(/\\/g, '/'); }
        return '';
      } catch { return ''; }
    })();
    if (!resolve) { await reply('Datei nicht gefunden. Nutze ?list.'); return; }
    const userId = message.author?.id ?? ''; if (!userId) { await reply('Kein Benutzer erkannt.'); return; }
    persistedState.exitSounds = persistedState.exitSounds ?? {};
    persistedState.exitSounds[userId] = resolve;
    writePersistedState(persistedState);
    try {
      console.log(`${new Date().toISOString()} | Exit set: user=${userId} (${message.author?.tag || 'unknown'}) file=${resolve}`);
    } catch {}
    await reply(`Exit-Sound gesetzt: ${resolve}`); return;
  }
  await reply('Unbekannter Command. Nutze ?help.');
}

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

// Voice State Updates: Entrance/Exit
client.on(Events.VoiceStateUpdate, async (oldState: VoiceState, newState: VoiceState) => {
  try {
    const userId = (newState.id || oldState.id) as string;
    if (!userId) return;
    // Eigene Events ignorieren
    if (userId === client.user?.id) return;
    const guildId = (newState.guild?.id || oldState.guild?.id) as string;
    if (!guildId) return;

    const before = oldState.channelId;
    const after = newState.channelId;
    console.log(`${new Date().toISOString()} | VoiceStateUpdate user=${userId} before=${before ?? '-'} after=${after ?? '-'}`);

    // Entrance: Nutzer joint einem Channel
    if (!before && after) {
      const mapping = persistedState.entranceSounds ?? {};
      const file = mapping[userId];
      if (file) {
        const rel = file.replace(/\\/g, '/');
        const abs = path.join(SOUNDS_DIR, rel);
        if (fs.existsSync(abs)) {
          try {
            // Dem Channel beitreten und Sound spielen
            await playFilePath(guildId, after, abs, undefined, rel);
            console.log(`${new Date().toISOString()} | Entrance played for ${userId}: ${rel}`);
          } catch (e) { console.warn('Entrance play error', e); }
        }
      }
    }
    // Exit: Nutzer verlässt einen Channel – spiele im vorherigen Channel
    if (before && !after) {
      const mapping = persistedState.exitSounds ?? {};
      const file = mapping[userId];
      if (file) {
        const rel = file.replace(/\\/g, '/');
        const abs = path.join(SOUNDS_DIR, rel);
        if (fs.existsSync(abs)) {
          try {
            await playFilePath(guildId, before, abs, undefined, rel);
            console.log(`${new Date().toISOString()} | Exit played for ${userId}: ${rel}`);
          } catch (e) { console.warn('Exit play error', e); }
        }
      }
    }
  } catch (e) {
    console.warn('VoiceStateUpdate entrance/exit handling error', e);
  }
});

client.on(Events.MessageCreate, async (message: Message) => {
  try {
    if (message.author?.bot) return;
    // Commands überall annehmen (inkl. DMs)
    const content = (message.content || '').trim();
    if (content.startsWith('?')) {
      await handleCommand(message, content);
      return;
    }
    // Dateiuploads nur per DM
    if (!message.channel?.isDMBased?.()) return;
    if (message.attachments.size === 0) return;

    for (const [, attachment] of message.attachments) {
      const name = attachment.name ?? 'upload';
      const lower = name.toLowerCase();
      if (!(lower.endsWith('.mp3') || lower.endsWith('.wav'))) continue;

      const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
      let targetPath = path.join(SOUNDS_DIR, safeName);
      if (fs.existsSync(targetPath)) {
        const base = path.parse(safeName).name;
        const ext = path.parse(safeName).ext || (lower.endsWith('.wav') ? '.wav' : '.mp3');
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
      await message.author.send?.(`Sound gespeichert: ${path.basename(targetPath)}`);
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
  res.json({ ok: true, totalPlays: persistedState.totalPlays ?? 0, categories: (persistedState.categories ?? []).length });
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
  const categoryFilter = typeof (req.query as any).categoryId === 'string' ? String((req.query as any).categoryId) : undefined;
  const fuzzyParam = String((req.query as any).fuzzy ?? '0');
  const useFuzzy = fuzzyParam === '1' || fuzzyParam === 'true';

  const rootEntries = fs.readdirSync(SOUNDS_DIR, { withFileTypes: true });
  const rootFiles = rootEntries
    .filter((d) => {
      if (!d.isFile()) return false;
      const n = d.name.toLowerCase();
      return n.endsWith('.mp3') || n.endsWith('.wav');
    })
    .map((d) => ({ fileName: d.name, name: path.parse(d.name).name, folder: '', relativePath: d.name }));

  const folders: Array<{ key: string; name: string; count: number }> = [];

  const subFolders = rootEntries.filter((d) => d.isDirectory());
  const folderItems: Array<{ fileName: string; name: string; folder: string; relativePath: string }> = [];
  for (const dirent of subFolders) {
    const folderName = dirent.name;
    const folderPath = path.join(SOUNDS_DIR, folderName);
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    const audios = entries.filter((e) => {
      if (!e.isFile()) return false;
      const n = e.name.toLowerCase();
      return n.endsWith('.mp3') || n.endsWith('.wav');
    });
    for (const f of audios) {
      folderItems.push({
        fileName: f.name,
        name: path.parse(f.name).name,
        folder: folderName,
        relativePath: path.join(folderName, f.name)
      });
    }
    folders.push({ key: folderName, name: folderName, count: audios.length });
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
  // Fuzzy-Score: bevorzugt Präfixe, zusammenhängende Treffer und frühe Positionen
  function fuzzyScore(text: string, pattern: string): number {
    if (!pattern) return 1;
    if (text === pattern) return 2000;
    const idx = text.indexOf(pattern);
    if (idx !== -1) {
      let base = 1000;
      if (idx === 0) base += 200; // Präfix-Bonus
      return base - idx * 2; // leichte Positionsstrafe
    }
    // subsequence Matching
    let textIndex = 0;
    let patIndex = 0;
    let score = 0;
    let lastMatch = -1;
    let gaps = 0;
    let firstMatchPos = -1;
    while (textIndex < text.length && patIndex < pattern.length) {
      if (text[textIndex] === pattern[patIndex]) {
        if (firstMatchPos === -1) firstMatchPos = textIndex;
        if (lastMatch === textIndex - 1) {
          score += 5; // zusammenhängende Treffer belohnen
        }
        lastMatch = textIndex;
        patIndex++;
      } else if (firstMatchPos !== -1) {
        gaps++;
      }
      textIndex++;
    }
    if (patIndex !== pattern.length) return 0; // nicht alle Pattern-Zeichen gefunden
    score += Math.max(0, 300 - firstMatchPos * 2); // frühe Starts belohnen
    score += Math.max(0, 100 - gaps * 10); // weniger Lücken belohnen
    return score;
  }

  let filteredItems = itemsByFolder;
  if (q) {
    if (useFuzzy) {
      const scored = itemsByFolder
        .map((it) => ({ it, score: fuzzyScore(it.name.toLowerCase(), q) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => (b.score - a.score) || a.it.name.localeCompare(b.it.name));
      filteredItems = scored.map((x) => x.it);
    } else {
      filteredItems = itemsByFolder.filter((s) => s.name.toLowerCase().includes(q));
    }
  }

  const total = allItems.length;
  const recentCount = Math.min(10, total);
  // Nerdinfos: Top 3 meistgespielte
  const playsEntries = Object.entries(persistedState.plays || {});
  const top3 = playsEntries
    .sort((a, b) => (b[1] as number) - (a[1] as number))
    .slice(0, 3)
    .map(([rel, count]) => {
      const it = allItems.find(i => (i.relativePath === rel || i.fileName === rel));
      return it ? { key: `__top__:${rel}`, name: `${it.name} (${count})`, count: 1 } : null;
    })
    .filter(Boolean) as Array<{ key: string; name: string; count: number }>;

  const foldersOut = [
    { key: '__all__', name: 'Alle', count: total },
    { key: '__recent__', name: 'Neu', count: recentCount },
    ...(top3.length ? [{ key: '__top3__', name: 'Most Played (3)', count: top3.length }] : []),
    ...folders
  ];
  // isRecent-Flag für UI (Top 5 der neuesten)
  // Kategorie-Filter (virtuell) anwenden, wenn gesetzt
  let result = filteredItems;
  if (categoryFilter) {
    const fc = persistedState.fileCategories ?? {};
    result = result.filter((it) => {
      const key = it.relativePath ?? it.fileName;
      const cats = fc[key] ?? [];
      return cats.includes(categoryFilter);
    });
  }
  if (folderFilter === '__top3__') {
    const keys = new Set(top3.map(t => t.key.split(':')[1]));
    result = allItems.filter(i => keys.has(i.relativePath ?? i.fileName));
  }

  // Badges vorbereiten (Top3 = Rakete, Recent = New)
  const top3Set = new Set(top3.map(t => t.key.split(':')[1]));
  const customBadges = persistedState.fileBadges ?? {};
  const withRecentFlag = result.map((it) => {
    const key = it.relativePath ?? it.fileName;
    const badges: string[] = [];
    if (recentTop5Set.has(key)) badges.push('new');
    if (top3Set.has(key)) badges.push('rocket');
    for (const b of (customBadges[key] ?? [])) badges.push(b);
    return { ...it, isRecent: recentTop5Set.has(key), badges } as any;
  });

  res.json({ items: withRecentFlag, total, folders: foldersOut, categories: persistedState.categories ?? [], fileCategories: persistedState.fileCategories ?? {} });
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
  // UTF-8 Zeichen erlauben: Leerzeichen, Umlaute, etc. - nur problematische Zeichen filtern
  const sanitizedName = to.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const dstRel = path.join(parsed.dir || '', `${sanitizedName}.mp3`);
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

// --- Kategorien API ---
app.get('/api/categories', (_req: Request, res: Response) => {
  res.json({ categories: persistedState.categories ?? [] });
});

app.post('/api/categories', requireAdmin, (req: Request, res: Response) => {
  const { name, color, sort } = req.body as { name?: string; color?: string; sort?: number };
  const n = (name || '').trim();
  if (!n) return res.status(400).json({ error: 'name erforderlich' });
  const id = crypto.randomUUID();
  const cat = { id, name: n, color, sort };
  persistedState.categories = [...(persistedState.categories ?? []), cat];
  writePersistedState(persistedState);
  res.json({ ok: true, category: cat });
});

app.patch('/api/categories/:id', requireAdmin, (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, color, sort } = req.body as { name?: string; color?: string; sort?: number };
  const cats = persistedState.categories ?? [];
  const idx = cats.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Kategorie nicht gefunden' });
  const updated = { ...cats[idx] } as any;
  if (typeof name === 'string') updated.name = name;
  if (typeof color === 'string') updated.color = color;
  if (typeof sort === 'number') updated.sort = sort;
  cats[idx] = updated;
  persistedState.categories = cats;
  writePersistedState(persistedState);
  res.json({ ok: true, category: updated });
});

app.delete('/api/categories/:id', requireAdmin, (req: Request, res: Response) => {
  const { id } = req.params;
  const cats = persistedState.categories ?? [];
  if (!cats.find(c => c.id === id)) return res.status(404).json({ error: 'Kategorie nicht gefunden' });
  persistedState.categories = cats.filter(c => c.id !== id);
  // Zuordnungen entfernen
  const fc = persistedState.fileCategories ?? {};
  for (const k of Object.keys(fc)) fc[k] = (fc[k] ?? []).filter(x => x !== id);
  persistedState.fileCategories = fc;
  writePersistedState(persistedState);
  res.json({ ok: true });
});

// Bulk-Assign/Remove Kategorien zu Dateien
app.post('/api/categories/assign', requireAdmin, (req: Request, res: Response) => {
  const { files, add, remove } = req.body as { files?: string[]; add?: string[]; remove?: string[] };
  if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: 'files[] erforderlich' });
  const validCats = new Set((persistedState.categories ?? []).map(c => c.id));
  const toAdd = (add ?? []).filter(id => validCats.has(id));
  const toRemove = (remove ?? []).filter(id => validCats.has(id));
  const fc = persistedState.fileCategories ?? {};
  for (const rel of files) {
    const key = rel;
    const old = new Set(fc[key] ?? []);
    for (const a of toAdd) old.add(a);
    for (const r of toRemove) old.delete(r);
    fc[key] = Array.from(old);
  }
  persistedState.fileCategories = fc;
  writePersistedState(persistedState);
  res.json({ ok: true, fileCategories: fc });
});

// Badges (custom) setzen/entfernen (Rakete/Neu kommen automatisch, hier nur freie Badges)
app.post('/api/badges/assign', requireAdmin, (req: Request, res: Response) => {
  const { files, add, remove } = req.body as { files?: string[]; add?: string[]; remove?: string[] };
  if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: 'files[] erforderlich' });
  const fb = persistedState.fileBadges ?? {};
  for (const rel of files) {
    const key = rel;
    const old = new Set(fb[key] ?? []);
    for (const a of (add ?? [])) old.add(a);
    for (const r of (remove ?? [])) old.delete(r);
    fb[key] = Array.from(old);
  }
  persistedState.fileBadges = fb;
  writePersistedState(persistedState);
  res.json({ ok: true, fileBadges: fb });
});

// Alle Custom-Badges für die angegebenen Dateien entfernen
app.post('/api/badges/clear', requireAdmin, (req: Request, res: Response) => {
  const { files } = req.body as { files?: string[] };
  if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: 'files[] erforderlich' });
  const fb = persistedState.fileBadges ?? {};
  for (const rel of files) {
    delete fb[rel];
  }
  persistedState.fileBadges = fb;
  writePersistedState(persistedState);
  res.json({ ok: true, fileBadges: fb });
});

app.get('/api/channels', (_req: Request, res: Response) => {
  if (!client.isReady()) return res.status(503).json({ error: 'Bot noch nicht bereit' });

  const allowed = new Set(ALLOWED_GUILD_IDS);
  const result: Array<{ guildId: string; guildName: string; channelId: string; channelName: string; selected?: boolean }> = [];
  for (const [, guild] of client.guilds.cache) {
    if (allowed.size > 0 && !allowed.has(guild.id)) continue;
    const channels = guild.channels.cache;
    for (const [, ch] of channels) {
      if (ch?.type === ChannelType.GuildVoice || ch?.type === ChannelType.GuildStageVoice) {
        const sel = getSelectedChannelForGuild(guild.id);
        result.push({ guildId: guild.id, guildName: guild.name, channelId: ch.id, channelName: ch.name, selected: sel === ch.id });
      }
    }
  }
  result.sort((a, b) => a.guildName.localeCompare(b.guildName) || a.channelName.localeCompare(b.channelName));
  res.json(result);
});

// Globale Channel-Auswahl: auslesen (komplettes Mapping)
app.get('/api/selected-channels', (_req: Request, res: Response) => {
  try {
    res.json({ selected: persistedState.selectedChannels ?? {} });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Unbekannter Fehler' });
  }
});

// Globale Channel-Auswahl: setzen (validiert Channel-Typ)
app.post('/api/selected-channel', async (req: Request, res: Response) => {
  try {
    const { guildId, channelId } = req.body as { guildId?: string; channelId?: string };
    const gid = String(guildId ?? '');
    const cid = String(channelId ?? '');
    if (!gid || !cid) return res.status(400).json({ error: 'guildId und channelId erforderlich' });
    const guild = client.guilds.cache.get(gid);
    if (!guild) return res.status(404).json({ error: 'Guild nicht gefunden' });
    const ch = guild.channels.cache.get(cid);
    if (!ch || (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice)) {
      return res.status(400).json({ error: 'Ungültiger Voice-Channel' });
    }
    setSelectedChannelForGuild(gid, cid);
    return res.json({ ok: true });
  } catch (e: any) {
    console.error('selected-channel error', e);
    return res.status(500).json({ error: e?.message ?? 'Unbekannter Fehler' });
  }
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
    else if (folder) {
      // Bevorzugt .mp3, fallback .wav
      const mp3 = path.join(SOUNDS_DIR, folder, `${soundName}.mp3`);
      const wav = path.join(SOUNDS_DIR, folder, `${soundName}.wav`);
      filePath = fs.existsSync(mp3) ? mp3 : wav;
    } else {
      const mp3 = path.join(SOUNDS_DIR, `${soundName}.mp3`);
      const wav = path.join(SOUNDS_DIR, `${soundName}.wav`);
      filePath = fs.existsSync(mp3) ? mp3 : wav;
    }
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
    // Plays zählen (relativer Key verfügbar?)
    if (relativePath) incrementPlaysFor(relativePath);
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
      // Broadcast neue Lautstärke an alle Clients
      sseBroadcast({ type: 'volume', guildId, volume: safeVolume });
      return res.json({ ok: true, volume: safeVolume, persistedOnly: true });
    }
    state.currentVolume = safeVolume;
    if (state.currentResource?.volume) {
      state.currentResource.volume.setVolume(safeVolume);
      console.log(`${new Date().toISOString()} | live setVolume(${safeVolume}) guild=${guildId}`);
    }
    persistedState.volumes[guildId] = safeVolume;
    writePersistedState(persistedState);
    // Broadcast neue Lautstärke an alle Clients
    sseBroadcast({ type: 'volume', guildId, volume: safeVolume });
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

// Panik: Stoppe aktuelle Wiedergabe sofort
app.post('/api/stop', (req: Request, res: Response) => {
  try {
    const guildId = String((req.query.guildId || (req.body as any)?.guildId) ?? '');
    if (!guildId) return res.status(400).json({ error: 'guildId erforderlich' });
    const state = guildAudioState.get(guildId);
    if (!state) return res.status(404).json({ error: 'Kein aktiver Player' });
    state.player.stop(true);
    // Partymode für diese Guild ebenfalls stoppen
    try {
      const t = partyTimers.get(guildId);
      if (t) clearTimeout(t);
      partyTimers.delete(guildId);
      partyActive.delete(guildId);
      sseBroadcast({ type: 'party', guildId, active: false });
    } catch {}
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'Unbekannter Fehler' });
  }
});

// --- Partymode (serverseitig) ---
function schedulePartyPlayback(guildId: string, channelId: string) {
  const MIN_DELAY = 30_000; // 30s
  const MAX_EXTRA = 60_000; // +0..60s => 30..90s

  const doPlay = async () => {
    try {
      // Dateien ermitteln (mp3/wav, inkl. Subfolder)
      const rootEntries = fs.readdirSync(SOUNDS_DIR, { withFileTypes: true });
      const pick: string[] = [];
      for (const d of rootEntries) {
        if (d.isFile()) {
          const l = d.name.toLowerCase(); if (l.endsWith('.mp3') || l.endsWith('.wav')) pick.push(path.join(SOUNDS_DIR, d.name));
        } else if (d.isDirectory()) {
          const folderPath = path.join(SOUNDS_DIR, d.name);
          const entries = fs.readdirSync(folderPath, { withFileTypes: true });
          for (const e of entries) {
            if (!e.isFile()) continue;
            const n = e.name.toLowerCase();
            if (n.endsWith('.mp3') || n.endsWith('.wav')) pick.push(path.join(folderPath, e.name));
          }
        }
      }
      if (pick.length === 0) return;
      const filePath = pick[Math.floor(Math.random() * pick.length)];
      await playFilePath(guildId, channelId, filePath);
    } catch (err) {
      console.error('Partymode play error:', err);
    }
  };

  const loop = async () => {
    if (!partyActive.has(guildId)) return;
    await doPlay();
    if (!partyActive.has(guildId)) return;
    const delay = MIN_DELAY + Math.floor(Math.random() * MAX_EXTRA);
    const t = setTimeout(loop, delay);
    partyTimers.set(guildId, t);
  };

  // Start: sofort spielen und nächste planen
  partyActive.add(guildId);
  void loop();
  // Broadcast Status
  sseBroadcast({ type: 'party', guildId, active: true, channelId });
}

app.post('/api/party/start', async (req: Request, res: Response) => {
  try {
    const { guildId, channelId } = req.body as { guildId?: string; channelId?: string };
    if (!guildId || !channelId) return res.status(400).json({ error: 'guildId und channelId erforderlich' });
    // vorhandenen Timer stoppen
    const old = partyTimers.get(guildId); if (old) clearTimeout(old);
    partyTimers.delete(guildId);
    schedulePartyPlayback(guildId, channelId);
    return res.json({ ok: true });
  } catch (e: any) {
    console.error('party/start error', e);
    return res.status(500).json({ error: e?.message ?? 'Unbekannter Fehler' });
  }
});

app.post('/api/party/stop', (req: Request, res: Response) => {
  try {
    const { guildId } = req.body as { guildId?: string };
    const id = String(guildId ?? '');
    if (!id) return res.status(400).json({ error: 'guildId erforderlich' });
    const t = partyTimers.get(id); if (t) clearTimeout(t);
    partyTimers.delete(id);
    partyActive.delete(id);
    sseBroadcast({ type: 'party', guildId: id, active: false });
    return res.json({ ok: true });
  } catch (e: any) {
    console.error('party/stop error', e);
    return res.status(500).json({ error: e?.message ?? 'Unbekannter Fehler' });
  }
});

// Server-Sent Events Endpoint
app.get('/api/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Snapshot senden
  try {
    res.write(`data: ${JSON.stringify({ type: 'snapshot', party: Array.from(partyActive), selected: persistedState.selectedChannels ?? {}, volumes: persistedState.volumes ?? {} })}\n\n`);
  } catch {}

  // Ping, damit Proxies die Verbindung offen halten
  const ping = setInterval(() => { try { res.write(':\n\n'); } catch {} }, 15_000);

  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(ping);
    try { res.end(); } catch {}
  });
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
// Unterstützt: direkte MP3- oder WAV-URL (Download und Ablage)
app.post('/api/play-url', async (req: Request, res: Response) => {
  try {
    const { url, guildId, channelId, volume } = req.body as { url?: string; guildId?: string; channelId?: string; volume?: number };
    if (!url || !guildId || !channelId) return res.status(400).json({ error: 'url, guildId, channelId erforderlich' });

    const lower = url.toLowerCase();
    if (lower.endsWith('.mp3') || lower.endsWith('.wav')) {
      const fileName = path.basename(new URL(url).pathname);
      const dest = path.join(SOUNDS_DIR, fileName);
      const r = await fetch(url);
      if (!r.ok) return res.status(400).json({ error: 'Download fehlgeschlagen' });
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(dest, buf);
      try {
        await playFilePath(guildId, channelId, dest, volume, path.basename(dest));
      } catch {
        return res.status(500).json({ error: 'Abspielen fehlgeschlagen' });
      }
      return res.json({ ok: true, saved: path.basename(dest) });
    }
    return res.status(400).json({ error: 'Nur MP3- oder WAV-Links werden unterstützt.' });
  } catch (e: any) {
    console.error('play-url error:', e);
    return res.status(500).json({ error: e?.message ?? 'Unbekannter Fehler' });
  }
});

// Upload endpoint removed (build reverted)




