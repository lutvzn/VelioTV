import { type ElementNode, Text, View } from "@solidtv/solid";
import { useHold } from "@solidtv/solid/primitives";
import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Artwork } from "../../components/Artwork";
import { Backdrop } from "../../components/Backdrop";
import { MENU_OPEN_WIDTH, MENU_WIDTH, menuOpen } from "../../components/SideMenu";
import { exposeToProbes } from "../../devHooks";
import { markEmpty } from "../../emptySection";
import { heldRacing, moveWhileHeld, stopHold } from "../../heldKey";
import { TITLE_SORTS, type TitleSort } from "../../data/vodSorts";
import { settings, vodPins, vodSorts } from "../../library";
import { createRestingCursor } from "../../restingCursor";
import { scrollTop } from "../../live/listWindow";
import { editText } from "../../textEntry";
import { BOLD, colors, focusShadow, motion, radius, RING } from "../../theme";
import { $t, $tn } from "../../translate";
import { sayWhileFocused } from "../../voiceGuide";
import { useWholeScreen } from "../../wholeScreen";
import { GROUP_ROWS, GroupColumn, GROUPS_WIDTH, SEARCH_RECT } from "../guide/GroupColumn";
import { HOLD_MS, HOLD_REQUIRES_REPEAT, OPTIONS_WIDTH, OptionsPanel } from "../live/ChannelOptions";
import type { Menu } from "../live/menus";
import { Facts } from "./FilmPanel";
import { searchTitles, sortTitles } from "./hubOrder";

// The Movies and Series pages (PLAN.md, Phase 6, step 4), laid out as Live
// TV is: the menu, a column of groups (a search field, Continue watching,
// everything, then each category), and right of them the title under the
// cursor large at the top, over its backdrop, with the group's posters in a
// grid under it. Up and Down in the column change the group shown; Right or
// OK goes into the posters, and the page then fills the screen. Left from a
// row's first poster, or Back, shows the menu and the column again, moving
// the page right of them. Only the grid's rows near the cursor are drawn, so
// 2,000 films cost the same as 20.
//
// The Stremio add-ons' catalogs (src/stremio/) come after the categories,
// each a group that asks for more as the cursor nears its end (onNearEnd),
// and their search results join the search group's (searchItems).
//
// Everything, the categories and the page's other sortable groups can be
// ordered by when their titles were added, name, year or rating, or as
// listed (src/pages/vod/hubOrder.ts): holding OK on the group, or the Tools
// key, offers it, and each profile keeps each group's (src/data/vodSorts.ts).
// The same menu pins a category or catalog at the top of the column, over
// Continue watching (src/data/vodPins.ts).
// The cursor stays on its title, not its place, as the titles change.

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
  /** When it was added, in milliseconds since 1970, for Recently added. */
  added?: number;
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
  /** Asking for its titles, or more of them. */
  loading?: boolean;
  /** Whether its order can be chosen; a catalog's or Popular's is its own. */
  sortable?: boolean;
  /** Pinned at the top of the column. */
  pinned?: boolean;
}

/** A group the page gives, such as an add-on's catalog. */
export type ExtraGroup<T> = Group<T>;

/** Rows from a group's end at which more is asked for. */
const MORE_ROWS = 3;

/** Where the page was, to come back to after watching. */
export interface HubPlace {
  groupId: string;
  query: string;
  /** The poster with the cursor in each group. */
  at: Record<string, number>;
  /** The title with the cursor in each group, which it stays on as the titles change. */
  keys?: Record<string, string>;
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
  /** Groups after the categories, such as add-ons' catalogs; shown once they have titles, or while loading. */
  extraGroups?: ExtraGroup<T>[];
  /** The cursor is near the end of an extra group (or it's shown with none): ask for more. */
  onNearEnd?: (groupId: string) => void;
  /** More search results, such as from add-ons, after the page's own; and whether they're coming. */
  searchItems?: T[];
  searching?: boolean;
  /** The search typed, for the page to ask others with. */
  onQuery?: (query: string) => void;
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
  /** The page whose groups' orders and pins are kept, such as "movies"; none can be chosen without it. */
  sortPage?: string;
  /** The order of a group none was chosen for. */
  defaultSort?: TitleSort;
  /** A title's other names to search, such as each source's for it. */
  alsoNamed?: (item: T) => readonly string[];
  /** The key a title the cursor was on has now, as when matched and joined with others. */
  currentKey?: (key: string) => string | undefined;
}

const sortLabel = (sort: TitleSort) => $t(`vod.sort.${sort}`);

/** Where the column is: beside the menu, moving right as it opens. */
const groupsX = () => (menuOpen() ? MENU_OPEN_WIDTH : MENU_WIDTH);

export const VodHub = <T extends HubItem>(props: VodHubProps<T>) => {
  const [focused, setFocused] = createSignal(false);
  const [query, setQuery] = createSignal(props.place?.query ?? "");
  const results = createMemo(() => {
    if (!query().trim()) return [];
    const own = searchTitles(props.items, query(), props.alsoNamed);
    const seen = new Set(own.map(item => item.key));
    return [...own, ...(props.searchItems ?? []).filter(item => !seen.has(item.key))];
  });
  createEffect(on(query, typed => props.onQuery?.(typed), { defer: !props.place?.query }));
  const extras = () => (props.extraGroups ?? []).filter(one => one.items.length > 0 || one.loading);
  const groups = createMemo((): Group<T>[] => {
    const byCategory = new Map<string, T[]>();
    // The modern pages give their categories as extra groups, so none are made here.
    if (props.categories.length > 0) {
      for (const item of props.items) {
        if (!item.category) continue;
        let list = byCategory.get(item.category);
        if (!list) byCategory.set(item.category, (list = []));
        list.push(item);
      }
    }
    const list: Group<T>[] = [
      ...(props.continueItems.length > 0
        ? [{ id: CONTINUE, label: $t("vod.continue"), items: props.continueItems }]
        : []),
      ...(props.items.length > 0
        ? [{ id: ALL, label: props.allLabel, items: props.items, sortable: true }]
        : []),
      ...props.categories
        .filter(name => byCategory.has(name))
        .map(name => ({
          id: `category:${name}`,
          label: name,
          items: byCategory.get(name) ?? [],
          sortable: true,
        })),
      ...extras(),
    ];
    // The groups pinned, in their order, go first, under the search results.
    const pins = props.sortPage ? vodPins.of(props.sortPage) : [];
    const pinned = pins.flatMap(id => {
      const one = list.find(other => other.id === id);
      return one ? [{ ...one, pinned: true }] : [];
    });
    const search: Group<T>[] = query()
      ? [
          {
            id: SEARCH,
            label: $t("guide.searchResults", { query: query() }),
            items: results(),
            loading: props.searching,
          },
        ]
      : [];
    return [...search, ...pinned, ...list.filter(one => !pins.includes(one.id))];
  });

  const [groupId, setGroupId] = createSignal(props.place?.groupId ?? CONTINUE);
  // A group that's gone shows the first one not pinned, as before any were.
  const groupIndex = createMemo(() => {
    const index = groups().findIndex(one => one.id === groupId());
    return index >= 0
      ? index
      : Math.max(
          0,
          groups().findIndex(one => !one.pinned),
        );
  });
  const group = () => groups()[groupIndex()];
  /** The group shown: the one asked for, or the first if it's gone. */
  const currentId = () => group()?.id;
  /** A group's order, if it can be chosen. */
  const sortOf = (one: Group<T> | undefined): TitleSort | undefined =>
    one?.sortable && props.sortPage
      ? (vodSorts.sortOf(props.sortPage, one.id) ?? props.defaultSort ?? "listed")
      : undefined;
  /** The group's titles, in its order. */
  const items = createMemo((): readonly T[] => {
    const one = group();
    if (!one) return [];
    const sort = sortOf(one);
    return sort ? sortTitles(one.items, sort) : one.items;
  });
  const [places, setPlaces] = createSignal<Record<string, number>>(props.place?.at ?? {});
  const [keys, setKeys] = createSignal<Record<string, string>>(props.place?.keys ?? {});
  const placeOf = (id: string) => places()[id] ?? 0;
  /** The cursor: on the title it was on, wherever that is now, or else at its place. */
  const at = createMemo(() => {
    const one = group();
    if (!one) return 0;
    const list = items();
    const index = Math.max(0, Math.min(placeOf(one.id), list.length - 1));
    const key = keys()[one.id];
    if (key === undefined || list[index]?.key === key) return index;
    let found = list.findIndex(item => item.key === key);
    const now = found < 0 ? props.currentKey?.(key) : undefined;
    if (now !== undefined && now !== key) found = list.findIndex(item => item.key === now);
    return found >= 0 ? found : index;
  });
  const placeAt = (index: number) => {
    const one = group();
    if (!one) return;
    const list = items();
    const place = Math.max(0, Math.min(index, list.length - 1));
    const key = list[place]?.key;
    batch(() => {
      setPlaces(all => ({ ...all, [one.id]: place }));
      if (key !== undefined) setKeys(all => ({ ...all, [one.id]: key }));
    });
  };
  /** A group's cursor back on its first title, as for a new search or order. */
  const restart = (id: string) =>
    batch(() => {
      setPlaces(all => ({ ...all, [id]: 0 }));
      setKeys(all => {
        const next = { ...all };
        delete next[id];
        return next;
      });
    });
  // A group whose items changed keeps its cursor in range.
  createEffect(
    on(groups, list => {
      for (const one of list) {
        if (placeOf(one.id) >= one.items.length)
          setPlaces(all => ({ ...all, [one.id]: Math.max(0, one.items.length - 1) }));
      }
    }),
  );
  createEffect(() =>
    props.onPlace?.({ groupId: currentId() ?? groupId(), query: query(), at: places(), keys: keys() }),
  );

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
  /**
   * Moves the column's cursor by `step`, from the search field (-1) to the
   * last group; returns whether it moved.
   */
  const moveGroup = (step: number) => {
    const all = groups();
    const from = onSearch() ? -1 : cursorIndex();
    const index = Math.max(-1, Math.min(all.length - 1, from + step));
    batch(() => {
      setOnSearch(index < 0);
      if (index >= 0) groupCursor.move(all[index].id);
    });
    return index !== from;
  };
  // Up or Down, held: the cursor goes on by itself, faster and faster, up to
  // the speed set for the list (Settings, "Scrolling speed").
  const holdGroup = (event: KeyboardEvent, step: number) =>
    moveWhileHeld(
      event,
      step,
      settings.holdSpeed("groups"),
      by => focused() && !props.covered && area() === "groups" && moveGroup(by),
    );
  onCleanup(stopHold);

  const empty = () => props.items.length === 0 && props.continueItems.length === 0 && extras().length === 0;
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
            restart(SEARCH);
            setGroupId(SEARCH);
            setOnSearch(false);
          } else if (groupId() === SEARCH) setGroupId(CONTINUE);
        });
        if (typed && results().length > 0) setArea("grid");
        root?.setFocus();
      },
    });

  /** Whether a group can be pinned: a category or a catalog, not search, Continue watching or everything. */
  const canPin = (one: Group<T> | undefined) =>
    !!one && !!props.sortPage && one.id !== SEARCH && one.id !== CONTINUE && one.id !== ALL;
  // A group's options, from holding OK on it in the column, or the Tools
  // key: pinning it, and its order.
  const [sorting, setSorting] = createSignal<Group<T>>();
  const sortMenu = (one: Group<T>): Menu => ({
    title: canPin(one) ? one.label : $t("vod.sortBy", { group: one.label }),
    options: () => {
      const page = props.sortPage;
      const pinned = page !== undefined && vodPins.isPinned(page, one.id);
      return [
        ...(page !== undefined && canPin(one)
          ? [
              {
                id: pinned ? "unpin" : "pin",
                label: pinned ? $t("options.unpin") : $t("options.pin"),
                run: () => vodPins.set(page, one.id, !pinned),
              },
            ]
          : []),
        ...(sortOf(one)
          ? TITLE_SORTS.map(sort => ({
              id: `sort:${sort}`,
              label: `${sortOf(one) === sort ? "•  " : "    "}${sortLabel(sort)}`,
              run: () => {
                if (page) vodSorts.set(page, one.id, sort);
                // A new order starts from its first title.
                restart(one.id);
              },
            }))
          : []),
      ];
    },
  });
  /** Opens the group's options, if it has any; returns whether it did. */
  const openSort = (one: Group<T> | undefined) => {
    if (!one || (!sortOf(one) && !canPin(one))) return false;
    // The group the column's cursor is on shows, to see its new order.
    groupCursor.settle();
    setSorting(one);
    return true;
  };
  const closeSort = () => {
    setSorting(undefined);
    root?.setFocus();
  };
  /** The group the keys are on: the column's, unless on the search field, or the one shown. */
  const keyGroup = () => {
    if (area() !== "groups") return group();
    return onSearch() ? undefined : cursorGroup();
  };
  const pressEnter = () => {
    if (area() === "groups") {
      if (onSearch()) search();
      else toGrid();
    } else {
      const item = current();
      if (item) props.onOpen(item);
    }
  };
  const [holdEnter, releaseEnter] = useHold({
    onEnter: pressEnter,
    onHold: () => {
      if (area() !== "groups" || !openSort(keyGroup())) pressEnter();
    },
    holdThreshold: HOLD_MS,
    holdRequiresRepeat: HOLD_REQUIRES_REPEAT,
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
    sorting,
    sortOf: () => sortOf(group()),
  });

  // What the voice guide reads: the group, then the title under the cursor.
  sayWhileFocused(
    () => focused() && !props.covered && !sorting(),
    () => {
      if (area() === "groups") {
        const sort = sortOf(cursorGroup());
        return onSearch()
          ? [props.searchLabel, query()]
          : [
              cursorGroup()?.label,
              $tn("count.titles", cursorGroup()?.items.length ?? 0),
              sort ? sortLabel(sort) : undefined,
            ];
      }
      const item = current();
      if (!item) {
        const why =
          props.loading || group()?.loading
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
  /** Moves the cursor `rows` rows, or as far as there are; returns whether it moved. */
  const moveRows = (rows: number) => {
    const row = Math.max(0, Math.min(gridRow() + rows, rowCount() - 1));
    if (row === gridRow()) return false;
    placeAt(row * COLUMNS + (at() % COLUMNS));
    return true;
  };
  // An extra group asks for more as the cursor nears its end, and for its
  // first titles when it's shown with none.
  createEffect(() => {
    const shownGroup = group();
    if (!shownGroup || shownGroup.loading || !props.extraGroups?.some(one => one.id === shownGroup.id))
      return;
    if (gridRow() >= rowCount() - MORE_ROWS) props.onNearEnd?.(shownGroup.id);
  });
  const holdRows = (event: KeyboardEvent, step: number) =>
    moveWhileHeld(
      event,
      step,
      settings.holdSpeed("posters"),
      by => focused() && !props.covered && area() === "grid" && moveRows(by),
    );
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
      onUp={event => {
        if (area() === "groups") holdGroup(event, -1);
        else holdRows(event, -1);
        return true;
      }}
      onDown={event => {
        if (area() === "groups") holdGroup(event, 1);
        else holdRows(event, 1);
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
      onEnter={(event, target, handler) => {
        // Holding OK on a group offers its options; OK on a poster opens it at once.
        if (area() === "groups" && (sortOf(keyGroup()) || canPin(keyGroup()))) {
          return holdEnter(event, target, handler);
        }
        pressEnter();
        return true;
      }}
      onEnterRelease={releaseEnter}
      onTools={() => {
        openSort(keyGroup());
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
              {group()?.loading && items().length === 0
                ? $t("vod.loading")
                : $tn("count.titles", items().length)}
            </Text>
            <Show when={sortOf(group())}>
              {sort => (
                <Text fontSize={24} color={colors.textFaint}>
                  {`·   ${sortLabel(sort())}`}
                </Text>
              )}
            </Show>
          </View>
          <Show when={items().length === 0 && currentId() === SEARCH && !group()?.loading}>
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
                                wait={heldRacing()}
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
          items={groups().map(one => ({ label: one.label, count: one.items.length, pinned: one.pinned }))}
          top={groupTop()}
          cursor={onSearch() ? -1 : cursorIndex()}
          current={groupIndex()}
          focused={focused() && !props.covered && area() === "groups"}
          query={query()}
          searchLabel={props.searchLabel}
        />
      </Show>
      <Show when={sorting()}>
        {one => <OptionsPanel menu={sortMenu(one())} x={PAGE_WIDTH - OPTIONS_WIDTH} onClose={closeSort} />}
      </Show>
    </View>
  );
};
