import type { Sound, SoundsResponse, VoiceChannelInfo } from './types';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

export async function fetchSounds(q?: string, folderKey?: string, categoryId?: string, fuzzy?: boolean): Promise<SoundsResponse> {
  const url = new URL(`${API_BASE}/sounds`, window.location.origin);
  if (q) url.searchParams.set('q', q);
  if (folderKey !== undefined) url.searchParams.set('folder', folderKey);
  if (categoryId) url.searchParams.set('categoryId', categoryId);
  if (typeof fuzzy === 'boolean') url.searchParams.set('fuzzy', fuzzy ? '1' : '0');
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('Fehler beim Laden der Sounds');
  return res.json();
}

// Kategorien
export async function fetchCategories() {
  const res = await fetch(`${API_BASE}/categories`, { credentials: 'include' });
  if (!res.ok) throw new Error('Fehler beim Laden der Kategorien');
  return res.json();
}

export async function createCategory(name: string, color?: string) {
  const res = await fetch(`${API_BASE}/categories`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ name, color })
  });
  if (!res.ok) throw new Error('Kategorie anlegen fehlgeschlagen');
  return res.json();
}

export async function updateCategory(id: string, payload: { name?: string; color?: string; sort?: number }) {
  const res = await fetch(`${API_BASE}/categories/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Kategorie aktualisieren fehlgeschlagen');
  return res.json();
}

export async function deleteCategory(id: string) {
  const res = await fetch(`${API_BASE}/categories/${encodeURIComponent(id)}`, {
    method: 'DELETE', credentials: 'include'
  });
  if (!res.ok) throw new Error('Kategorie löschen fehlgeschlagen');
  return res.json();
}

export async function assignCategories(files: string[], add: string[], remove: string[] = []) {
  const res = await fetch(`${API_BASE}/categories/assign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ files, add, remove })
  });
  if (!res.ok) throw new Error('Zuordnung fehlgeschlagen');
  return res.json();
}

export async function assignBadges(files: string[], add: string[], remove: string[] = []) {
  const res = await fetch(`${API_BASE}/badges/assign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ files, add, remove })
  });
  if (!res.ok) throw new Error('Badges-Update fehlgeschlagen');
  return res.json();
}

export async function clearBadges(files: string[]) {
  const res = await fetch(`${API_BASE}/badges/clear`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ files })
  });
  if (!res.ok) throw new Error('Badges löschen fehlgeschlagen');
  return res.json();
}

export async function fetchChannels(): Promise<VoiceChannelInfo[]> {
  const res = await fetch(`${API_BASE}/channels`);
  if (!res.ok) throw new Error('Fehler beim Laden der Channels');
  return res.json();
}

export async function playSound(soundName: string, guildId: string, channelId: string, volume: number, relativePath?: string): Promise<void> {
  const res = await fetch(`${API_BASE}/play`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ soundName, guildId, channelId, volume, relativePath })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || 'Play fehlgeschlagen');
  }
}

export async function partyStart(guildId: string, channelId: string) {
  const res = await fetch(`${API_BASE}/party/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guildId, channelId })
  });
  if (!res.ok) throw new Error('Partymode Start fehlgeschlagen');
}

export async function partyStop(guildId: string) {
  const res = await fetch(`${API_BASE}/party/stop`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guildId })
  });
  if (!res.ok) throw new Error('Partymode Stop fehlgeschlagen');
}

export function subscribeEvents(onMessage: (data: any)=>void) {
  const ev = new EventSource(`${API_BASE}/events`);
  ev.onmessage = (e) => {
    try { const data = JSON.parse(e.data); onMessage(data); } catch {}
  };
  return () => ev.close();
}

export async function setVolumeLive(guildId: string, volume: number): Promise<void> {
  const res = await fetch(`${API_BASE}/volume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guildId, volume })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || 'Volume ändern fehlgeschlagen');
  }
}

export async function getVolume(guildId: string): Promise<number> {
  const url = new URL(`${API_BASE}/volume`, window.location.origin);
  url.searchParams.set('guildId', guildId);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('Fehler beim Laden der Lautstärke');
  const data = await res.json();
  return typeof data?.volume === 'number' ? data.volume : 1;
}

// Admin
export async function adminStatus(): Promise<boolean> {
  const res = await fetch(`${API_BASE}/admin/status`, { credentials: 'include' });
  if (!res.ok) return false;
  const data = await res.json();
  return !!data?.authenticated;
}

export async function adminLogin(password: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ password })
  });
  return res.ok;
}

export async function adminLogout(): Promise<void> {
  await fetch(`${API_BASE}/admin/logout`, { method: 'POST', credentials: 'include' });
}

export async function adminDelete(paths: string[]): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/sounds/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ paths })
  });
  if (!res.ok) throw new Error('Löschen fehlgeschlagen');
}

export async function adminRename(from: string, to: string): Promise<string> {
  const res = await fetch(`${API_BASE}/admin/sounds/rename`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ from, to })
  });
  if (!res.ok) throw new Error('Umbenennen fehlgeschlagen');
  const data = await res.json();
  return data?.to as string;
}

export async function playUrl(url: string, guildId: string, channelId: string, volume: number): Promise<void> {
  const res = await fetch(`${API_BASE}/play-url`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, guildId, channelId, volume })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || 'Play-URL fehlgeschlagen');
  }
}

// uploadFile removed (build reverted)





