import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchChannels, fetchSounds, playSound, setVolumeLive, getVolume, adminStatus, adminLogin, adminLogout, adminDelete, adminRename, playUrl, fetchCategories, createCategory, assignCategories, clearBadges, updateCategory, deleteCategory, partyStart, partyStop, subscribeEvents, getSelectedChannels, setSelectedChannel } from './api';
import type { VoiceChannelInfo, Sound, Category } from './types';
import { getCookie, setCookie } from './cookies';

export default function App() {
  const [sounds, setSounds] = useState<Sound[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [folders, setFolders] = useState<Array<{ key: string; name: string; count: number }>>([]);
  const [activeFolder, setActiveFolder] = useState<string>('__all__');
  const [categories, setCategories] = useState<Category[]>([]);
  const [activeCategoryId, setActiveCategoryId] = useState<string>('');
  const [channels, setChannels] = useState<VoiceChannelInfo[]>([]);
  const [query, setQuery] = useState('');
  
  const [selected, setSelected] = useState<string>('');
  const selectedRef = useRef<string>('');
  const [loading, setLoading] = useState(false);
  const [notification, setNotification] = useState<{msg: string, type: 'info'|'error'} | null>(null);
  
  const [volume, setVolume] = useState<number>(1);
  const [favs, setFavs] = useState<Record<string, boolean>>({});
  const [theme, setTheme] = useState<string>(() => localStorage.getItem('theme') || 'dark');
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  
  // Chaos Mode (Partymode)
  const [chaosMode, setChaosMode] = useState<boolean>(false);
  const [partyActiveGuilds, setPartyActiveGuilds] = useState<string[]>([]);
  const chaosTimeoutRef = useRef<number | null>(null);
  const chaosModeRef = useRef<boolean>(false);

  // Scrolled State for Header blur
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => { chaosModeRef.current = chaosMode; }, [chaosMode]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const showNotification = (msg: string, type: 'info'|'error' = 'info') => {
    setNotification({msg, type});
    setTimeout(() => setNotification(null), 3000);
  };

  // ---------------- Init Load ----------------
  useEffect(() => {
    (async () => {
      try {
        const [c, selectedMap] = await Promise.all([fetchChannels(), getSelectedChannels()]);
        setChannels(c);
        let initial = '';
        if (c.length > 0) {
          const firstGuild = c[0].guildId;
          const serverCid = selectedMap[firstGuild];
          if (serverCid && c.find(x => x.guildId === firstGuild && x.channelId === serverCid)) {
            initial = `${firstGuild}:${serverCid}`;
          } else {
            initial = `${c[0].guildId}:${c[0].channelId}`;
          }
        }
        if (initial) setSelected(initial);
      } catch (e: any) {
        showNotification(e?.message || 'Fehler beim Laden der Channels', 'error');
      }
      try { setIsAdmin(await adminStatus()); } catch {}
      try { const cats = await fetchCategories(); setCategories(cats.categories || []); } catch {}
    })();
  }, []);

  // ---------------- Theme ----------------
  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  // ---------------- SSE Events ----------------
  useEffect(() => {
    const unsub = subscribeEvents((msg) => {
      if (msg?.type === 'party') {
        setPartyActiveGuilds((prev) => {
          const s = new Set(prev);
          if (msg.active) s.add(msg.guildId); else s.delete(msg.guildId);
          return Array.from(s);
        });
      } else if (msg?.type === 'snapshot') {
        setPartyActiveGuilds(Array.isArray(msg.party) ? msg.party : []);
        try {
          const sel = msg?.selected || {};
          const currentSelected = selectedRef.current || '';
          const gid = currentSelected ? currentSelected.split(':')[0] : '';
          if (gid && sel[gid]) {
            const newVal = `${gid}:${sel[gid]}`;
            setSelected(newVal);
          }
        } catch {}
        try {
          const vols = msg?.volumes || {};
          const cur = selectedRef.current || '';
          const gid = cur ? cur.split(':')[0] : '';
          if (gid && typeof vols[gid] === 'number') {
            setVolume(vols[gid]);
          }
        } catch {}
      } else if (msg?.type === 'channel') {
        try {
          const gid = msg.guildId;
          const cid = msg.channelId;
          if (gid && cid) {
            const currentSelected = selectedRef.current || '';
            const curGid = currentSelected ? currentSelected.split(':')[0] : '';
            if (curGid === gid) setSelected(`${gid}:${cid}`);
          }
        } catch {}
      } else if (msg?.type === 'volume') {
        try {
          const gid = msg.guildId;
          const v = msg.volume;
          const cur = selectedRef.current || '';
          const curGid = cur ? cur.split(':')[0] : '';
          if (gid && curGid === gid && typeof v === 'number') {
            setVolume(v);
          }
        } catch {}
      }
    });
    return () => { try { unsub(); } catch {} };
  }, []);

  useEffect(() => {
    const gid = selected ? selected.split(':')[0] : '';
    setChaosMode(gid ? partyActiveGuilds.includes(gid) : false);
  }, [selected, partyActiveGuilds]);

  // ---------------- Data Fetching ----------------
  useEffect(() => {
    (async () => {
      try {
        const folderParam = activeFolder === '__favs__' ? '__all__' : activeFolder;
        const s = await fetchSounds(query, folderParam, activeCategoryId || undefined, false); // Removed fuzzy param for cleaner UI
        setSounds(s.items);
        setTotal(s.total);
        setFolders(s.folders);
      } catch (e: any) {
        showNotification(e?.message || 'Fehler beim Laden der Sounds', 'error');
      }
    })();
  }, [activeFolder, query, activeCategoryId]);

  useEffect(() => {
    const c = getCookie('favs');
    if (c) { try { setFavs(JSON.parse(c)); } catch {} }
  }, []);

  useEffect(() => {
    try { setCookie('favs', JSON.stringify(favs)); } catch {}
  }, [favs]);

  useEffect(() => {
    (async () => {
      if (selected) {
        localStorage.setItem('selectedChannel', selected);
        try {
          const [guildId] = selected.split(':');
          const v = await getVolume(guildId);
          setVolume(v);
        } catch {}
      }
    })();
  }, [selected]);

  // ---------------- Actions ----------------
  async function handlePlay(name: string, rel?: string) {
    if (!selected) return showNotification('Bitte einen Voice-Channel auswählen', 'error');
    const [guildId, channelId] = selected.split(':');
    try {
      setLoading(true);
      await playSound(name, guildId, channelId, volume, rel);
    } catch (e: any) {
      showNotification(e?.message || 'Wiedergabe fehlgeschlagen', 'error');
    } finally {
      setLoading(false);
    }
  }

  // Chaos Mode Logic
  const startChaosMode = async () => {
    if (!selected || !sounds.length) return;
    const playRandomSound = async () => {
      const pool = sounds;
      if (!pool.length || !selected) return;
      const randomSound = pool[Math.floor(Math.random() * pool.length)];
      const [guildId, channelId] = selected.split(':');
      try {
        await playSound(randomSound.name, guildId, channelId, volume, randomSound.relativePath);
      } catch (e: any) { console.error('Chaos sound play failed:', e); }
    };

    const scheduleNextPlay = async () => {
      if (!chaosModeRef.current) return;
      await playRandomSound();
      const delay = 30_000 + Math.floor(Math.random() * 60_000); // 30-90 Sekunden
      chaosTimeoutRef.current = window.setTimeout(scheduleNextPlay, delay);
    };

    await playRandomSound();
    const firstDelay = 30_000 + Math.floor(Math.random() * 60_000);
    chaosTimeoutRef.current = window.setTimeout(scheduleNextPlay, firstDelay);
  };

  const stopChaosMode = async () => {
    if (chaosTimeoutRef.current) {
      clearTimeout(chaosTimeoutRef.current);
      chaosTimeoutRef.current = null;
    }
    if (selected) {
      const [guildId] = selected.split(':');
      try { await fetch(`/api/stop?guildId=${encodeURIComponent(guildId)}`, { method: 'POST' }); } catch {}
    }
  };

  const toggleChaosMode = async () => {
    if (chaosMode) {
      setChaosMode(false);
      await stopChaosMode();
      if (selected) { const [guildId] = selected.split(':'); try { await partyStop(guildId); } catch {} }
    } else {
      setChaosMode(true);
      await startChaosMode();
      if (selected) { const [guildId, channelId] = selected.split(':'); try { await partyStart(guildId, channelId); } catch {} }
    }
  };

  // Filter Data
  const filtered = sounds;
  const favCount = useMemo(() => Object.values(favs).filter(Boolean).length, [favs]);

  // Scroll Handler for Top Bar Blur
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setIsScrolled(e.currentTarget.scrollTop > 20);
  };

  return (
    <div className="app-layout">
      {/* ---------------- Sidebar ---------------- */}
      <aside className="sidebar">
        <h1 className="title-large" style={{ marginLeft: 12, marginBottom: 32, fontSize: 28, background: 'linear-gradient(45deg, var(--accent-blue), #5e5ce6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          Jukebox
        </h1>

        <div className="sidebar-title">Library</div>
        <button className={`nav-item ${activeFolder === '__all__' ? 'active' : ''}`} onClick={() => setActiveFolder('__all__')}>
          <div className="flex items-center gap-2"><span className="material-icons" style={{fontSize: 20}}>library_music</span>All Sounds</div>
          <span style={{opacity: 0.5, fontSize: 12}}>{total}</span>
        </button>
        <button className={`nav-item ${activeFolder === '__favs__' ? 'active' : ''}`} onClick={() => setActiveFolder('__favs__')}>
          <div className="flex items-center gap-2"><span className="material-icons" style={{fontSize: 20}}>favorite</span>Favorites</div>
          <span style={{opacity: 0.5, fontSize: 12}}>{favCount}</span>
        </button>
        <button className={`nav-item ${activeFolder === '__recent__' ? 'active' : ''}`} onClick={() => setActiveFolder('__recent__')}>
          <div className="flex items-center gap-2"><span className="material-icons" style={{fontSize: 20}}>schedule</span>Recently Added</div>
        </button>

        {folders.length > 3 && ( // 3 = __all__, __recent__, __top3__
          <>
            <div className="sidebar-title" style={{marginTop: 32}}>Folders</div>
            {folders.filter(f => !['__all__', '__recent__', '__top3__'].includes(f.key)).map(f => {
              const displayName = f.name.replace(/\s*\(\d+\)\s*$/, '');
              return (
                <button key={f.key} className={`nav-item ${activeFolder === f.key ? 'active' : ''}`} onClick={() => setActiveFolder(f.key)}>
                  <div className="flex items-center gap-2" style={{textOverflow: 'ellipsis', overflow: 'hidden'}}><span className="material-icons" style={{fontSize: 20}}>folder</span>{displayName}</div>
                  <span style={{opacity: 0.5, fontSize: 12}}>{f.count}</span>
                </button>
              );
            })}
          </>
        )}

        {categories.length > 0 && (
          <>
            <div className="sidebar-title" style={{marginTop: 32}}>Categories</div>
            {categories.map(cat => (
              <button key={cat.id} className={`nav-item ${activeCategoryId === cat.id ? 'active' : ''}`} onClick={() => setActiveCategoryId(prev => prev === cat.id ? '' : cat.id)}>
                <div className="flex items-center gap-2"><span className="material-icons" style={{fontSize: 20}}>label</span>{cat.name}</div>
              </button>
            ))}
          </>
        )}
      </aside>

      {/* ---------------- Main Content ---------------- */}
      <main className="main-content" onScroll={handleScroll}>
        <header className={`top-bar ${isScrolled ? 'scrolled' : ''}`}>
          <h2 className="title-large" style={{marginBottom: 0}}>
            {activeFolder === '__all__' ? 'All Sounds' : 
             activeFolder === '__favs__' ? 'Favorites' : 
             activeFolder === '__recent__' ? 'Recently Added' : 
             folders.find(f => f.key === activeFolder)?.name.replace(/\s*\(\d+\)\s*$/, '') || 'Library'}
          </h2>
          
          <div className="header-actions">
            <div className="search-box">
              <span className="material-icons search-icon">search</span>
              <input 
                type="text" 
                className="input-modern" 
                placeholder="Search..." 
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            
            <select 
              className="select-modern" 
              value={theme} 
              onChange={(e) => setTheme(e.target.value)}
              style={{paddingRight: 20, paddingLeft: 12}}
            >
              <option value="dark">Dark Theme</option>
              <option value="light">Light Theme</option>
            </select>
          </div>
        </header>

        <div className="track-container">
          <div className="track-grid">
            {(activeFolder === '__favs__' ? filtered.filter((s) => !!favs[s.relativePath ?? s.fileName]) : filtered).map((s) => {
              const key = `${s.relativePath ?? s.fileName}`;
              const isFav = !!favs[key];
              return (
                <div key={key} className="track-card" onClick={() => handlePlay(s.name, s.relativePath)}>
                  <button 
                    className={`fav-btn ${isFav ? 'active' : ''}`} 
                    onClick={(e) => { e.stopPropagation(); setFavs(prev => ({ ...prev, [key]: !prev[key] })); }}
                  >
                    <span className="material-icons">{isFav ? 'star' : 'star_border'}</span>
                  </button>
                  <div className="track-icon">
                    <span className="material-icons" style={{fontSize: 32}}>music_note</span>
                  </div>
                  <div className="track-name">{s.name}</div>
                  
                  {Array.isArray((s as any).badges) && (s as any).badges!.includes('new') && (
                    <div className="badge-new">NEW</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </main>

      {/* ---------------- Bottom Control Bar ---------------- */}
      <div className="bottom-player">
        <div className="player-section">
          {/* Target Channel */}
          <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
            <span className="material-icons" style={{color: 'var(--text-secondary)'}}>headset_mic</span>
            <select 
              className="select-modern" 
              value={selected} 
              onChange={async (e) => {
                const v = e.target.value;
                setSelected(v);
                try {
                  const [gid, cid] = v.split(':');
                  await setSelectedChannel(gid, cid);
                } catch {}
              }}
              style={{width: '240px', background: 'transparent', border: '1px solid var(--border-color)'}}
            >
              <option value="" disabled>Select Channel...</option>
              {channels.map((c) => (
                <option key={`${c.guildId}:${c.channelId}`} value={`${c.guildId}:${c.channelId}`}>
                  {c.guildName} • {c.channelName}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="player-section center">
          {/* Playback Controls */}
          <button 
            className="btn-danger" 
            onClick={async () => {
              setChaosMode(false); await stopChaosMode(); 
              if (selected) { const [guildId] = selected.split(':'); try { await fetch(`/api/stop?guildId=${encodeURIComponent(guildId)}`, { method: 'POST' }); } catch {} }
            }}
            title="Stop All"
          >
            <span className="material-icons" style={{fontSize: 20}}>stop</span>
          </button>

          <button 
            className="btn-primary" 
            onClick={async () => {
              try { 
                const items = sounds; 
                if (!items.length || !selected) return; 
                const rnd = items[Math.floor(Math.random()*items.length)]; 
                const [guildId, channelId] = selected.split(':'); 
                await playSound(rnd.name, guildId, channelId, volume, rnd.relativePath);
              } catch {}
            }}
            title="Play Random Sound"
            style={{padding: '12px 24px', display: 'flex', alignItems: 'center', gap: 6}}
          >
            <span className="material-icons" style={{fontSize: 20}}>shuffle</span> Shuffle
          </button>

          <button 
            className={`btn-icon ${chaosMode ? 'btn-chaos' : ''}`} 
            onClick={toggleChaosMode}
            title="Partymode (Auto-Play)"
            style={chaosMode ? {width: 'auto', padding: '0 16px', borderRadius: 999, display: 'flex', gap: 6} : {}}
          >
            <span className="material-icons" style={{fontSize: 20}}>{chaosMode ? 'celebration' : 'all_inclusive'}</span>
            {chaosMode && <span>Party Active</span>}
          </button>
        </div>

        <div className="player-section right">
          {/* Volume */}
          <div className="volume-container">
            <span className="material-icons" style={{color: 'var(--text-secondary)', fontSize: 18}}>volume_down</span>
            <input
              className="volume-slider"
              type="range" 
              min={0} max={1} step={0.01}
              value={volume}
              onChange={async (e) => {
                const v = parseFloat(e.target.value);
                setVolume(v);
                try { (e.target as HTMLInputElement).style.setProperty('--_fill', `${Math.round(v * 100)}%`); } catch {}
                if (selected) { const [guildId]=selected.split(':'); try{ await setVolumeLive(guildId, v);}catch{} }
              }}
              style={{ ['--_fill' as any]: `${Math.round(volume*100)}%` }}
            />
            <span className="material-icons" style={{color: 'var(--text-secondary)', fontSize: 18}}>volume_up</span>
          </div>
        </div>
      </div>

      {notification && (
        <div className={`notification ${notification.type}`}>
          <span className="material-icons" style={{fontSize: 18}}>
            {notification.type === 'error' ? 'error_outline' : 'check_circle'}
          </span>
          {notification.msg}
        </div>
      )}

    </div>
  );
}
