import { type ElementNode, Text, View } from "@solidtv/solid";
import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Artwork } from "../../components/Artwork";
import { Backdrop } from "../../components/Backdrop";
import { Glow } from "../../components/Glow";
import { MENU_WIDTH } from "../../components/SideMenu";
import { exposeToProbes } from "../../devHooks";
import { markEmpty } from "../../emptySection";
import { fold } from "../../guide/search";
import { scrollTop } from "../../live/listWindow";
import { editText } from "../../textEntry";
import { BOLD, colors, focusShadow, motion, radius, RING } from "../../theme";
import { $t } from "../../translate";
import { sayWhileFocused } from "../../voiceGuide";
import { Facts } from "./FilmPanel";

// The Movies and Series pages (PLAN.md, Phase 6, step 4): the title under
// the cursor large at the top, over its backdrop, and rows of posters under
// it: Continue watching, search results, each category, then everything.
// Up and Down move between rows, Left and Right along one, and each row
// keeps its place. Up from the first row reaches Search. Only the rows and
// posters near the cursor are drawn, so 2,000 films cost the same as 20.
// Left from a row's first poster goes to the menu.

const PAGE_WIDTH = 1920 - MENU_WIDTH;
const LEFT = 64;
const HERO_HEIGHT = 760;
const TEXT_WIDTH = 1000;

const SEARCH_Y = 36;
const SEARCH_HEIGHT = 56;
const SEARCH_WIDTH = 360;
const SEARCH_X = PAGE_WIDTH - LEFT - SEARCH_WIDTH;

/** Where the row with the cursor sits; rows below it peek in under it. */
const ROWS_TOP = 560;
/** Room above it for a focused poster, grown and glowing. */
const ROWS_MARGIN = 36;
const LABEL_HEIGHT = 56;
const POSTER_WIDTH = 182;
const POSTER_HEIGHT = 273;
const POSTER_GAP = 26;
const STEP = POSTER_WIDTH + POSTER_GAP;
const ROW_HEIGHT = LABEL_HEIGHT + POSTER_HEIGHT + 46;
/** Posters kept in view while moving along a row; one more peeks in. */
const VISIBLE = 8;
const FOCUS_SCALE = 1.06;
/** How long the cursor rests on a title before its details are asked for. */
const DETAILS_DELAY_MS = 450;

const CONTINUE = "continue";
const ALL = "all";
const SEARCH = "search";

export interface HubItem {
  key: string;
  name: string;
  poster?: string;
  category?: string;
  rating?: number;
  year?: number;
  /** How far it was watched, from 0 to 1, for a bar on the poster. */
  progress?: number;
}

/** What the top of the page shows about a title, from its details. */
export interface HeroInfo {
  backdrop?: string;
  plot?: string;
  /** Such as the genre and length, after the year. */
  facts?: string[];
}

interface Row<T> {
  id: string;
  label: string;
  items: T[];
}

interface RowPlace {
  /** The poster with the cursor. */
  at: number;
  /** The first poster drawn in full. */
  first: number;
}

/** Where the page was, to come back to after watching. */
export interface HubPlace {
  rowId: string;
  query: string;
  rows: Record<string, RowPlace>;
}

export interface VodHubProps<T extends HubItem> {
  title: string;
  allLabel: string;
  items: T[];
  /** Continue watching, newest first. */
  continueItems: T[];
  categories: string[];
  loading: boolean;
  /** Says there's nothing, and how to get something. */
  emptyText: string;
  /** A title's details for the top of the page; asked for once the cursor rests on it. */
  details: (item: T) => Promise<HeroInfo>;
  onOpen: (item: T) => void;
  place?: HubPlace;
  onPlace?: (place: HubPlace) => void;
  /** Set while a page drawn over it (the details) has the keys. */
  covered?: boolean;
  ref?: (element: ElementNode) => void;
  probeName: string;
}

const matches = (name: string, words: string[]) => {
  const folded = fold(name);
  return words.every(word => folded.includes(word));
};

const START: RowPlace = { at: 0, first: 0 };

export const VodHub = <T extends HubItem>(props: VodHubProps<T>) => {
  const [focused, setFocused] = createSignal(false);
  const [query, setQuery] = createSignal(props.place?.query ?? "");
  const results = createMemo(() => {
    const words = fold(query()).split(/\s+/).filter(Boolean);
    return words.length === 0 ? [] : props.items.filter(item => matches(item.name, words));
  });
  const rows = createMemo((): Row<T>[] => {
    const byCategory = new Map<string, T[]>();
    for (const item of props.items) {
      if (!item.category) continue;
      let list = byCategory.get(item.category);
      if (!list) byCategory.set(item.category, (list = []));
      list.push(item);
    }
    return [
      ...(query()
        ? [{ id: SEARCH, label: $t("guide.searchResults", { query: query() }), items: results() }]
        : []),
      ...(props.continueItems.length > 0
        ? [{ id: CONTINUE, label: $t("vod.continue"), items: props.continueItems }]
        : []),
      ...props.categories
        .filter(name => byCategory.has(name))
        .map(name => ({ id: `category:${name}`, label: name, items: byCategory.get(name) ?? [] })),
      ...(props.items.length > 0 ? [{ id: ALL, label: props.allLabel, items: props.items }] : []),
    ];
  });

  const [rowId, setRowId] = createSignal(props.place?.rowId ?? CONTINUE);
  const rowIndex = createMemo(() =>
    Math.max(
      0,
      rows().findIndex(row => row.id === rowId()),
    ),
  );
  const row = () => rows()[rowIndex()];
  /** The row with the cursor: the one asked for, or the first if it's gone. */
  const currentId = () => row()?.id;
  const [places, setPlaces] = createSignal<Record<string, RowPlace>>(props.place?.rows ?? {});
  const placeOf = (id: string) => places()[id] ?? START;
  const [area, setArea] = createSignal<"rows" | "search">("rows");

  /** Puts a row's cursor on `index`, scrolling the row as little as it can. */
  const placeIn = (target: Row<T>, index: number) => {
    const count = target.items.length;
    const at = Math.max(0, Math.min(index, count - 1));
    const first = scrollTop(at, placeOf(target.id).first, VISIBLE, count);
    setPlaces(all => ({ ...all, [target.id]: { at, first } }));
  };
  const moveRow = (step: number) => {
    const next = rows()[rowIndex() + step];
    if (next) setRowId(next.id);
  };
  // A row whose items changed keeps its cursor in range.
  createEffect(
    on(rows, list => {
      for (const one of list) if (placeOf(one.id).at >= one.items.length) placeIn(one, one.items.length - 1);
    }),
  );
  createEffect(() => props.onPlace?.({ rowId: currentId() ?? rowId(), query: query(), rows: places() }));

  const empty = () => props.items.length === 0 && props.continueItems.length === 0;
  // With no titles at all (or while they load) the menu keeps the keys.
  markEmpty(empty);

  /** The title under the cursor, which the top of the page shows. */
  const current = createMemo((): T | undefined => {
    const one = row();
    return one?.items[placeOf(one.id).at];
  });
  // The last title the cursor was on, kept while Search has it.
  const [shown, setShown] = createSignal<T>();
  createEffect(() => {
    const item = current();
    if (item) setShown(() => item);
  });
  const [info, setInfo] = createSignal<{ key: string; info: HeroInfo }>();
  let detailsTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(shown, item => {
      clearTimeout(detailsTimer);
      if (!item) return;
      detailsTimer = setTimeout(() => {
        props
          .details(item)
          // Only if the cursor is still on it.
          .then(found =>
            setInfo(before => (shown()?.key === item.key ? { key: item.key, info: found } : before)),
          )
          .catch(() => undefined);
      }, DETAILS_DELAY_MS);
    }),
  );
  onCleanup(() => clearTimeout(detailsTimer));
  const hero = () => {
    const found = info();
    return found && found.key === shown()?.key ? found.info : undefined;
  };
  const facts = () => {
    const item = shown();
    if (!item) return "";
    return [item.year, ...(hero()?.facts ?? [item.category])].filter(Boolean).join("   ·   ");
  };

  let root: ElementNode | undefined;
  const search = () =>
    editText({
      rect: { x: MENU_WIDTH + SEARCH_X, y: SEARCH_Y, width: SEARCH_WIDTH, height: SEARCH_HEIGHT },
      value: query(),
      fontSize: 28,
      onDone: value => {
        const typed = value.trim();
        batch(() => {
          setQuery(typed);
          if (typed) {
            setPlaces(all => ({ ...all, [SEARCH]: START }));
            setRowId(SEARCH);
            setArea("rows");
          } else if (rowId() === SEARCH) setRowId(CONTINUE);
        });
        root?.setFocus();
      },
    });

  exposeToProbes(props.probeName, {
    rows,
    rowId: currentId,
    area,
    current,
    filters: rows,
    /** The row with the cursor, as the old grid's filter. */
    setFilterId: (id: string) =>
      batch(() => {
        setRowId(id);
        setArea("rows");
      }),
    items: () => row()?.items ?? [],
    cursor: () => (row() ? placeOf(row().id).at : 0),
    place: (index: number) => {
      const one = row();
      if (one) placeIn(one, index);
    },
  });

  // What the voice guide reads: the row, then the title under the cursor.
  sayWhileFocused(
    () => focused() && !props.covered,
    () => {
      if (area() === "search") return [$t("vod.search"), query()];
      const item = current();
      if (!item) {
        const why = props.loading
          ? $t("vod.loading")
          : currentId() === SEARCH
            ? $t("vod.noMatches", { query: query() })
            : props.emptyText;
        return [row()?.label, why];
      }
      return [
        row()?.label,
        item.name,
        item.progress ? $t("vod.watchedPart", { percent: Math.round(item.progress * 100) }) : undefined,
      ];
    },
  );

  // The rows drawn: the one with the cursor, the two below, and the one
  // above, hidden, so it slides in when the cursor moves up.
  const drawnRows = () => rows().slice(Math.max(0, rowIndex() - 1), rowIndex() + 3);
  const rowY = (target: Row<T>) => rows().indexOf(target) * ROW_HEIGHT;
  const searchFocused = () => focused() && !props.covered && area() === "search";

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
        if (area() === "search") return true;
        if (rowIndex() === 0) setArea("search");
        else moveRow(-1);
        return true;
      }}
      onDown={() => {
        if (area() === "search") {
          if (rows().length > 0) setArea("rows");
        } else moveRow(1);
        return true;
      }}
      onLeft={() => {
        const one = row();
        if (area() === "search" || !one || placeOf(one.id).at === 0) return false;
        placeIn(one, placeOf(one.id).at - 1);
        return true;
      }}
      onRight={() => {
        const one = row();
        if (area() === "rows" && one) placeIn(one, placeOf(one.id).at + 1);
        return true;
      }}
      onChannelUp={() => {
        setArea("rows");
        moveRow(-1);
        return true;
      }}
      onChannelDown={() => {
        setArea("rows");
        moveRow(1);
        return true;
      }}
      onEnter={() => {
        if (area() === "search") search();
        else {
          const item = current();
          if (item) props.onOpen(item);
        }
        return true;
      }}
      onBack={() => {
        if (area() === "search") {
          setArea("rows");
          return true;
        }
        // Back from further down goes to the first row; from there, to the menu.
        if (rowIndex() > 0) {
          setRowId(rows()[0].id);
          return true;
        }
        return false;
      }}
    >
      <Backdrop width={PAGE_WIDTH} height={HERO_HEIGHT} src={hero()?.backdrop} />

      <Text
        x={LEFT}
        y={SEARCH_Y + 12}
        fontSize={26}
        fontFamily={BOLD}
        letterSpacing={3}
        color={colors.accentText}
      >
        {props.title.toUpperCase()}
      </Text>
      <Glow
        x={SEARCH_X}
        y={SEARCH_Y}
        width={SEARCH_WIDTH}
        height={SEARCH_HEIGHT}
        borderRadius={SEARCH_HEIGHT / 2}
        shown={searchFocused()}
      />
      <View
        x={SEARCH_X}
        y={SEARCH_Y}
        width={SEARCH_WIDTH}
        height={SEARCH_HEIGHT}
        borderRadius={SEARCH_HEIGHT / 2}
        color={searchFocused() ? colors.focus : colors.surfaceRaised}
        transition={{ color: motion.quick }}
      >
        <View
          x={22}
          y={(SEARCH_HEIGHT - 26) / 2}
          width={26}
          height={26}
          src="assets/icons/search.png"
          color={searchFocused() ? colors.onFocus : colors.textDim}
        />
        <Text
          x={62}
          width={SEARCH_WIDTH - 84}
          height={SEARCH_HEIGHT}
          lineHeight={SEARCH_HEIGHT}
          maxLines={1}
          contain="width"
          fontSize={26}
          fontFamily={searchFocused() ? BOLD : undefined}
          color={searchFocused() ? colors.onFocus : query() ? colors.text : colors.textDim}
        >
          {query() || $t("vod.search")}
        </Text>
      </View>

      <Show
        when={!empty()}
        fallback={
          <>
            <Text x={LEFT} y={186} fontSize={56} fontFamily={BOLD}>
              {props.loading ? $t("vod.loading") : props.title}
            </Text>
            <Text x={LEFT} y={276} width={TEXT_WIDTH} contain="width" fontSize={30} color={colors.textDim}>
              {props.loading ? "" : props.emptyText}
            </Text>
          </>
        }
      >
        <Show when={shown()}>
          {item => (
            <View x={LEFT} y={150} width={TEXT_WIDTH} display="flex" flexDirection="column" gap={16}>
              <Text
                width={TEXT_WIDTH}
                maxLines={1}
                contain="width"
                fontSize={22}
                fontFamily={BOLD}
                letterSpacing={2}
                color={colors.gold}
              >
                {(item().category ?? "").toUpperCase()}
              </Text>
              <Text
                width={TEXT_WIDTH}
                maxLines={1}
                contain="width"
                lineHeight={76}
                fontSize={64}
                fontFamily={BOLD}
              >
                {item().name}
              </Text>
              <Facts rating={item().rating} text={facts()} width={TEXT_WIDTH} />
              <Text
                width={TEXT_WIDTH - 80}
                maxLines={3}
                contain="width"
                lineHeight={40}
                fontSize={28}
                color={colors.textDim}
                marginTop={6}
              >
                {hero()?.plot ?? ""}
              </Text>
            </View>
          )}
        </Show>

        <View y={ROWS_TOP - ROWS_MARGIN} width={PAGE_WIDTH} height={1080 - ROWS_TOP + ROWS_MARGIN} clipping>
          {/* The strips slide, so each is as big as what it holds: the renderer skips the
              children of a node it finds off screen (three rows down, with no size). */}
          <View
            y={ROWS_MARGIN - rowIndex() * ROW_HEIGHT}
            width={PAGE_WIDTH}
            height={rows().length * ROW_HEIGHT}
            transition={{ y: motion.normal }}
          >
            <For each={drawnRows()}>
              {target => {
                const place = () => placeOf(target.id);
                const isCurrent = () => target.id === currentId();
                const drawn = () => {
                  const from = Math.max(0, place().first - 1);
                  const to = Math.min(target.items.length, place().first + VISIBLE + 1);
                  return Array.from({ length: Math.max(0, to - from) }, (_, at) => from + at);
                };
                return (
                  <View y={rowY(target)} width={PAGE_WIDTH} height={ROW_HEIGHT}>
                    <Text
                      x={LEFT}
                      height={LABEL_HEIGHT - 14}
                      lineHeight={LABEL_HEIGHT - 14}
                      maxLines={1}
                      width={1200}
                      contain="width"
                      fontSize={30}
                      fontFamily={BOLD}
                      color={isCurrent() ? colors.text : colors.textDim}
                    >
                      {target.label}
                    </Text>
                    <Show when={target.items.length === 0}>
                      <Text x={LEFT} y={LABEL_HEIGHT + 20} fontSize={28} color={colors.textDim}>
                        {$t("vod.noMatches", { query: query() })}
                      </Text>
                    </Show>
                    <View
                      x={LEFT - place().first * STEP}
                      y={LABEL_HEIGHT}
                      width={target.items.length * STEP}
                      height={POSTER_HEIGHT}
                      transition={{ x: motion.normal }}
                    >
                      <For each={drawn()}>
                        {index => {
                          const item = () => target.items[index];
                          const selected = () =>
                            focused() &&
                            !props.covered &&
                            area() === "rows" &&
                            isCurrent() &&
                            place().at === index;
                          return (
                            <Show when={item()}>
                              {one => (
                                <View
                                  x={index * STEP}
                                  width={POSTER_WIDTH}
                                  height={POSTER_HEIGHT}
                                  scale={selected() ? FOCUS_SCALE : 1}
                                  transition={{ scale: motion.normal }}
                                >
                                  <View
                                    x={-RING}
                                    y={-RING}
                                    width={POSTER_WIDTH + 2 * RING}
                                    height={POSTER_HEIGHT + 2 * RING}
                                    borderRadius={radius.medium + RING}
                                    color={colors.focus}
                                    shadow={focusShadow}
                                    alpha={selected() ? 1 : 0}
                                  />
                                  <Artwork
                                    width={POSTER_WIDTH}
                                    height={POSTER_HEIGHT}
                                    src={one().poster}
                                    title={one().name}
                                    fontSize={24}
                                  />
                                  <Show when={one().progress}>
                                    {progress => (
                                      <>
                                        <View
                                          x={12}
                                          y={POSTER_HEIGHT - 18}
                                          width={POSTER_WIDTH - 24}
                                          height={6}
                                          borderRadius={3}
                                          color={colors.caption}
                                        />
                                        <View
                                          x={12}
                                          y={POSTER_HEIGHT - 18}
                                          width={(POSTER_WIDTH - 24) * progress()}
                                          height={6}
                                          borderRadius={3}
                                          color={colors.accent}
                                        />
                                      </>
                                    )}
                                  </Show>
                                </View>
                              )}
                            </Show>
                          );
                        }}
                      </For>
                    </View>
                  </View>
                );
              }}
            </For>
          </View>
        </View>
      </Show>
    </View>
  );
};
