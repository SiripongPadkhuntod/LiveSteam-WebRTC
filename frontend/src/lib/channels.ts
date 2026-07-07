export type Channel = {
  id: string;
  name: string;
  description: string;
};

export const channels: Channel[] = [
  { id: "channel-1", name: "ประมูลนาฬิกา", description: "Live auction · Studio A" },
  { id: "channel-2", name: "ประมูลรถยนต์", description: "Live auction · Studio B" },
  { id: "channel-3", name: "ประมูลงานศิลปะ", description: "Live auction · Studio C" },
];

export const DEFAULT_CHANNEL_ID = channels[0].id;

export function channelIDFromSearch(search: string) {
  const requested = new URLSearchParams(search).get("channel") ?? "";
  return /^[a-z0-9-]{1,128}$/.test(requested) ? requested : DEFAULT_CHANNEL_ID;
}

export function channelByID(id: string) {
  return channels.find((channel) => channel.id === id) ?? {
    id,
    name: id,
    description: "Custom Channel",
  };
}

export function programRoomID(sourceRoomID: string) {
  return `${sourceRoomID}-program`;
}
