// Every source's channels, in memory, for the pages to read: all channels in
// the user's source order, by group, and by id. A source's list is read from
// the database once, and again when an import of it finishes, as the channel
// stage replaces it. Reading 10,000 channels takes a frame or a few on the TV
// (PLAN.md, Phase 3, step 2), so nothing reads them while scrolling.

import { createEffect, createMemo, createRoot, createSignal } from "solid-js";
import { openDb, readChannels, type ImportState, type StoredChannel } from "./db";
import type { Source } from "./sources";

export type Channel = StoredChannel;

export interface ChannelGroup {
  /** "" for channels without a group. */
  name: string;
  channels: Channel[];
}

export interface LineupOptions {
  sources: () => Source[];
  /** A source's last import state; see SourceManager.statusOf(). */
  stateOf: (id: string) => ImportState | undefined;
  /** Reads a source's channels; by default from the app's database. */
  read?: (source: string) => Promise<Channel[]>;
  dbName?: string;
}

interface Loaded {
  /** The import the list came from; see versionOf(). */
  version: string;
  channels: Channel[];
}

// Which stored list a state describes. While a source imports, the list from
// before (or, after the channel stage, the new one) stays loaded.
const versionOf = (state: ImportState) => `${state.status}:${state.startedAt}`;

export const createLineup = (options: LineupOptions) =>
  createRoot(dispose => {
    let dbPromise: Promise<IDBDatabase> | undefined;
    const read =
      options.read ??
      (async (source: string) => readChannels(await (dbPromise ??= openDb(options.dbName)), source));

    const [lists, setLists] = createSignal<Record<string, Loaded>>({});
    const [loading, setLoading] = createSignal(0);
    // The version each source is being read for, so an older read that ends
    // later doesn't replace a newer one.
    const reading = new Map<string, string>();

    const load = async (source: string, version: string) => {
      reading.set(source, version);
      setLoading(n => n + 1);
      try {
        const channels = await read(source);
        if (reading.get(source) === version) {
          setLists(all => ({ ...all, [source]: { version, channels } }));
        }
      } catch (error) {
        console.error("Couldn't read a source's channels:", error);
      } finally {
        if (reading.get(source) === version) reading.delete(source);
        setLoading(n => n - 1);
      }
    };

    createEffect(() => {
      const current = lists();
      const ids = new Set<string>();
      for (const source of options.sources()) {
        ids.add(source.id);
        const state = options.stateOf(source.id);
        if (!state) continue;
        const loaded = current[source.id];
        const version = versionOf(state);
        // While importing, keep whatever is loaded; read only if nothing is.
        const wanted = state.status === "importing" ? !loaded : loaded?.version !== version;
        if (wanted && reading.get(source.id) !== version) void load(source.id, version);
      }
      // Sources removed, or whose data is gone.
      const stale = Object.keys(current).filter(id => !ids.has(id) || !options.stateOf(id));
      if (stale.length > 0) {
        setLists(all => {
          const next = { ...all };
          for (const id of stale) delete next[id];
          return next;
        });
      }
    });

    const channels = createMemo(() =>
      options.sources().flatMap(source => lists()[source.id]?.channels ?? []),
    );

    const groups = createMemo(() => {
      const byName = new Map<string, Channel[]>();
      for (const channel of channels()) {
        const name = channel.group ?? "";
        let list = byName.get(name);
        if (!list) byName.set(name, (list = []));
        list.push(channel);
      }
      return Array.from(byName, ([name, list]): ChannelGroup => ({ name, channels: list }));
    });

    const byId = createMemo(() => new Map(channels().map(channel => [channel.id, channel])));

    return {
      /** Every channel, in source order, then playlist order. */
      channels,
      /** Groups in the order their first channel appears. */
      groups,
      find: (id: string) => byId().get(id),
      /** Whether a list is being read. */
      loading: () => loading() > 0,
      close: async () => {
        dispose();
        if (dbPromise) (await dbPromise).close();
        dbPromise = undefined;
      },
    };
  });

export type Lineup = ReturnType<typeof createLineup>;
