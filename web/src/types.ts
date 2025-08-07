export type Sound = {
  fileName: string;
  name: string;
};

export type SoundsResponse = {
  items: Sound[];
  total: number;
};

export type VoiceChannelInfo = {
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
};





