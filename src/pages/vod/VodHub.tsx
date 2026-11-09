import { type ElementNode, Text, View } from "@solidtv/solid";
import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Artwork } from "../../components/Artwork";
import { Backdrop } from "../../components/Backdrop";
import { MENU_OPEN_WIDTH, MENU_WIDTH, menuOpen } from "../../components/SideMenu";
import { exposeToProbes } from "../../devHooks";
import { markEmpty } from "../../emptySection";
import { createRestingCursor } from "../../restingCursor";
import { fold } from "../../guide/search";
import { scrollTop } from "../../live/listWindow";
import { editText } from "../../textEntry";
import { BOLD, colors, focusShadow, motion, radius, RING } from "../../theme";
import { $t, $tn } from "../../translate";
import { sayWhileFocused } from "../../voiceGuide";
import { useWholeScreen } from "../../wholeScreen";
import { GROUP_ROWS, GroupColumn, GROUPS_WIDTH, SEARCH_RECT } from "../guide/GroupColumn";
import { Facts } from "./FilmPanel";

// The Movies and Series pages (PLAN.md, Phase 6, step 4), laid out as Live
// TV is: the menu, a column of groups (a search field, Continue watching,
// everything, then each category), and right of them the title under the
// cursor large at the top, over its backdrop, with the group's posters in a
// grid under it. Up and Down in the column change the group shown; Right or
// OK goes into the posters, and the page then fills the screen. Left from a
// row's first poster, or Back, shows the menu and the column again, moving
// the page right of them. Only the grid's rows near the cursor are drawn, so
// 2,000 films cost the same as 20.

const PAGE_WIDTH = 1920;
const LEFT = 64;
const HERO_HEIGHT = 760;
const TEXT_WIDTH = 1000;

/** Where the group's name is, over the row of posters with the cursor. */
const LABEL_Y = 560;
const LABEL_HEIGHT = 56;
/** Where the row of posters with the cursor sits; the row below peeks in under it. */
const GRID_Y = LABEL_Y + LABEL_HEIGHT;
/** Room above it for a focused poster, grown and glowing. */
const GRID_MARGIN = 36;
const POSTER_WIDTH = 182;
const POSTER_HEIGHT = 273;
const POSTER_GAP = 26;
const STEP = POSTER_WIDTH + POSTER_GAP;
const ROW_HEIGHT = POSTER_HEIGHT + 44;
/** Posters in a row: as many as fit across the screen. */
const COLUMNS = Math.floor((PAGE_WIDTH - 2 * LEFT + POSTER_GAP) / STEP);
/** Rows a Channel key moves. */
const PAGE_ROWS = 3;
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

interface Group<T> {
  id: string;
  label: string;
  items: T[];
}

/** Where the page was, to come back to after watching. */
export interface HubPlace {
  groupId: string;
  query: string;
  /** The poster with the cursor in each group. */
  at: Record<string, number>;
}

export interface VodHubProps<T extends HubItem> {
  title: string;
  allLabel: string;
  /** What the search field says while it's empty. */
  searchLabel: string;
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
  /** Whether the posters have the keys at first, as when coming back from watching. */
  startInGrid?: boolean;
  /** Set while a page drawn over it (the details) has the keys. */
  covered?: boolean;
  ref?: (element: ElementNode) => void;
  probeName: string;
}

const matches = (name: string, words: string[]) => {
  const folded = fold(name);
  return words.every(word => folded.includes(word));
};

/** Where the column is: beside the menu, moving right as it opens. */
const groupsX = () => (menuOpen() ? MENU_OPEN_WIDTH : MENU_WIDTH);

export const VodHub = <T extends HubItem>(props: VodHubProps<T>) => {
  const [focused, setFocused] = createSignal(false);
  const [query, setQuery] = createSignal(props.place?.query ?? "");
  const results = createMemo(() => {
    const words = fold(query()).split(/\s+/).filter(Boolean);
    return words.length === 0 ? [] : props.items.filter(item => matches(item.name, words));
  });
  const groups = createMemo((): Group<T>[] => {
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
      ...(props.items.length > 0 ? [{ id: ALL, label: props.allLabel, items: props.items }] : []),
      ...props.categories
        .filter(name => byCategory.has(name))
        .map(name => ({ id: `category:${name}`, label: name, items: byCategory.get(name) ?? [] })),
    ];
  });

  const [groupId, setGroupId] = createSignal(props.place?.groupId ?? CONTINUE);
  const groupIndex = createMemo(() =>
    Math.max(
      0,
      groups().findIndex(one => one.id === groupId()),
    ),
  );
  const group = () => groups()[groupIndex()];
  /** The group shown: the one asked for, or the first if it's gone. */
  const currentId = () => group()?.id;
  const items = () => group()?.items ?? [];
  const [places, setPlaces] = createSignal<Record<string, number>>(props.place?.at ?? {});
  const placeOf = (id: string) => places()[id] ?? 0;
  const at = () => (group() ? placeOf(group().id) : 0);
  const placeAt = (index: number) => {
    const one = group();
    if (!one) return;
    const place = Math.max(0, Math.min(index, one.items.length - 1));
    setPlaces(all => ({ ...all, [one.id]: place }));
  };
  // A group whose items changed keeps its cursor in range.
  createEffect(
    on(groups, list => {
      for (const one of list) {
        if (placeOf(one.id) >= one.items.length)
          setPlaces(all => ({ ...all, [one.id]: Math.max(0, one.items.length - 1) }));
      }
    }),
  );
  createEffect(() => props.onPlace?.({ groupId: currentId() ?? groupId(), query: query(), at: places() }));

  // "groups" is the column, with the cursor on the group shown or on the
  // search field above the groups. Opened from the menu, Right reaches the
  // column first.
  const [area, setArea] = createSignal<"grid" | "groups">(props.startInGrid ? "grid" : "groups");
  const [onSearch, setOnSearch] = createSignal(false);
  // The column's cursor: the posters show the group it's on once it rests
  // there (`CURSOR_REST_MS`), or at once on Right or OK.
  const groupCursor = createRestingCursor(
    () => currentId() ?? groupId(),
    id => setGroupId(id),
  );
  const cursorIndex = createMemo(() => {
    const index = groups().findIndex(one => one.id === groupCursor.at());
    return index >= 0 ? index : groupIndex();
  });
  const cursorGroup = () => groups()[cursorIndex()];
  const [groupTop, setGroupTop] = createSignal(0);
  createEffect(() => {
    const index = cursorIndex();
    setGroupTop(first => scrollTop(index, first, GROUP_ROWS, groups().length));
  });
  const toGroups = () => {
    batch(() => {
      setOnSearch(false);
      setArea("groups");
    });
    return true;
  };
  /** Into the posters, if the group has any. */
  const toGrid = () => {
    groupCursor.settle();
    if (items().length === 0) return false;
    setArea("grid");
    return true;
  };
  /** Moves the column's cursor by `step`, from the search field (-1) to the last group. */
  const moveGroup = (step: number) => {
    const all = groups();
    const index = Math.max(-1, Math.min(all.length - 1, (onSearch() ? -1 : cursorIndex()) + step));
    batch(() => {
      setOnSearch(index < 0);
      if (index >= 0) groupCursor.move(all[index].id);
    });
  };

  const empty = () => props.items.length === 0 && props.continueItems.length === 0;
  // With no titles at all (or while they load) the menu keeps the keys.
  markEmpty(empty);
  // The menu and the column show unless you're moving through the posters;
  // with nothing to show, or a page over it, it lays out as other pages do.
  const inGrid = () => focused() && area() === "grid";
  const wide = () => !empty() && !props.covered;
  // Leaving the column, such as for the menu, shows the group the cursor is on.
  createEffect(
    on(
      () => focused() && area() === "groups",
      inColumn => {
        if (!inColumn) groupCursor.settle();
      },
      { defer: true },
    ),
  );
  useWholeScreen(inGrid, wide);
  // Otherwise the page moves right of them.
  const pageX = () => (wide() && !inGrid() ? groupsX() + GROUPS_WIDTH : 0);

  /** The title under the cursor, which the top of the page shows. */
  const current = createMemo((): T | undefined => items()[at()]);
  // The last title the cursor was on, kept while a group with none is shown.
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
      rect: { ...SEARCH_RECT, x: MENU_WIDTH + SEARCH_RECT.x, width: 640 },
      value: query(),
      fontSize: 30,
      onDone: value => {
        const typed = value.trim();
        batch(() => {
          setQuery(typed);
          if (typed) {
            setPlaces(all => ({ ...all, [SEARCH]: 0 }));
            setGroupId(SEARCH);
            setOnSearch(false);
          } else if (groupId() === SEARCH) setGroupId(CONTINUE);
        });
        if (typed && results().length > 0) setArea("grid");
        root?.setFocus();
      },
    });

  exposeToProbes(props.probeName, {
    rows: groups,
    rowId: currentId,
    groupAt: groupCursor.at,
    area,
    onSearch,
    current,
    filters: groups,
    /** Shows a group, with the posters having the keys. */
    setFilterId: (id: string) =>
      batch(() => {
        setGroupId(id);
        setArea("grid");
      }),
    items,
    cursor: at,
    place: placeAt,
  });

  // What the voice guide reads: the group, then the title under the cursor.
  sayWhileFocused(
    () => focused() && !props.covered,
    () => {
      if (area() === "groups")
        return onSearch()
          ? [props.searchLabel, query()]
          : [cursorGroup()?.label, $tn("count.titles", cursorGroup()?.items.length ?? 0)];
      const item = current();
      if (!item) {
        const why = props.loading
          ? $t("vod.loading")
          : currentId() === SEARCH
            ? $t("vod.noMatches", { query: query() })
            : props.emptyText;
        return [group()?.label, why];
      }
      return [
        group()?.label,
        item.name,
        item.progress ? $t("vod.watchedPart", { percent: Math.round(item.progress * 100) }) : undefined,
      ];
    },
  );

  const gridRow = () => Math.floor(at() / COLUMNS);
  const rowCount = () => Math.ceil(items().length / COLUMNS);
  /** Moves the cursor `rows` rows up or down, onto the last poster if the row is short. */
  const moveRows = (rows: number) => {
    const row = Math.max(0, Math.min(gridRow() + rows, rowCount() - 1));
    if (row !== gridRow()) placeAt(row * COLUMNS + (at() % COLUMNS));
  };
  // The rows drawn: the one with the cursor, the two below, and the one
  // above, hidden, so it slides in when the cursor moves up.
  const drawnRows = () => {
    const from = Math.max(0, gridRow() - 1);
    const to = Math.min(rowCount(), gridRow() + 3);
    return Array.from({ length: Math.max(0, to - from) }, (_, row) => from + row);
  };

  return (
    <View
      ref={element => {
        root = element;
        props.ref?.(element);
      }}
      width={PAGE_WIDTH}
      height={1080}
      // Under a title's page it would be drawn for nothing, and the TV's GPU
      // has no fill rate to spare (PLAN.md, "UI performance").
      alpha={props.covered ? 0 : 1}
      // Read by sayWhileFocused above, not as the page's whole text.
      announce=""
      onFocusChanged={setFocused}
      onUp={() => {
        if (area() === "groups") moveGroup(-1);
        else moveRows(-1);
        return true;
      }}
      onDown={() => {
        if (area() === "groups") moveGroup(1);
        else moveRows(1);
        return true;
      }}
      onChannelUp={() => {
        if (area() === "groups") moveGroup(-GROUP_ROWS);
        else moveRows(-PAGE_ROWS);
        return true;
      }}
      onChannelDown={() => {
        if (area() === "groups") moveGroup(GROUP_ROWS);
        else moveRows(PAGE_ROWS);
        return true;
      }}
      onLeft={() => {
        // From the column, on to the menu.
        if (area() === "groups") return false;
        // From a row's first poster, on to the column.
        if (at() % COLUMNS === 0) return toGroups();
        placeAt(at() - 1);
        return true;
      }}
      onRight={() => {
        if (area() === "groups") toGrid();
        else if (at() % COLUMNS < COLUMNS - 1 && at() + 1 < items().length) placeAt(at() + 1);
        return true;
      }}
      onEnter={() => {
        if (area() === "groups") {
          if (onSearch()) search();
          else toGrid();
        } else {
          const item = current();
          if (item) props.onOpen(item);
        }
        return true;
      }}
      onBack={() => {
        // From the column, on to the menu.
        if (area() === "groups") return false;
        return toGroups();
      }}
    >
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
        {/* The page, which moves right of the menu and the column while they show. */}
        <View x={pageX()} width={PAGE_WIDTH} height={1080}>
          <Backdrop width={PAGE_WIDTH} height={HERO_HEIGHT} src={hero()?.backdrop} />

          <Text x={LEFT} y={48} fontSize={26} fontFamily={BOLD} letterSpacing={3} color={colors.accentText}>
            {props.title.toUpperCase()}
          </Text>

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

          <View
            x={LEFT}
            y={LABEL_Y}
            width={PAGE_WIDTH - 2 * LEFT}
            height={LABEL_HEIGHT - 14}
            display="flex"
            flexDirection="row"
            alignItems="center"
            gap={20}
          >
            <Text fontSize={30} fontFamily={BOLD} maxLines={1}>
              {group()?.label ?? ""}
            </Text>
            <Text fontSize={24} color={colors.textFaint}>
              {$tn("count.titles", items().length)}
            </Text>
          </View>
          <Show when={items().length === 0 && currentId() === SEARCH}>
            <Text x={LEFT} y={GRID_Y + 20} fontSize={28} color={colors.textDim}>
              {$t("vod.noMatches", { query: query() })}
            </Text>
          </Show>

          <View y={GRID_Y - GRID_MARGIN} width={PAGE_WIDTH} height={1080 - GRID_Y + GRID_MARGIN} clipping>
            {/* The strip slides, so it's as big as what it holds: the renderer
                skips the children of a node it finds off screen, and with no
                size the strip was, three rows down. */}
            <View
              x={LEFT}
              y={GRID_MARGIN - gridRow() * ROW_HEIGHT}
              width={COLUMNS * STEP}
              height={rowCount() * ROW_HEIGHT}
              transition={{ y: motion.normal }}
            >
              <For each={drawnRows()}>
                {row => (
                  <For each={Array.from({ length: COLUMNS }, (_, column) => row * COLUMNS + column)}>
                    {index => {
                      const item = () => items()[index];
                      const selected = () => inGrid() && !props.covered && at() === index;
                      return (
                        <Show when={item()}>
                          {one => (
                            <View
                              x={(index % COLUMNS) * STEP}
                              y={row * ROW_HEIGHT}
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
                )}
              </For>
            </View>
          </View>
        </View>

        <GroupColumn
          x={groupsX()}
          shown={wide() && !inGrid()}
          items={groups().map(one => ({ label: one.label, count: one.items.length }))}
          top={groupTop()}
          cursor={onSearch() ? -1 : cursorIndex()}
          current={groupIndex()}
          focused={focused() && !props.covered && area() === "groups"}
          query={query()}
          searchLabel={props.searchLabel}
        />
      </Show>
    </View>
  );
};
