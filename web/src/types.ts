export type Sound = {
  fileName: string;
  name: string;
  folder?: string;
  relativePath?: string;
  isRecent?: boolean;
  badges?: string[];
};

export type SoundsResponse = {
  items: Sound[];
  total: number;
  folders: Array<{ key: string; name: string; count: number }>;
  categories?: Category[];
  fileCategories?: Record<string, string[]>;
};

export type VoiceChannelInfo = {
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
  selected?: boolean;
};

export type Category = { id: string; name: string; color?: string; sort?: number };





