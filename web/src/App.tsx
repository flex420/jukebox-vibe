import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchChannels, fetchSounds, playSound, setVolumeLive, getVolume, adminStatus, adminLogin, adminLogout, adminDelete, adminRename } from './api';
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
  const [theme, setTheme] = useState<string>(() => localStorage.getItem('theme') || 'dark');
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [adminPwd, setAdminPwd] = useState<string>('');
  const [selectedSet, setSelectedSet] = useState<Record<string, boolean>>({});
  const selectedCount = useMemo(() => Object.values(selectedSet).filter(Boolean).length, [selectedSet]);
  const [clock, setClock] = useState<string>(() => new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Berlin' }).format(new Date()));

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
      try { setIsAdmin(await adminStatus()); } catch {}
    })();
  }, []);

  // Uhrzeit (Berlin) aktualisieren
  useEffect(() => {
    const fmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Berlin' });
    const update = () => setClock(fmt.format(new Date()));
    const id = setInterval(update, 1000);
    update();
    return () => clearInterval(id);
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

  // Theme anwenden/persistieren
  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    (async () => {
      if (selected) {
        localStorage.setItem('selectedChannel', selected);
        // gespeicherte Lautstärke vom Server laden
        try {
          const [guildId] = selected.split(':');
          const v = await getVolume(guildId);
          setVolume(v);
        } catch {}
      }
    })();
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
        <div className="header-row">
          <h1>Einmal mit Soundboard -Profis</h1>
          <div className="clock">{clock}</div>
        </div>
        <div className="badge">Geladene Sounds: {total}</div>
        {isAdmin && (
          <div className="badge">Admin-Modus</div>
        )}
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
        <div className="control theme">
          <select value={theme} onChange={(e) => setTheme(e.target.value)} aria-label="Theme">
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="rainbow">Rainbow Chaos</option>
          </select>
        </div>
        {!isAdmin && (
          <div className="control" style={{ display: 'flex', gap: 8 }}>
            <input type="password" value={adminPwd} onChange={(e) => setAdminPwd(e.target.value)} placeholder="Admin Passwort" />
            <button type="button" className="tab" onClick={async () => {
              const ok = await adminLogin(adminPwd);
              if (ok) { setIsAdmin(true); setAdminPwd(''); }
              else alert('Login fehlgeschlagen');
            }}>Login</button>
          </div>
        )}
      </section>

      {/* Admin Toolbar */}
      {isAdmin && (
        <section className="controls glass" style={{ marginTop: -8 }}>
          <div className="control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="tab" onClick={async () => {
              const toDelete = Object.entries(selectedSet).filter(([, v]) => v).map(([k]) => k);
              if (toDelete.length === 0) return;
              if (!confirm(`Wirklich ${toDelete.length} Datei(en) löschen?`)) return;
              try { await adminDelete(toDelete); } catch (e: any) { alert(e?.message || 'Löschen fehlgeschlagen'); }
              // refresh
              const folderParam = activeFolder === '__favs__' ? '__all__' : activeFolder;
              const s = await fetchSounds(query, folderParam);
              setSounds(s.items);
              setTotal(s.total);
              setFolders(s.folders);
              setSelectedSet({});
            }}>🗑️ Löschen</button>
            {selectedCount === 1 && (
              <RenameInline onSubmit={async (newName) => {
                const from = Object.keys(selectedSet).find((k) => selectedSet[k]);
                if (!from) return;
                try { await adminRename(from, newName); } catch (e: any) { alert(e?.message || 'Umbenennen fehlgeschlagen'); return; }
                const folderParam = activeFolder === '__favs__' ? '__all__' : activeFolder;
                const s = await fetchSounds(query, folderParam);
                setSounds(s.items);
                setTotal(s.total);
                setFolders(s.folders);
                setSelectedSet({});
              }} />
            )}
            <button type="button" className="tab" onClick={async () => { await adminLogout(); setIsAdmin(false); }}>Logout</button>
          </div>
        </section>
      )}

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
          {/* Neueste 10 */}
          <button
            key="__recent__"
            className={`tab ${activeFolder === '__recent__' ? 'active' : ''}`}
            type="button"
            onClick={async () => {
              setActiveFolder('__recent__');
              const resp = await fetchSounds(undefined, '__recent__');
              setSounds(resp.items);
              setTotal(resp.total);
              setFolders(resp.folders);
            }}
          >
            Neu
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
            <div key={`${s.fileName}-${s.name}`} className="sound-wrap row">
              {isAdmin && (
                <input
                  className="row-check"
                  type="checkbox"
                  checked={!!selectedSet[key]}
                  onClick={(e) => { e.stopPropagation(); }}
                  onChange={(e) => setSelectedSet((prev) => ({ ...prev, [key]: e.target.checked }))}
                />
              )}
              <button className="sound" type="button" onClick={(e) => { e.stopPropagation(); handlePlay(s.name, s.relativePath); }} disabled={loading}>
                {s.isRecent ? '🆕 ' : ''}{s.name}
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





