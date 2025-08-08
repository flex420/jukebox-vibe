import React, { useEffect, useMemo, useState } from 'react';
import { fetchChannels, fetchSounds, playSound, setVolumeLive } from './api';
import type { VoiceChannelInfo, Sound } from './types';

export default function App() {
  const [sounds, setSounds] = useState<Sound[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [folders, setFolders] = useState<Array<{ key: string; name: string; count: number }>>([]);
  const [activeFolder, setActiveFolder] = useState<string>('__all__');
  const [channels, setChannels] = useState<VoiceChannelInfo[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState<number>(1);

  useEffect(() => {
    (async () => {
      try {
        const [s, c] = await Promise.all([fetchSounds(undefined, activeFolder), fetchChannels()]);
        setSounds(s.items);
        setTotal(s.total);
        setFolders(s.folders);
        setChannels(c);
        const stored = localStorage.getItem('selectedChannel');
        if (stored && c.find(x => `${x.guildId}:${x.channelId}` === stored)) {
          setSelected(stored);
        } else if (c[0]) {
          setSelected(`${c[0].guildId}:${c[0].channelId}`);
        }
      } catch (e: any) {
        setError(e?.message || 'Fehler beim Laden');
      }
    })();

    const interval = setInterval(async () => {
      try {
        const s = await fetchSounds(query, activeFolder);
        setSounds(s.items);
        setTotal(s.total);
        setFolders(s.folders);
      } catch {}
    }, 10000);
    return () => clearInterval(interval);
  }, [activeFolder]);

  useEffect(() => {
    if (selected) localStorage.setItem('selectedChannel', selected);
  }, [selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sounds;
    return sounds.filter((s) => s.name.toLowerCase().includes(q));
  }, [sounds, query]);

  async function handlePlay(name: string, rel?: string) {
    setError(null);
    if (!selected) return setError('Bitte einen Voice-Channel auswählen');
    const [guildId, channelId] = selected.split(':');
    try {
      setLoading(true);
      await playSound(name, guildId, channelId, volume, rel);
    } catch (e: any) {
      setError(e?.message || 'Play fehlgeschlagen');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container">
      <header>
        <h1>Discord Soundboard</h1>
        <p>Schicke dem Bot per privater Nachricht eine .mp3 — neue Sounds erscheinen automatisch.</p>
        <div className="badge">Geladene Sounds: {total}</div>
      </header>

      <section className="controls">
        <div className="control search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nach Sounds suchen..."
            aria-label="Suche"
          />
        </div>
        <div className="control select">
          <select value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Voice-Channel">
            {channels.map((c) => (
              <option key={`${c.guildId}:${c.channelId}`} value={`${c.guildId}:${c.channelId}`}>
                {c.guildName} – {c.channelName}
              </option>
            ))}
          </select>
        </div>
        <div className="control volume">
          <label>🔊 {Math.round(volume * 100)}%</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={async (e) => {
              const v = parseFloat(e.target.value);
              setVolume(v);
              if (selected) {
                const [guildId] = selected.split(':');
                try { await setVolumeLive(guildId, v); } catch {}
              }
            }}
            aria-label="Lautstärke"
          />
        </div>
      </section>

      {folders.length > 0 && (
        <nav className="tabs">
          {folders.map((f) => (
            <button
              key={f.key}
              className={`tab ${activeFolder === f.key ? 'active' : ''}`}
              type="button"
              onClick={async () => {
                setActiveFolder(f.key);
                const resp = await fetchSounds(undefined, f.key);
                setSounds(resp.items);
                setTotal(resp.total);
                setFolders(resp.folders);
              }}
            >
              {f.name} ({f.count})
            </button>
          ))}
        </nav>
      )}

      {error && <div className="error">{error}</div>}

      <section className="grid">
        {filtered.map((s) => (
          <button key={`${s.fileName}-${s.name}`} className="sound" type="button" onClick={() => handlePlay(s.name, s.relativePath)} disabled={loading}>
            {s.name}
          </button>
        ))}
        {filtered.length === 0 && <div className="hint">Keine Sounds gefunden.</div>}
      </section>
      {/* footer counter entfällt, da oben sichtbar */}
    </div>
  );
}

function handlePlayWithPathFactory(play: (name: string, rel?: string) => Promise<void>) {
  return (s: Sound & { relativePath?: string }) => play(s.name, s.relativePath);
}





