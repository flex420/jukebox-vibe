import React, { useEffect, useMemo, useState } from 'react';
import { fetchChannels, fetchSounds, playSound } from './api';
import type { VoiceChannelInfo, Sound } from './types';

export default function App() {
  const [sounds, setSounds] = useState<Sound[]>([]);
  const [channels, setChannels] = useState<VoiceChannelInfo[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [s, c] = await Promise.all([fetchSounds(), fetchChannels()]);
        setSounds(s);
        setChannels(c);
        if (c[0]) setSelected(`${c[0].guildId}:${c[0].channelId}`);
      } catch (e: any) {
        setError(e?.message || 'Fehler beim Laden');
      }
    })();

    const interval = setInterval(async () => {
      try {
        const s = await fetchSounds(query);
        setSounds(s);
      } catch {}
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sounds;
    return sounds.filter((s) => s.name.toLowerCase().includes(q));
  }, [sounds, query]);

  async function handlePlay(name: string) {
    setError(null);
    if (!selected) return setError('Bitte einen Voice-Channel auswählen');
    const [guildId, channelId] = selected.split(':');
    try {
      setLoading(true);
      await playSound(name, guildId, channelId);
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
      </header>

      <section className="controls">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Nach Sounds suchen..."
          aria-label="Suche"
        />
        <select value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Voice-Channel">
          {channels.map((c) => (
            <option key={`${c.guildId}:${c.channelId}`} value={`${c.guildId}:${c.channelId}`}>
              {c.guildName} – {c.channelName}
            </option>
          ))}
        </select>
      </section>

      {error && <div className="error">{error}</div>}

      <section className="grid">
        {filtered.map((s) => (
          <button key={s.fileName} className="sound" onClick={() => handlePlay(s.name)} disabled={loading}>
            {s.name}
          </button>
        ))}
        {filtered.length === 0 && <div className="hint">Keine Sounds gefunden.</div>}
      </section>
    </div>
  );
}





