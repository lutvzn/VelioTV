// Live TV and the TV guide working together (PLAN.md, Phase 4, step 5).
//
// One page passes the next the channel to show, which group it came from,
// and where Back should go, as a hand-off taken when the next page opens.
// OK in the guide watches a channel full screen, and Back there returns to
// the guide; the Guide key in Live TV opens the guide, and Back there
// returns to the channel.
//
// Both pages play video, so a stream one leaves playing can carry on in the
// next: a page that plays holds the player while it's open, and the player
// stops only once no page holds it. Starting a channel that is already
// playing then keeps its stream, instead of waiting seconds for it again.

import { onCleanup } from "solid-js";
import type { Channel } from "../data/lineup";
import { player } from "../player";
import {
  DROPPED,
  FROZEN,
  NEEDS_REFERER,
  OFFLINE,
  STALLED,
  START_TIMEOUT_MS,
  TIMEOUT,
} from "../player/player";
import { $t } from "../translate";

export interface Handoff {
  /** The channel to show. */
  channelId?: string;
  /** The group it was picked from; undefined for every channel. */
  group?: string;
  /** The guide only: Back returns to full screen, as it was opened from there with the Guide key. */
  backTo?: "/watch";
}

let waiting: Handoff | undefined;

/** Leaves a hand-off for the page about to open. */
export const handOff = (handoff: Handoff) => {
  waiting = handoff;
};

/** The hand-off left for this page, once. */
export const takeHandoff = () => {
  const taken = waiting;
  waiting = undefined;
  return taken;
};

let holders = 0;

/** Holds the player while the calling component is open. */
export const holdPlayer = () => {
  holders++;
  onCleanup(() => {
    holders--;
    // The next page opens in the same task, so wait for it to hold.
    setTimeout(() => {
      if (holders === 0) player.stop();
    }, 0);
  });
};

const ACTIVE = new Set(["starting", "playing", "buffering", "reconnecting", "suspended"]);

/** Whether `channel`'s stream is open, or opening. */
export const isPlaying = (channel: Channel) => {
  const { state, stream } = player.status();
  return (
    ACTIVE.has(state) &&
    stream?.url === channel.url &&
    stream.userAgent === channel.headers?.userAgent &&
    stream.referer === channel.headers?.referer
  );
};

/** A channel's live stream. */
export const channelStream = (channel: Channel) => ({
  url: channel.url,
  userAgent: channel.headers?.userAgent,
  referer: channel.headers?.referer,
  live: true,
});

/** Starts a channel's stream, unless it is already playing. */
export const playChannel = (channel: Channel, options: { keep?: boolean } = {}) => {
  if (options.keep !== false && isPlaying(channel)) return;
  void player.play(channelStream(channel));
};

/** What went wrong, in words. */
const errorText = (error: string | undefined, startTimeoutMs = START_TIMEOUT_MS) => {
  if (error === NEEDS_REFERER) return $t("live.error.referer");
  if (error === TIMEOUT) return $t("live.error.timeout", { seconds: Math.round(startTimeoutMs / 1000) });
  if (error === STALLED) return $t("live.error.stalled");
  if (error === FROZEN) return $t("live.error.frozen");
  if (error === DROPPED) return $t("live.error.dropped");
  if (error && /CONNECTION|NETWORK/i.test(error)) return $t("live.error.connection");
  if (error && /NOT_SUPPORTED|UNSUPPORTED/i.test(error)) return $t("live.error.format");
  return error ?? "";
};

/** The player's state in words, while it isn't simply playing. */
export const statusText = () => {
  const { state, error, attempt, attempts, stream } = player.status();
  if (state === "starting" && stream?.from) return $t("play.waitingFor", { name: stream.from });
  if (state === "starting") return $t("live.starting");
  if (state === "buffering") return $t("live.buffering");
  if (state === "ended") return $t("live.ended");
  if (state === "reconnecting" && error === OFFLINE) return $t("live.offline");
  if (state === "reconnecting") {
    return `${errorText(error, stream?.startTimeoutMs)} ${$t("live.reconnecting", { attempt: attempt ?? 1, attempts: attempts ?? 1 })}`;
  }
  if (state !== "failed") return undefined;
  return `${$t("live.failed")}. ${errorText(error, stream?.startTimeoutMs)}`;
};
