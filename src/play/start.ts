// Opening the player page (src/pages/Play.tsx) on a recording, a film or an
// episode, from any page.

import { DAY, type StoredProgramme } from "../data/guideCodec";
import type { Channel } from "../data/lineup";
import { guide } from "../library";
import { handPlay, type VodPlay } from "./session";

type Navigate = (path: string, options: { replace: boolean }) => void;

/** Plays a programme from `channel`'s catch-up, from its start or from `from`. */
export const watchRecording = (
  navigate: Navigate,
  channel: Channel,
  programme: StoredProgramme,
  options: { group?: string; from?: number; fromLive?: boolean } = {},
) => {
  handPlay({ kind: "catchup", channel, programme, ...options });
  navigate("/play", { replace: true });
};

/** Plays a film or an episode. */
export const watchVod = (navigate: Navigate, play: Omit<VodPlay, "kind">) => {
  handPlay({ kind: "vod", ...play });
  navigate("/play", { replace: true });
};

/** The programme on `channel` at `time`, if the guide has it. */
export const programmeAt = async (channel: Channel, time: number) => {
  if (!channel.guideId) return undefined;
  const day = await guide.day(channel.source, channel.guideId, Math.floor(time / DAY));
  return day.find(programme => programme.start <= time && programme.stop > time);
};
