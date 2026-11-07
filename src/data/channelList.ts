// A source's channel list as stored: one record holding a column (array) per
// field, rather than one record per channel. On the TV, 10,000 channels read
// in about 50-100 ms this way, against 730 ms as one record each, because
// there are far fewer objects to rebuild (PLAN.md, Phase 3, step 2).

import type { PlaylistChannel } from "./types";

/** A channel as the app holds it. */
export interface StoredChannel extends PlaylistChannel {
  source: string;
  /** Unique across sources: "<source>/<index>". */
  id: string;
}

type Column<K extends keyof PlaylistChannel> = (NonNullable<PlaylistChannel[K]> | null)[];

export interface ChannelColumns {
  count: number;
  name: string[];
  url: string[];
  /** Fields channels may lack: null where a channel has none, no column when none has it. */
  optional: {
    guideId?: Column<"guideId">;
    guideName?: Column<"guideName">;
    logo?: Column<"logo">;
    number?: Column<"number">;
    group?: Column<"group">;
    catchup?: Column<"catchup">;
    headers?: Column<"headers">;
    providerId?: Column<"providerId">;
  };
}

/** Channels in playlist order, so that a channel's index is its position. */
export const toColumns = (channels: PlaylistChannel[]): ChannelColumns => {
  const column = <K extends keyof ChannelColumns["optional"]>(field: K): Column<K> | undefined =>
    channels.some(channel => channel[field] !== undefined)
      ? channels.map(channel => channel[field] ?? null)
      : undefined;
  const optional: ChannelColumns["optional"] = {
    guideId: column("guideId"),
    guideName: column("guideName"),
    logo: column("logo"),
    number: column("number"),
    group: column("group"),
    catchup: column("catchup"),
    headers: column("headers"),
    providerId: column("providerId"),
  };
  return {
    count: channels.length,
    name: channels.map(channel => channel.name),
    url: channels.map(channel => channel.url),
    optional,
  };
};

/**
 * The channels back, as `source`'s. Every channel is built in one literal
 * with the same fields, missing ones undefined: adding fields one by one
 * made the TV take 115 ms more for 10,000 channels.
 */
export const fromColumns = (columns: ChannelColumns, source: string): StoredChannel[] => {
  const { name, url } = columns;
  const { guideId, guideName, logo, number, group, catchup, headers, providerId } = columns.optional;
  const channels: StoredChannel[] = Array.from({ length: columns.count });
  for (let index = 0; index < columns.count; index++) {
    channels[index] = {
      source,
      id: `${source}/${index}`,
      index,
      name: name[index] ?? "",
      url: url[index] ?? "",
      guideId: guideId?.[index] ?? undefined,
      guideName: guideName?.[index] ?? undefined,
      logo: logo?.[index] ?? undefined,
      number: number?.[index] ?? undefined,
      group: group?.[index] ?? undefined,
      catchup: catchup?.[index] ?? undefined,
      headers: headers?.[index] ?? undefined,
      providerId: providerId?.[index] ?? undefined,
    };
  }
  return channels;
};
