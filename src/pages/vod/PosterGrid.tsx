import { type ElementNode, Text, View } from "@solidtv/solid";
import { batch, createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { MENU_WIDTH } from "../../components/SideMenu";
import { exposeToProbes } from "../../devHooks";
import { fold } from "../../guide/search";
import { scrollTop, wrapIndex } from "../../live/listWindow";
import { editText } from "../../textEntry";
import { $t, $tn } from "../../translate";
import { sayWhileFocused } from "../../voiceGuide";

// The Movies and Series pages' grid of posters (PLAN.md, Phase 6, step 4),
// under a line that picks what shows: Continue watching, everything, the
// search results, or a category. As in the guide, Up from the first row
// reaches the line, where Left and Right change it and OK searches by name.
// The grid draws three rows and fills them as it scrolls, so 2,000 films
// cost the same as 18. Left from the first column goes to the menu.

const PAGE_WIDTH = 1920 - MENU_WIDTH;
const LEFT = 60;
export const COLUMNS = 6;
const POSTER_WIDTH = 210;
const POSTER_HEIGHT = 315;
const GAP = (PAGE_WIDTH - 2 * LEFT - COLUMNS * POSTER_WIDTH) / (COLUMNS - 1);
const ROW_HEIGHT = POSTER_HEIGHT + 78;
const HEADER_Y = 110;
const HEADER_HEIGHT = 50;
const GRID_Y = 190;
/** Rows kept in view while scrolling; one more is drawn, cut off at the bottom. */
const ROWS = 2;
const SLOTS = Array.from({ length: (ROWS + 1) * COLUMNS }, (_, slot) => slot);
const CONTINUE = "continue";
const ALL = "all";
const SEARCH = "search";

export interface GridItem {
  key: string;
  name: string;
  poster?: string;
  category?: string;
  /** How far it was watched, from 0 to 1, for a bar under the poster. */
  progress?: number;
}

interface Filter<T> {
  id: string;
  label: string;
  items: T[];
}

/** Where a grid was, to come back to after watching. */
export interface GridPlace {
  filterId: string;
  query: string;
  cursor: number;
}

export interface PosterGridProps<T extends GridItem> {
  title: string;
  allLabel: string;
  items: T[];
  /** Continue watching, newest first. */
  continueItems: T[];
  categories: string[];
  loading: boolean;
  /** Says there's nothing, and how to get something. */
  emptyText: string;
  onOpen: (item: T) => void;
  /** Where the grid starts; it reports each change, so the page can keep it. */
  place?: GridPlace;
  onPlace?: (place: GridPlace) => void;
  /** Set while a page drawn over it (the details) has the keys. */
  covered?: boolean;
  ref?: (element: ElementNode) => void;
  probeName: string;
}

const matches = (name: string, words: string[]) => {
  const folded = fold(name);
  return words.every(word => folded.includes(word));
};

export const PosterGrid = <T extends GridItem>(props: PosterGridProps<T>) => {
  const [focused, setFocused] = createSignal(false);
  const [query, setQuery] = createSignal(props.place?.query ?? "");
  const results = createMemo(() => {
    const words = fold(query()).split(/\s+/).filter(Boolean);
    return words.length === 0 ? [] : props.items.filter(item => matches(item.name, words));
  });
  const filters = createMemo((): Filter<T>[] => [
    ...(props.continueItems.length > 0
      ? [{ id: CONTINUE, label: $t("vod.continue"), items: props.continueItems }]
      : []),
    { id: ALL, label: props.allLabel, items: props.items },
    ...(query()
      ? [{ id: SEARCH, label: $t("guide.searchResults", { query: query() }), items: results() }]
      : []),
    ...props.categories.map(name => ({
      id: `category:${name}`,
      label: name,
      items: props.items.filter(item => item.category === name),
    })),
  ]);
  const [filterId, setFilterId] = createSignal(props.place?.filterId ?? CONTINUE);
  const filter = createMemo(() => filters().find(one => one.id === filterId()) ?? filters()[0]);
  const items = () => filter().items;
  const [area, setArea] = createSignal<"filters" | "grid">("grid");
  const [cursor, setCursor] = createSignal(props.place?.cursor ?? 0);
  const [top, setTop] = createSignal(0);
  const rowCount = () => Math.ceil(items().length / COLUMNS);

  const place = (index: number) => {
    const at = Math.max(0, Math.min(index, items().length - 1));
    batch(() => {
      setCursor(at);
      setTop(scrollTop(Math.floor(at / COLUMNS), top(), ROWS, rowCount()));
    });
  };
  // Back in range when the items change, such as a new category.
  createEffect(on(items, () => place(cursor()), { defer: false }));
  createEffect(() => props.onPlace?.({ filterId: filter().id, query: query(), cursor: cursor() }));

  const changeFilter = (step: number) => {
    const all = filters();
    const at = Math.max(
      0,
      all.findIndex(one => one.id === filter().id),
    );
    batch(() => {
      setFilterId(all[wrapIndex(at, step, all.length)].id);
      setCursor(0);
      setTop(0);
    });
  };
  let root: ElementNode | undefined;
  const search = () =>
    editText({
      rect: { x: MENU_WIDTH + LEFT, y: HEADER_Y - 4, width: 760, height: HEADER_HEIGHT + 8 },
      value: query(),
      fontSize: 30,
      onDone: value => {
        const typed = value.trim();
        batch(() => {
          setQuery(typed);
          if (typed) setFilterId(SEARCH);
          else if (filterId() === SEARCH) setFilterId(ALL);
          setCursor(0);
          setTop(0);
        });
        if (typed && results().length > 0) setArea("grid");
        root?.setFocus();
      },
    });

  exposeToProbes(props.probeName, { filters, filter, cursor, top, area, items, setFilterId, place });

  // What the voice guide reads: the filter, then the title under the cursor.
  sayWhileFocused(
    () => focused() && !props.covered,
    () => {
      const item = items()[cursor()];
      if (!item) {
        const why = props.loading
          ? $t("live.loading")
          : filter().id === SEARCH
            ? $t("vod.noMatches", { query: query() })
            : props.emptyText;
        return [filter().label, why];
      }
      if (area() === "filters") return [filter().label, $tn("count.titles", items().length)];
      return [
        filter().label,
        item.name,
        item.progress ? $t("vod.watchedPart", { percent: Math.round(item.progress * 100) }) : undefined,
      ];
    },
  );

  const slotItem = (slot: number) => items()[top() * COLUMNS + slot];
  const empty = () => items().length === 0;

  return (
    <View
      ref={element => {
        root = element;
        props.ref?.(element);
      }}
      width={PAGE_WIDTH}
      height={1080}
      // Read by sayWhileFocused above, not as the page's whole text.
      announce=""
      onFocusChanged={setFocused}
      onUp={() => {
        if (area() === "filters") return true;
        if (cursor() < COLUMNS || empty()) setArea("filters");
        else place(cursor() - COLUMNS);
        return true;
      }}
      onDown={() => {
        if (area() === "filters") {
          if (!empty()) setArea("grid");
        } else if (Math.floor(cursor() / COLUMNS) < rowCount() - 1) {
          place(cursor() + COLUMNS);
        }
        return true;
      }}
      onLeft={() => {
        if (area() === "filters") {
          changeFilter(-1);
          return true;
        }
        if (cursor() % COLUMNS === 0) return false;
        place(cursor() - 1);
        return true;
      }}
      onRight={() => {
        if (area() === "filters") changeFilter(1);
        else if (cursor() % COLUMNS < COLUMNS - 1) place(cursor() + 1);
        return true;
      }}
      onChannelUp={() => {
        setArea("grid");
        place(cursor() - ROWS * COLUMNS);
        return true;
      }}
      onChannelDown={() => {
        setArea("grid");
        place(cursor() + ROWS * COLUMNS);
        return true;
      }}
      onEnter={() => {
        if (area() === "filters") search();
        else {
          const item = items()[cursor()];
          if (item) props.onOpen(item);
        }
        return true;
      }}
      onBack={() => {
        if (area() === "grid" || empty()) return false;
        setArea("grid");
        return true;
      }}
    >
      <Text x={LEFT} y={30} fontSize={56}>
        {props.title}
      </Text>
      <View
        x={LEFT}
        y={HEADER_Y}
        width={PAGE_WIDTH - 2 * LEFT}
        height={HEADER_HEIGHT}
        borderRadius={10}
        color={focused() && area() === "filters" ? "#2e6bd6ff" : "#ffffff0f"}
      >
        <Text
          x={20}
          width={900}
          height={HEADER_HEIGHT}
          lineHeight={HEADER_HEIGHT}
          maxLines={1}
          contain="width"
          fontSize={28}
        >
          {`‹  ${filter().label}  ›`}
        </Text>
        <Text
          x={PAGE_WIDTH - 2 * LEFT - 20}
          mountX={1}
          height={HEADER_HEIGHT}
          lineHeight={HEADER_HEIGHT}
          fontSize={24}
          color="#ffffffb3"
        >
          {focused() && area() === "filters"
            ? $t("vod.filterHint")
            : $t("vod.count", { count: items().length })}
        </Text>
      </View>
      <Show when={!empty()}>
        <View y={GRID_Y} width={PAGE_WIDTH} height={1080 - GRID_Y} clipping>
          <For each={SLOTS}>
            {slot => (
              <Show when={slotItem(slot)}>
                {item => {
                  const at = () => top() * COLUMNS + slot;
                  const selected = () =>
                    focused() && !props.covered && area() === "grid" && at() === cursor();
                  return (
                    <View
                      x={LEFT + (slot % COLUMNS) * (POSTER_WIDTH + GAP)}
                      y={Math.floor(slot / COLUMNS) * ROW_HEIGHT + 10}
                      width={POSTER_WIDTH}
                      height={ROW_HEIGHT}
                    >
                      <View
                        x={-6}
                        y={-6}
                        width={POSTER_WIDTH + 12}
                        height={POSTER_HEIGHT + 12}
                        borderRadius={12}
                        color={selected() ? "#2e6bd6ff" : "#00000000"}
                      />
                      <View width={POSTER_WIDTH} height={POSTER_HEIGHT} borderRadius={8} color="#1d2b3dff">
                        <Text
                          x={14}
                          y={20}
                          width={POSTER_WIDTH - 28}
                          maxLines={4}
                          contain="width"
                          fontSize={28}
                          color="#ffffffb3"
                        >
                          {item().name}
                        </Text>
                      </View>
                      <Show when={item().poster}>
                        {poster => (
                          <View width={POSTER_WIDTH} height={POSTER_HEIGHT} borderRadius={8} src={poster()} />
                        )}
                      </Show>
                      <Show when={item().progress}>
                        {progress => (
                          <>
                            <View
                              x={10}
                              y={POSTER_HEIGHT - 14}
                              width={POSTER_WIDTH - 20}
                              height={6}
                              borderRadius={3}
                              color="#00000099"
                            />
                            <View
                              x={10}
                              y={POSTER_HEIGHT - 14}
                              width={(POSTER_WIDTH - 20) * progress()}
                              height={6}
                              borderRadius={3}
                              color="#7fb2ffff"
                            />
                          </>
                        )}
                      </Show>
                      <Text
                        y={POSTER_HEIGHT + 14}
                        width={POSTER_WIDTH}
                        maxLines={2}
                        contain="width"
                        lineHeight={30}
                        fontSize={24}
                        color={selected() ? "#ffffffff" : "#ffffffb3"}
                      >
                        {item().name}
                      </Text>
                    </View>
                  );
                }}
              </Show>
            )}
          </For>
        </View>
      </Show>
      <Show when={empty()}>
        <Text
          x={LEFT}
          y={GRID_Y + 20}
          width={PAGE_WIDTH - 2 * LEFT}
          contain="width"
          fontSize={32}
          color="#ffffffb3"
        >
          {props.loading
            ? $t("live.loading")
            : filter().id === SEARCH
              ? $t("vod.noMatches", { query: query() })
              : props.emptyText}
        </Text>
      </Show>
    </View>
  );
};
