import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { fetchChannels, fetchSounds, playSound, setVolumeLive, getVolume, adminStatus, adminLogin, adminLogout, adminDelete, adminRename, playUrl } from './api';
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
  const [info, setInfo] = useState<string | null>(null);
  const [showTop, setShowTop] = useState<boolean>(false);
  const [volume, setVolume] = useState<number>(1);
  const [favs, setFavs] = useState<Record<string, boolean>>({});
  const [theme, setTheme] = useState<string>(() => localStorage.getItem('theme') || 'dark');
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [adminPwd, setAdminPwd] = useState<string>('');
  const [selectedSet, setSelectedSet] = useState<Record<string, boolean>>({});
  const [showBroccoli, setShowBroccoli] = useState<boolean>(false);
  const selectedCount = useMemo(() => Object.values(selectedSet).filter(Boolean).length, [selectedSet]);
  const [clock, setClock] = useState<string>(() => new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Berlin' }).format(new Date()));
  const [totalPlays, setTotalPlays] = useState<number>(0);
  const [mediaUrl, setMediaUrl] = useState<string>('');
  const [chaosMode, setChaosMode] = useState<boolean>(false);
  const chaosTimeoutRef = useRef<number | null>(null);
  const chaosModeRef = useRef<boolean>(false);
  useEffect(() => { chaosModeRef.current = chaosMode; }, [chaosMode]);

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
      try {
        const h = await fetch('/api/health').then(r => r.json()).catch(() => null);
        if (h && typeof h.totalPlays === 'number') setTotalPlays(h.totalPlays);
      } catch {}
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
    if (import.meta.env.VITE_BUILD_CHANNEL === 'nightly') {
      document.body.setAttribute('data-build', 'nightly');
    } else {
      document.body.removeAttribute('data-build');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Back-to-top Sichtbarkeit
  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 300);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Live-Update für totalPlays Counter
  useEffect(() => {
    const updateTotalPlays = async () => {
      try {
        const h = await fetch('/api/health').then(r => r.json()).catch(() => null);
        if (h && typeof h.totalPlays === 'number') setTotalPlays(h.totalPlays);
      } catch {}
    };
    
    // Sofort beim Start laden
    updateTotalPlays();
    
    // Alle 5 Sekunden aktualisieren
    const interval = setInterval(updateTotalPlays, 5000);
    return () => clearInterval(interval);
  }, []);

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

  function toggleSelect(key: string, on?: boolean) {
    setSelectedSet((prev) => ({ ...prev, [key]: typeof on === 'boolean' ? on : !prev[key] }));
  }
  function clearSelection() {
    setSelectedSet({});
  }

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

  // CHAOS Mode Funktionen (zufällige Wiedergabe alle 1-3 Minuten)
  const startChaosMode = async () => {
    if (!selected || !sounds.length) return;

    const playRandomSound = async () => {
      const pool = sounds;
      if (!pool.length || !selected) return;
      const randomSound = pool[Math.floor(Math.random() * pool.length)];
      const [guildId, channelId] = selected.split(':');
      try {
        await playSound(randomSound.name, guildId, channelId, volume, randomSound.relativePath);
      } catch (e: any) {
        console.error('Chaos sound play failed:', e);
      }
    };

    const scheduleNextPlay = async () => {
      if (!chaosModeRef.current) return;
      await playRandomSound();
      const delay = 60_000 + Math.floor(Math.random() * 60_000); // 60-120 Sekunden
      chaosTimeoutRef.current = window.setTimeout(scheduleNextPlay, delay);
    };

    // Sofort ersten Sound abspielen
    await playRandomSound();
    // Nächsten zufällig in 1-3 Minuten planen
    const firstDelay = 60_000 + Math.floor(Math.random() * 60_000);
    chaosTimeoutRef.current = window.setTimeout(scheduleNextPlay, firstDelay);
  };

  const stopChaosMode = async () => {
    if (chaosTimeoutRef.current) {
      clearTimeout(chaosTimeoutRef.current);
      chaosTimeoutRef.current = null;
    }
    
    // Alle Sounds stoppen (wie Panic Button)
    if (selected) {
      const [guildId] = selected.split(':');
      try {
        await fetch(`/api/stop?guildId=${encodeURIComponent(guildId)}`, { method: 'POST' });
      } catch (e: any) {
        console.error('Chaos stop failed:', e);
      }
    }
  };

  const toggleChaosMode = async () => {
    if (chaosMode) {
      setChaosMode(false);
      await stopChaosMode();
    } else {
      setChaosMode(true);
      await startChaosMode();
    }
  };

  // Cleanup bei Komponenten-Unmount
  useEffect(() => {
    return () => {
      if (chaosTimeoutRef.current) {
        clearTimeout(chaosTimeoutRef.current);
      }
    };
  }, []);

  return (
    <ErrorBoundary>
      <div className="container mx-auto" data-theme={theme}>
        {/* Floating Broccoli for 420 Theme */}
        {theme === '420' && showBroccoli && (
          <>
            <div className="broccoli">🥦</div>
            <div className="broccoli">🥦</div>
            <div className="broccoli">🥦</div>
            <div className="broccoli">🥦</div>
            <div className="broccoli">🥦</div>
            <div className="broccoli">🥦</div>
          </>
        )}
        <header className="flex items-center justify-between p-6">
          <div className="flex items-center">
            <div>
              <h1 className="text-4xl font-bold">
                Jukebox 420
                {import.meta.env.VITE_BUILD_CHANNEL === 'nightly' && (
                  <span className="text-sm font-semibold ml-2" style={{ color: '#ff4d4f' }}>Nightly Build</span>
                )}
              </h1>
              <p className="text-7xl font-bold mt-2">{clock}</p>
            </div>
          </div>
          <div className="flex items-center space-x-8">
            <div className="text-center">
              <p className="text-lg text-gray-400">Sounds</p>
              <p className="text-2xl font-bold">{total}</p>
            </div>
            <div className="text-center">
              <p className="text-lg text-gray-400">Played</p>
              <p className="text-2xl font-bold">{totalPlays}</p>
            </div>
            <div className="flex items-center space-x-4">
              <button className="bg-gray-700 hover:bg-gray-600 text-white font-bold py-3 px-6 rounded-lg transition duration-300" onClick={async () => {
                try { const res = await fetch('/api/sounds'); const data = await res.json(); const items = data?.items || []; if (!items.length || !selected) return; const rnd = items[Math.floor(Math.random()*items.length)]; const [guildId, channelId] = selected.split(':'); await playSound(rnd.name, guildId, channelId, volume, rnd.relativePath);} catch {}
              }}>Random</button>
              <button 
                 className={`font-bold py-3 px-6 rounded-lg transition duration-300 ${
                   chaosMode 
                     ? 'chaos-rainbow text-white' 
                     : 'bg-gray-700 hover:bg-gray-600 text-white'
                 }`} 
                 onClick={toggleChaosMode}
               >
                 CHAOS
               </button>
              <button className="bg-red-600 hover:bg-red-700 text-white font-bold py-3 px-6 rounded-lg transition duration-300" onClick={async () => { setChaosMode(false); await stopChaosMode(); }}>Panic</button>
            </div>
          </div>
        </header>

        <div className="control-panel rounded-xl p-6 mb-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 items-center">
            <div className="relative">
              <input className="input-field pl-10 with-left-icon" placeholder="Nach Sounds suchen..." value={query} onChange={(e)=>setQuery(e.target.value)} />
              <span className="material-icons absolute left-3 top-1/2 -translate-y-1/2" style={{color:'var(--text-secondary)'}}>search</span>
            </div>
            <div className="relative">
              <CustomSelect channels={channels} value={selected} onChange={setSelected} />
              <span className="material-icons absolute left-3 top-1/2 -translate-y-1/2" style={{color:'var(--text-secondary)'}}>folder_special</span>
            </div>
            <div className="flex items-center space-x-3">
              <span className="material-icons" style={{color:'var(--text-secondary)'}}>volume_up</span>
              <input
                className="volume-slider w-full h-2 rounded-lg appearance-none cursor-pointer"
                type="range" min={0} max={1} step={0.01}
                value={volume}
                onChange={async (e)=>{
                  const v = parseFloat(e.target.value);
                  setVolume(v);
                  // CSS-Variable setzen, um die Füllbreite zu steuern
                  const percent = `${Math.round(v * 100)}%`;
                  try { (e.target as HTMLInputElement).style.setProperty('--_fill', percent); } catch {}
                  if(selected){ const [guildId]=selected.split(':'); try{ await setVolumeLive(guildId, v);}catch{} }
                }}
                // Initiale Füllbreite, falls State geladen ist
                style={{ ['--_fill' as any]: `${Math.round(volume*100)}%` }}
              />
              <span className="text-sm font-semibold w-8 text-center" style={{color:'var(--text-secondary)'}}>{Math.round(volume*100)}%</span>
            </div>
            <div className="relative md:col-span-2 lg:col-span-1">
              <input className="input-field pl-10 with-left-icon" placeholder="MP3 URL..." value={mediaUrl} onChange={(e)=>setMediaUrl(e.target.value)} onKeyDown={async (e)=>{ if(e.key==='Enter'){ if(!selected){ setError('Bitte Voice-Channel wählen'); setInfo(null); return;} const [guildId,channelId]=selected.split(':'); try{ await playUrl(mediaUrl,guildId,channelId,volume); setError(null); setInfo('MP3 heruntergeladen und abgespielt.'); }catch(err:any){ setInfo(null); setError(err?.message||'Download fehlgeschlagen'); } } }} />
              <span className="material-icons absolute left-3 top-1/2 -translate-y-1/2" style={{color:'var(--text-secondary)'}}>link</span>
              <button className="absolute right-0 top-0 h-full px-4 text-white flex items-center rounded-r-lg transition-all font-semibold" style={{background:'var(--accent-green)'}} onClick={async ()=>{ if(!selected){ setError('Bitte Voice-Channel wählen'); setInfo(null); return;} const [guildId,channelId]=selected.split(':'); try{ await playUrl(mediaUrl,guildId,channelId,volume); setError(null); setInfo('MP3 heruntergeladen und abgespielt.'); }catch(e:any){ setInfo(null); setError(e?.message||'Download fehlgeschlagen'); } }}>
                <span className="material-icons text-sm mr-1">file_download</span>
                Download
              </button>
            </div>
            <div className="flex items-center space-x-3 lg:col-span-2">
              <div className="relative flex-grow">
                                 <select className="input-field appearance-none pl-10" value={theme} onChange={(e)=>setTheme(e.target.value)}>
                   <option value="dark">Dark</option>
                   <option value="rainbow">Rainbow</option>
                   <option value="420">420</option>
                 </select>
                <span className="material-icons absolute left-3 top-1/2 -translate-y-1/2" style={{color:'var(--text-secondary)'}}>palette</span>
                <span className="material-icons absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{color:'var(--text-secondary)'}}>unfold_more</span>
              </div>
              {theme === '420' && (
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="broccoli-toggle"
                    checked={showBroccoli}
                    onChange={(e) => setShowBroccoli(e.target.checked)}
                    className="w-4 h-4 accent-green-500"
                  />
                  <label htmlFor="broccoli-toggle" className="text-sm font-medium" style={{color:'var(--text-secondary)'}}>
                    Brokkoli?
                  </label>
                </div>
              )}
            </div>
          </div>
          <div className="mt-6" style={{borderTop:'1px solid var(--border-color)', paddingTop:'1.5rem'}}>
            <div className="flex items-center gap-4 justify-between flex-wrap">
              {!isAdmin ? (
                <>
                  <div className="relative w-full sm:w-auto" style={{maxWidth:'15%'}}>
                    <input className="input-field pl-10 with-left-icon" placeholder="Admin Passwort" type="password" value={adminPwd} onChange={(e)=>setAdminPwd(e.target.value)} />
                    <span className="material-icons absolute left-3 top-1/2 -translate-y-1/2" style={{color:'var(--text-secondary)'}}>lock</span>
                  </div>
                  <button className="bg-gray-800 text-white hover:bg-black font-semibold py-2 px-5 rounded-lg transition-all w-full sm:w-auto" style={{maxWidth:'15%'}} onClick={async ()=>{ const ok=await adminLogin(adminPwd); if(ok){ setIsAdmin(true); setAdminPwd(''); } else alert('Login fehlgeschlagen'); }}>Login</button>
                </>
              ) : (
                <div className="flex items-center gap-3 w-full">
                  <span className="bg-gray-700 text-white font-bold py-3 px-6 rounded-lg">Ausgewählt: {selectedCount}</span>
                  {selectedCount > 0 && (
                    <button
                      className="bg-gray-700 hover:bg-gray-600 text-white font-bold py-3 px-6 rounded-lg transition duration-300"
                      onClick={async ()=>{
                        try {
                          const toDelete = Object.entries(selectedSet).filter(([,v])=>v).map(([k])=>k);
                          await adminDelete(toDelete);
                          clearSelection();
                          const resp = await fetchSounds(query, activeFolder === '__favs__' ? '__all__' : activeFolder);
                          setSounds(resp.items); setTotal(resp.total); setFolders(resp.folders);
                        } catch (e:any) { setError(e?.message||'Löschen fehlgeschlagen'); }
                      }}
                    >
                      Löschen
                    </button>
                  )}
                  {selectedCount === 1 && (
                    <RenameInline onSubmit={async (newName)=>{
                      const from = Object.entries(selectedSet).find(([,v])=>v)?.[0];
                      if(!from) return;
                      try {
                        await adminRename(from, newName);
                        clearSelection();
                        const resp = await fetchSounds(query, activeFolder === '__favs__' ? '__all__' : activeFolder);
                        setSounds(resp.items); setTotal(resp.total); setFolders(resp.folders);
                      } catch (e:any) { setError(e?.message||'Umbenennen fehlgeschlagen'); }
                    }} />
                  )}
                  <div className="flex-1" />
                  <button className="bg-red-600 hover:bg-red-700 text-white font-bold py-3 px-6 rounded-lg transition duration-300" onClick={async ()=>{ try{ await adminLogout(); setIsAdmin(false); clearSelection(); } catch{} }}>Logout</button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="bg-transparent mb-8">
          <div className="flex flex-wrap gap-3 text-sm">
            <button className={`tag-btn ${activeFolder==='__favs__'?'active':''}`} onClick={()=>setActiveFolder('__favs__')}>Favoriten ({favCount})</button>
            {folders.map(f=> {
              const displayName = f.name.replace(/\s*\(\d+\)\s*$/, '');
              return (
                <button
                  key={f.key}
                  className={`tag-btn ${activeFolder===f.key?'active':''}`}
                  onClick={async ()=>{
                    setActiveFolder(f.key);
                    const resp=await fetchSounds(undefined, f.key);
                    setSounds(resp.items); setTotal(resp.total); setFolders(resp.folders);
                  }}
                >
                  {displayName} ({f.count})
                </button>
              );
            })}
          </div>
        </div>

        {error && <div className="error">{error}</div>}
        {info && <div className="badge" style={{ background:'rgba(34,197,94,.18)', borderColor:'rgba(34,197,94,.35)' }}>{info}</div>}

        <main className="sounds-flow">
          {(activeFolder === '__favs__' ? filtered.filter((s) => !!favs[s.relativePath ?? s.fileName]) : filtered).map((s) => {
            const key = `${s.relativePath ?? s.fileName}`;
            const isFav = !!favs[key];
            return (
              <div key={`${s.fileName}-${s.name}`} className="sound-wrap">
                {isAdmin && (
                  <input
                    type="checkbox"
                    className="select-check"
                    checked={!!selectedSet[key]}
                    onChange={(e)=>{ e.stopPropagation(); toggleSelect(key, e.target.checked); }}
                  />
                )}
                <div className="sound-btn group rounded-xl flex items-center justify-between p-3 cursor-pointer" onClick={()=>handlePlay(s.name, s.relativePath)}>
                  <span className="text-sm font-medium truncate pr-2">{s.name}</span>
                  <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button className="text-gray-400 hover:text-[var(--accent-blue)]" onClick={(e)=>{e.stopPropagation(); setFavs(prev=>({ ...prev, [key]: !prev[key] }));}}><span className="material-icons text-xl">{isFav?'star':'star_border'}</span></button>
                  </div>
                </div>
              </div>
            );
          })}
        </main>
      </div>
      {showTop && (
        <button type="button" className="back-to-top" aria-label="Nach oben" onClick={()=>window.scrollTo({top:0, behavior:'smooth'})}>↑ Top</button>
      )}
    </ErrorBoundary>
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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number; width: number }>({ left: 0, top: 0, width: 0 });
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  useEffect(() => {
    if (!open) return;
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setMenuPos({ left: Math.round(r.left), top: Math.round(r.bottom + 6), width: Math.round(r.width) });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  const current = channels.find(c => `${c.guildId}:${c.channelId}` === value);

  return (
    <div className="control select custom-select" ref={ref}>
      <button ref={triggerRef} type="button" className="select-trigger" onClick={() => setOpen(v => !v)}>
        {current ? `${current.guildName} – ${current.channelName}` : 'Channel wählen'}
        <span className="chev">▾</span>
      </button>
      {open && typeof document !== 'undefined' && ReactDOM.createPortal(
        <div
          className="select-menu"
          style={{ position: 'fixed', left: menuPos.left, top: menuPos.top, width: menuPos.width, zIndex: 30000 }}
        >
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
        </div>,
        document.body
      )}
    </div>
  );
}

// Einfache ErrorBoundary, damit die Seite nicht blank wird und Fehler sichtbar sind
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: Error }>{
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: undefined };
  }
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: any) { console.error('UI-ErrorBoundary:', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20 }}>
          <h2>Es ist ein Fehler aufgetreten</h2>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{String(this.state.error.message || this.state.error)}</pre>
          <button type="button" onClick={() => this.setState({ error: undefined })}>Zurück</button>
        </div>
      );
    }
    return this.props.children as any;
  }
}

// Inline-Komponente für Umbenennen (nur bei genau 1 Selektion sichtbar)
type RenameInlineProps = { onSubmit: (newName: string) => void | Promise<void> };
function RenameInline({ onSubmit }: RenameInlineProps) {
  const [val, setVal] = useState('');
  async function submit() {
    const n = val.trim();
    if (!n) return;
    await onSubmit(n);
    setVal('');
  }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
             <input
         value={val}
         onChange={(e) => setVal(e.target.value)}
         placeholder="Neuer Name"
         onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
         style={{ color: '#000000' }}
       />
      <button type="button" className="bg-gray-700 hover:bg-gray-600 text-white font-bold py-3 px-6 rounded-lg transition duration-300" onClick={() => void submit()}>Umbenennen</button>
    </div>
  );
}





