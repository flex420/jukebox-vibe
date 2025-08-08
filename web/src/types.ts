export type Sound = {
  fileName: string;
  name: string;
  folder?: string;
  relativePath?: string;
  isRecent?: boolean;
};

export type SoundsResponse = {
  items: Sound[];
  total: number;
  folders: Array<{ key: string; name: string; count: number }>;
};

export type VoiceChannelInfo = {
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
};





