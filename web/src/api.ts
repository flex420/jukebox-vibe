import type { Sound, SoundsResponse, VoiceChannelInfo } from './types';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

export async function fetchSounds(q?: string, folderKey?: string): Promise<SoundsResponse> {
  const url = new URL(`${API_BASE}/sounds`, window.location.origin);
  if (q) url.searchParams.set('q', q);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('Fehler beim Laden der Sounds');
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





