// What the player page (src/pages/Play.tsx) is to play, handed to it as it
// opens (PLAN.md, Phase 6): a programme from a channel's catch-up, or a film
// or an episode.

import type { StoredProgramme } from "../data/guideCodec";
import type { Channel } from "../data/lineup";
import type { WatchedItem } from "../data/watched";
import type { Stream } from "../player/player";

export interface CatchupPlay {
  kind: "catchup";
  channel: Channel;
  programme: StoredProgramme;
  /** Where in the programme to start, as a time; its start by default. */
  from?: number;
  /** The guide group it was picked from, for Back. */
  group?: string;
  /**
   * From live TV, paused or rewound (PLAN.md, Phase 7, step 2): leaving goes
   * back to the channel live, not to the guide.
   */
  fromLive?: boolean;
}

/** A subtitle file from a Stremio add-on, which the player page reads and draws (src/play/externalSubtitles.ts). */
export interface ExternalSubtitle {
  id: string;
  url: string;
  /** As the add-on gives it, such as "eng". */
  language: string;
  /** Which add-on has it. */
  from: string;
}

export interface VodPlay {
  kind: "vod";
  /** What it is, as the resume list keeps it (src/data/watched.ts). */
  item: WatchedItem;
  stream: Stream;
  /** Where to start, in milliseconds. */
  startMs?: number;
  /** For an episode: the next one, to play when it ends. */
  next?: () => Promise<VodPlay | undefined>;
  /** The page Back returns to. */
  back: "/movies" | "/series";
  /** Subtitle files from add-ons, asked for as it starts. */
  subtitles?: () => Promise<ExternalSubtitle[]>;
}

export type PlayRequest = CatchupPlay | VodPlay;

let waiting: PlayRequest | undefined;

/** Leaves what to play for the player page, which opens next. */
export const handPlay = (request: PlayRequest) => {
  waiting = request;
};

/** What the player page is to play, once. */
export const takePlay = () => {
  const taken = waiting;
  waiting = undefined;
  return taken;
};
