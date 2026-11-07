// Which channel Live TV shows, and changing it (PLAN.md, Phase 3, step 3).
//
// Zapping changes the channel shown at once, so the banner can follow each
// press, and plays it only once the presses stop for a moment: switching
// streams blocks the UI for a few hundred milliseconds on the TV (step 1), so
// a run of presses should open only the channel it ends on. Picking a
// channel from the list, or by number, plays it straight away.
//
// Zapping moves through a group when one was picked from the list, or else
// through every channel. Channel numbers are the playlist's (tvg-chno), or
// else the channel's position in the lineup, from 1. The last channel played
// is remembered for the next start.

import { createMemo, createSignal } from "solid-js";
import type { Channel, ChannelGroup } from "../data/lineup";

export const ZAP_DELAY_MS = 400;
export const NUMBER_DELAY_MS = 2000;
export const MAX_DIGITS = 5;
const LAST_CHANNEL_KEY = "tiviplayer.lastChannel";

export interface ZapperOptions {
  channels: () => Channel[];
  groups: () => ChannelGroup[];
  find: (id: string) => Channel | undefined;
  /** Channel numbers, when they come from more than `channels`. */
  numbers?: () => ChannelNumbers;
  /** Starts a channel's stream. */
  play: (channel: Channel) => void;
  storage?: Pick<Storage, "getItem" | "setItem">;
  zapDelayMs?: number;
  numberDelayMs?: number;
}

/** Channel numbers both ways: the playlist's, or else the position from 1. */
export interface ChannelNumbers {
  byId: Map<string, number>;
  byNumber: Map<number, Channel>;
}

export const channelNumbers = (channels: readonly Channel[]): ChannelNumbers => {
  const byId = new Map<string, number>();
  const byNumber = new Map<number, Channel>();
  channels.forEach((channel, index) => {
    const number = channel.number ?? index + 1;
    byId.set(channel.id, number);
    if (!byNumber.has(number)) byNumber.set(number, channel);
  });
  return { byId, byNumber };
};

/** The id of the channel last played, if any. */
export const rememberedChannel = (storage: Pick<Storage, "getItem"> | undefined) => {
  try {
    return storage?.getItem(LAST_CHANNEL_KEY) ?? undefined;
  } catch {
    // As if nothing was remembered.
    return undefined;
  }
};

export const createZapper = (options: ZapperOptions) => {
  const storage = options.storage;
  const [shownId, setShownId] = createSignal<string>();
  const [playingId, setPlayingId] = createSignal<string>();
  /** The group zapping moves through; undefined for every channel. */
  const [group, setGroup] = createSignal<string>();
  const [digits, setDigits] = createSignal("");
  /** A number that was entered but matches no channel. */
  const [missing, setMissing] = createSignal<string>();
  let zapTimer: ReturnType<typeof setTimeout> | undefined;
  let numberTimer: ReturnType<typeof setTimeout> | undefined;

  const numbers = options.numbers ?? createMemo(() => channelNumbers(options.channels()));

  const groupChannels = (name: string | undefined) =>
    name === undefined ? options.channels() : (options.groups().find(g => g.name === name)?.channels ?? []);
  const zapList = () => {
    const list = groupChannels(group());
    // A group emptied by an import falls back to every channel.
    return list.length > 0 ? list : options.channels();
  };

  const play = (channel: Channel) => {
    clearTimeout(zapTimer);
    zapTimer = undefined;
    setShownId(channel.id);
    setPlayingId(channel.id);
    try {
      storage?.setItem(LAST_CHANNEL_KEY, channel.id);
    } catch {
      // A full or blocked storage only loses the remembered channel.
    }
    options.play(channel);
  };

  const clearDigits = () => {
    clearTimeout(numberTimer);
    numberTimer = undefined;
    setDigits("");
  };

  const enter = () => {
    const typed = digits();
    clearDigits();
    if (!typed) return;
    const channel = numbers().byNumber.get(Number(typed));
    if (channel) {
      setGroup(undefined);
      play(channel);
    } else {
      setMissing(typed);
    }
  };

  return {
    /** The channel to show: the one playing, or the one zapping is on. */
    shown: () => {
      const id = shownId();
      return id === undefined ? undefined : options.find(id);
    },
    /** The channel whose stream was last started. */
    playing: () => {
      const id = playingId();
      return id === undefined ? undefined : options.find(id);
    },
    /** Whether a zap is waiting to play. */
    pending: () => shownId() !== playingId(),
    numberOf: (channel: Channel) => numbers().byId.get(channel.id) ?? channel.index + 1,
    group,
    /** The channels of a group, or every channel for undefined. */
    groupChannels,

    /**
     * Plays the remembered channel, or the first one. It returns false while
     * there is nothing to play yet, or while the remembered channel may still
     * be loading.
     */
    start: (stillLoading: boolean) => {
      const channels = options.channels();
      if (channels.length === 0) return false;
      const last = rememberedChannel(storage);
      const found = last === undefined ? undefined : options.find(last);
      // A channel hidden since isn't played.
      const remembered = found && channels.includes(found) ? found : undefined;
      if (!remembered && last !== undefined && stillLoading) return false;
      play(remembered ?? channels[0]);
      return true;
    },

    /** Moves `step` channels through the zap list; plays after a pause. */
    zap: (step: number) => {
      const list = zapList();
      if (list.length === 0) return;
      const id = shownId();
      const at = id === undefined ? -1 : list.findIndex(channel => channel.id === id);
      // From outside the list, Up starts at its first channel and Down at its last.
      const from = at === -1 ? (step > 0 ? -1 : 0) : at;
      const target = list[(((from + step) % list.length) + list.length) % list.length];
      setShownId(target.id);
      clearTimeout(zapTimer);
      zapTimer = setTimeout(() => play(target), options.zapDelayMs ?? ZAP_DELAY_MS);
    },

    /** Plays a channel now; with `inGroup`, later zaps stay in that group. */
    tune: (channel: Channel, inGroup?: string) => {
      setGroup(inGroup);
      play(channel);
    },

    /** Digits typed so far, for the number entry. */
    digits,
    missing,
    digit: (value: number) => {
      const next = (digits() + String(value)).slice(-MAX_DIGITS);
      setDigits(next);
      setMissing(undefined);
      clearTimeout(numberTimer);
      numberTimer = setTimeout(enter, options.numberDelayMs ?? NUMBER_DELAY_MS);
    },
    /** Plays the channel with the number typed, now. */
    enterNumber: enter,
    clearDigits: () => {
      clearDigits();
      setMissing(undefined);
    },

    /** Cancels a zap waiting to play, going back to the channel playing. */
    cancelZap: () => {
      clearTimeout(zapTimer);
      zapTimer = undefined;
      setShownId(playingId());
    },
    /** Forgets the channels, such as when they were all removed. */
    reset: () => {
      clearTimeout(zapTimer);
      clearDigits();
      setShownId(undefined);
      setPlayingId(undefined);
      setGroup(undefined);
    },
    dispose: () => {
      clearTimeout(zapTimer);
      clearTimeout(numberTimer);
    },
  };
};

export type Zapper = ReturnType<typeof createZapper>;
