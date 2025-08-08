import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchChannels, fetchSounds, playSound, setVolumeLive } from './api';
import type { VoiceChannelInfo, Sound } from './types';
import { getCookie, setCookie } from './cookies';

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
  const [favs, setFavs] = useState<Record<string, boolean>>({});

  useEffect(() => {
    (async () => {
      try {
        const c = await fetchChannels();
        setChannels(c);
        const stored = localStorage.getItem('selectedChannel');
        if (stored && c.find(x => `${x.guildId}:${x.channelId}` === stored)) {
          setSelected(stored);
        } else if (c[0]) {
          setSelected(`${c[0].guildId}:${c[0].channelId}`);
        }
      } catch (e: any) {
        setError(e?.message || 'Fehler beim Laden der Channels');
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const folderParam = activeFolder === '__favs__' ? '__all__' : activeFolder;
        const s = await fetchSounds(query, folderParam);
        setSounds(s.items);
        setTotal(s.total);
        setFolders(s.folders);
      } catch (e: any) {
        setError(e?.message || 'Fehler beim Laden der Sounds');
      }
    })();
  }, [activeFolder, query]);

  // Favoriten aus Cookie laden
  useEffect(() => {
    const c = getCookie('favs');
    if (c) {
      try { setFavs(JSON.parse(c)); } catch {}
    }
  }, []);

  // Favoriten persistieren
  useEffect(() => {
    try { setCookie('favs', JSON.stringify(favs)); } catch {}
  }, [favs]);

  useEffect(() => {
    if (selected) localStorage.setItem('selectedChannel', selected);
  }, [selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sounds;
    return sounds.filter((s) => s.name.toLowerCase().includes(q));
  }, [sounds, query]);

  const favCount = useMemo(() => Object.values(favs).filter(Boolean).length, [favs]);

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

      <section className="controls glass">
        <div className="control search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nach Sounds suchen..."
            aria-label="Suche"
          />
        </div>
        <CustomSelect
          channels={channels}
          value={selected}
          onChange={setSelected}
        />
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
        <nav className="tabs glass">
          {/* Favoriten Tab */}
          <button
            key="__favs__"
            className={`tab ${activeFolder === '__favs__' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveFolder('__favs__')}
          >
            Favoriten ({favCount})
          </button>
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
        {(activeFolder === '__favs__' ? filtered.filter((s) => !!favs[s.relativePath ?? s.fileName]) : filtered).map((s) => {
          const key = `${s.relativePath ?? s.fileName}`;
          const isFav = !!favs[key];
          return (
            <div key={`${s.fileName}-${s.name}`} className="sound-wrap">
              <button className="sound" type="button" onClick={() => handlePlay(s.name, s.relativePath)} disabled={loading}>
                {s.name}
              </button>
              <button
                className={`fav ${isFav ? 'active' : ''}`}
                aria-label={isFav ? 'Favorit entfernen' : 'Als Favorit speichern'}
                title={isFav ? 'Favorit entfernen' : 'Als Favorit speichern'}
                onClick={() => setFavs((prev) => ({ ...prev, [key]: !prev[key] }))}
              >
                ★
              </button>
            </div>
          );
        })}
        {filtered.length === 0 && <div className="hint">Keine Sounds gefunden.</div>}
      </section>
      {/* footer counter entfällt, da oben sichtbar */}
    </div>
  );
}

type SelectProps = {
  channels: VoiceChannelInfo[];
  value: string;
  onChange: (v: string) => void;
};

function CustomSelect({ channels, value, onChange }: SelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  const current = channels.find(c => `${c.guildId}:${c.channelId}` === value);

  return (
    <div className="control select custom-select" ref={ref}>
      <button type="button" className="select-trigger" onClick={() => setOpen(v => !v)}>
        {current ? `${current.guildName} – ${current.channelName}` : 'Channel wählen'}
        <span className="chev">▾</span>
      </button>
      {open && (
        <div className="select-menu">
          {channels.map((c) => {
            const v = `${c.guildId}:${c.channelId}`;
            const active = v === value;
            return (
              <button
                type="button"
                key={v}
                className={`select-item ${active ? 'active' : ''}`}
                onClick={() => { onChange(v); setOpen(false); }}
              >
                {c.guildName} – {c.channelName}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}





