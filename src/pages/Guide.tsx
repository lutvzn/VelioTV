import { useNavigate } from "@solidjs/router";
import { type ElementNode, Text, View } from "@solidtv/solid";
import { useHold } from "@solidtv/solid/primitives";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { MENU_WIDTH } from "../components/SideMenu";
import { catchupDays, inArchive } from "../data/catchup";
import { appStorage } from "../data/settingsCopy";
import { DAY, type ProgrammeDetails, type StoredProgramme } from "../data/guideCodec";
import type { Channel, ChannelGroup } from "../data/lineup";
import { exposeToProbes } from "../devHooks";
import { createGuideDays } from "../guide/guideDays";
import { searchChannels } from "../guide/search";
import {
  alignDown,
  cellAt,
  nextAnchor,
  previousAnchor,
  rowCells,
  spanStart,
  wholeRow,
} from "../guide/timeline";
import { clockTime, dayLabel, timeRange } from "../live/format";
import { handOff, holdPlayer, playChannel, statusText, takeHandoff } from "../live/handoff";
import { centredTop, clampIndex, scrollTop, wrapIndex } from "../live/listWindow";
import { createNumberEntry } from "../live/numberEntry";
import { rememberedChannel } from "../live/zapper";
import {
  edits,
  groupTitle,
  guide,
  isBlocked,
  lineup,
  liveGroups,
  liveNumbers,
  liveView,
  reminders,
} from "../library";
import { askPin } from "../pin";
import { FAVOURITES } from "../live/groups";
import { player } from "../player";
import { watchRecording } from "../play/start";
import { editText } from "../textEntry";
import { $t, $tn } from "../translate";
import type { Rect } from "../videoWindow";
import { sayWhileFocused } from "../voiceGuide";
import { GuideDetails } from "./guide/GuideDetails";
import {
  ChannelOptions,
  OptionsPanel,
  HOLD_MS,
  HOLD_REQUIRES_REPEAT,
  OPTIONS_WIDTH,
  OVERLAY_Z,
} from "./live/ChannelOptions";
import { groupMenu, programmeOptions } from "./live/menus";
import { CHANNEL_WIDTH, GuideRow, ROW_HEIGHT } from "./guide/GuideRow";

// Live TV: the TV guide (PLAN.md, Phase 4). Channels run down and time
// across, two hours at a time, with the highlighted channel playing in a
// preview at the top left and its programme described beside it.
//
// Up and Down move between channels, Left and Right between programmes, and
// the channel keys a page at a time; Left from the first programme goes to
// the menu. OK watches the channel full screen (src/pages/Watch.tsx), and
// Back there comes back here; the Guide key in full screen opens the guide,
// and Back returns to full screen. Number keys jump to a channel. Up from the first row
// reaches the group line, where Left and Right change group and OK searches
// channel names with the TV's keyboard. Holding OK on a channel, or the
// Tools key, opens its options (Phase 5, step 1).
//
// Channels with catch-up reach back as far as their archive (Phase 6): Left
// goes on into the past, programmes that can be played are marked, and OK on
// one that has ended plays it (src/pages/Play.tsx). The options offer
// watching a programme on now from its start, and reminders for programmes
// to come.
//
// Like the Live TV channel list, it draws a fixed number of rows and fills
// them as it scrolls, so 10,000 channels cost the same as 8.

const HOUR = 3_600_000;
export const SPAN = 2 * HOUR;
export const STEP = HOUR / 2;
/** How far ahead the guide goes. */
const AHEAD = 7 * DAY;
/** How far back catch-up can take it. */
const MAX_BACK_DAYS = 7;
export const GUIDE_ROWS = 8;
/** How long the cursor stays on a channel before the preview plays it. */
export const PREVIEW_DELAY_MS = 800;
const CLOCK_MS = 30_000;

// In the page's own pixels, which start right of the menu.
const PAGE_WIDTH = 1920 - MENU_WIDTH;
const LEFT = 40;
// In screen pixels.
const PREVIEW: Rect = { x: MENU_WIDTH + LEFT, y: 40, width: 576, height: 324 };
const DETAILS_X = LEFT + PREVIEW.width + 40;
const HEADER_Y = 392;
const HEADER_HEIGHT = 50;
const TIMES_Y = 452;
const ROWS_Y = 492;
const GRID_X = LEFT + CHANNEL_WIDTH + 10;
const GRID_WIDTH = PAGE_WIDTH - GRID_X - 30;
const PX_PER_MS = GRID_WIDTH / SPAN;
const SLOTS = Array.from({ length: GUIDE_ROWS }, (_, slot) => slot);

const ALL = "all";
const SEARCH = "search";

interface Filter {
  id: string;
  label: string;
  /** The lineup group, for Live TV to zap through. */
  group?: string;
  channels: Channel[];
}

const groupFilter = (group: ChannelGroup): Filter => ({
  id: `group:${group.name}`,
  label: groupTitle(group.name),
  group: group.name,
  channels: group.channels,
});

const numberOf = (channel: Channel) => liveNumbers().byId.get(channel.id) ?? channel.index + 1;

const dayWords = () => ({
  today: $t("guide.today"),
  tomorrow: $t("guide.tomorrow"),
  yesterday: $t("guide.yesterday"),
});

/** How many days back a channel's catch-up reaches here. */
const backDays = (channel: Channel) => Math.min(MAX_BACK_DAYS, catchupDays(channel));

export default () => {
  const navigate = useNavigate();
  let root: ElementNode | undefined;
  holdPlayer();
  const handoff = takeHandoff();

  const [focused, setFocused] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const ticker = setInterval(() => setNow(Date.now()), CLOCK_MS);
  /** Where the span starts when the page opens: now. */
  const nowStart = () => alignDown(now(), STEP);
  const latest = () => now() + AHEAD;

  const days = createGuideDays(guide);
  createEffect(on(lineup.channels, () => days.reset(), { defer: true }));

  // Which channels show: every one, the search results, or a group.
  const [query, setQuery] = createSignal("");
  const results = createMemo(() => searchChannels(liveView().channels, query()));
  // Every channel, then Favourites, the search results, and the playlists' groups.
  const filters = createMemo((): Filter[] => {
    const [first, ...rest] = liveGroups();
    const favourites = first?.name === FAVOURITES ? [groupFilter(first)] : [];
    return [
      { id: ALL, label: $t("live.allChannels"), channels: liveView().channels },
      ...favourites,
      ...(query()
        ? [{ id: SEARCH, label: $t("guide.searchResults", { query: query() }), channels: results() }]
        : []),
      ...(favourites.length > 0 ? rest : liveGroups()).map(groupFilter),
    ];
  });
  const [filterId, setFilterId] = createSignal(handoff?.group === undefined ? ALL : `group:${handoff.group}`);
  const filter = createMemo(() => filters().find(f => f.id === filterId()) ?? filters()[0]);
  const list = createMemo(() => filter().channels);
  // As far back as the longest catch-up among the channels shown; each
  // row's Left stops at its own.
  const reach = createMemo(() => list().reduce((most, channel) => Math.max(most, backDays(channel)), 0));
  const earliest = () => alignDown(now() - reach() * DAY, STEP);
  const rowEarliest = (channel: Channel) => {
    const back = backDays(channel);
    return back > 0 ? alignDown(now() - back * DAY, STEP) : nowStart();
  };

  // The cursor's row, and the first row drawn. When the channels change,
  // the cursor stays on its channel if it can.
  const [cursor, setCursor] = createSignal(0);
  const [top, setTop] = createSignal(0);
  let cursorId = handoff?.channelId ?? rememberedChannel(appStorage);
  const placeCursor = (index: number) => {
    setCursor(index);
    setTop(centredTop(index, GUIDE_ROWS, list().length));
    cursorId = list()[index]?.id;
  };
  createEffect(
    on(list, channels => {
      if (channels.length === 0) return;
      const index = Math.max(
        0,
        channels.findIndex(channel => channel.id === cursorId),
      );
      // A favourite moved within the rows shown: keep them where they are.
      if (index >= top() && index < top() + GUIDE_ROWS) {
        setCursor(index);
        setTop(scrollTop(index, top(), GUIDE_ROWS, channels.length));
        cursorId = channels[index]?.id;
      } else {
        placeCursor(index);
      }
    }),
  );
  const moveCursor = (index: number) => {
    const count = list().length;
    if (count === 0) return;
    const at = Math.max(0, Math.min(index, count - 1));
    setCursor(at);
    setTop(scrollTop(at, top(), GUIDE_ROWS, count));
    cursorId = list()[at]?.id;
  };
  const cursorChannel = () => list()[cursor()] as Channel | undefined;
  const cursorNumber = () => {
    const channel = cursorChannel();
    return channel && numberOf(channel);
  };

  // The time shown, and the moment the focus is on (src/guide/timeline.ts).
  const [from, setFrom] = createSignal(nowStart());
  const [anchor, setAnchor] = createSignal(Date.now());
  const to = () => from() + SPAN;
  const anchorAt = () => Math.max(anchor(), earliest());
  createEffect(
    on(earliest, first => {
      if (from() < first) setFrom(first);
    }),
  );
  // A span showing now moves on with it.
  createEffect(
    on(nowStart, (start, before) => {
      if (before !== undefined && from() === before) setFrom(start);
    }),
  );
  const moveTo = (next: number) =>
    batch(() => {
      setAnchor(next);
      setFrom(spanStart(next, from(), SPAN, STEP, earliest()));
    });

  // Each slot's row. Moving along a row needs the cells either side of the
  // span, so the cells reach a span further each way.
  const rows = SLOTS.map(slot =>
    createMemo(() => {
      const channel = list()[top() + slot] as Channel | undefined;
      if (!channel) return undefined;
      if (isBlocked(channel)) return { channel, cells: wholeRow("locked", from(), to(), STEP) };
      if (!channel.guideId) return { channel, cells: wholeRow("none", from(), to(), STEP) };
      const programmes = days.programmes(channel, from() - SPAN, to() + SPAN);
      if (!programmes) return { channel, cells: wholeRow("loading", from(), to(), STEP) };
      return { channel, cells: rowCells(programmes, from() - SPAN, to() + SPAN) };
    }),
  );
  const currentRow = () => rows[cursor() - top()]?.();
  const focusedCell = createMemo(() => {
    const row = currentRow();
    return row ? cellAt(row.cells, anchorAt()) : undefined;
  });

  // The focused programme's subtitle and description, read once it is
  // focused (src/data/guideCache.ts).
  const detailsWanted = createMemo(() => {
    const channel = cursorChannel();
    const programme = focusedCell()?.programme;
    if (!channel?.guideId || !programme) return undefined;
    return `${channel.source}\n${channel.guideId}\n${programme.start}`;
  });
  const [readDetails, setReadDetails] = createSignal<{ key: string; details: ProgrammeDetails }>();
  createEffect(
    on(detailsWanted, key => {
      if (!key) return;
      const [source, guideId, start] = key.split("\n");
      guide
        .details(source, guideId, Number(start))
        .then(details => {
          if (detailsWanted() === key) setReadDetails({ key, details });
          return details;
        })
        .catch((error: unknown) => console.error("Couldn't read the programme's details:", error));
    }),
  );
  const focusedDetails = () => {
    const read = readDetails();
    return read && read.key === detailsWanted() ? read.details : undefined;
  };

  // Reads the rows a page above and below, ahead of the scroll.
  createEffect(() => {
    const first = top();
    days.prefetch(
      list().slice(Math.max(0, first - GUIDE_ROWS), first + 2 * GUIDE_ROWS),
      from() - SPAN,
      to() + SPAN,
    );
  });

  // The preview plays the cursor's channel once it stays put, and at once
  // when the page opens. A channel already playing carries on. A locked
  // channel plays once the PIN is entered.
  const [previewId, setPreviewId] = createSignal<string>();
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let firstPreview = true;
  const cursorBlocked = () => {
    const channel = cursorChannel();
    return channel !== undefined && isBlocked(channel);
  };
  createEffect(
    on([cursorChannel, cursorBlocked], ([channel, blocked]) => {
      clearTimeout(previewTimer);
      if (!channel) return;
      const delay = firstPreview ? 0 : PREVIEW_DELAY_MS;
      firstPreview = false;
      previewTimer = setTimeout(() => {
        if (blocked) {
          player.stop();
          setPreviewId(undefined);
          return;
        }
        playChannel(channel);
        setPreviewId(channel.id);
      }, delay);
    }),
  );

  const [area, setArea] = createSignal<"grid" | "filters">("grid");

  const entry = createNumberEntry({
    onNumber: number => {
      const channel = liveNumbers().byNumber.get(number);
      if (!channel) return false;
      const index = list().findIndex(c => c.id === channel.id);
      if (index >= 0) placeCursor(index);
      else {
        // Not in this group: show every channel, with the cursor on it.
        cursorId = channel.id;
        setFilterId(ALL);
      }
      setArea("grid");
      return true;
    },
  });

  const changeFilter = (step: number) => {
    const all = filters();
    const at = Math.max(
      0,
      all.findIndex(f => f.id === filter().id),
    );
    setFilterId(all[wrapIndex(at, step, all.length)].id);
  };

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
        });
        if (typed && results().length > 0) setArea("grid");
        root?.setFocus();
      },
    });

  /** Plays a programme from the channel's catch-up. */
  const watchFromStart = (channel: Channel, programme: StoredProgramme) => {
    if (isBlocked(channel)) {
      void askPin().then(right => right && watchFromStart(channel, programme));
      return;
    }
    watchRecording(navigate, channel, programme, { group: filter().group });
  };

  // OK on a programme that has ended, in the archive, plays it; otherwise the
  // channel plays live.
  const watch = () => {
    const channel = cursorChannel();
    if (!channel) return;
    if (isBlocked(channel)) {
      void askPin().then(right => right && watch());
      return;
    }
    const programme = focusedCell()?.programme;
    const time = Date.now();
    if (programme && programme.stop <= time && inArchive(channel, programme.start, time)) {
      watchFromStart(channel, programme);
      return;
    }
    handOff({ channelId: channel.id, group: filter().group });
    navigate("/watch", { replace: true });
  };

  onMount(() => {
    player.setWindow(PREVIEW);
    // Opened from full screen: the guide takes the focus from the page it replaces.
    if (handoff) root?.setFocus();
  });
  onCleanup(() => {
    clearInterval(ticker);
    clearTimeout(previewTimer);
    entry.dispose();
  });

  // Moving a channel within Favourites: Up and Down carry it, OK or Back ends.
  const [moving, setMoving] = createSignal<Channel>();
  const inFavourites = () => filter().group === FAVOURITES;
  const moveBy = (step: number) => {
    const channel = moving();
    const channels = list();
    const at = channels.findIndex(other => other.id === channel?.id);
    if (!channel || at < 0) return;
    const target = channels[Math.max(0, Math.min(channels.length - 1, at + step))];
    // By position among the stored ids, which may hold channels no source has now.
    if (target) edits.moveFavourite(channel.id, edits.favourites().indexOf(target.id));
  };
  const movingKey = (key: string | undefined) => {
    if (key === "Up") moveBy(-1);
    else if (key === "Down") moveBy(1);
    else if (key === "ChannelUp") moveBy(-GUIDE_ROWS);
    else if (key === "ChannelDown") moveBy(GUIDE_ROWS);
    else if (key === "Enter" || key === "Back") setMoving(undefined);
    // Other keys do nothing until the move ends.
    return true;
  };
  // A move ends if the channel leaves Favourites.
  createEffect(() => {
    const channel = moving();
    if (channel && (!inFavourites() || !list().some(other => other.id === channel.id))) setMoving(undefined);
  });

  // The highlighted channel's options, or on the group line the group's,
  // from holding OK or the Tools key.
  const [optionsFor, setOptionsFor] = createSignal<Channel>();
  const [groupOptionsFor, setGroupOptionsFor] = createSignal<string>();
  const openOptions = () => {
    if (entry.active()) return false;
    if (area() === "filters") {
      const key = filter().group;
      // Every channel, search results and Favourites have no group options.
      if (key === undefined || key === FAVOURITES) return false;
      setGroupOptionsFor(key);
      return true;
    }
    const channel = cursorChannel();
    if (!channel) return false;
    setOptionsFor(channel);
    return true;
  };
  const closeOptions = () => {
    batch(() => {
      setOptionsFor(undefined);
      setGroupOptionsFor(undefined);
    });
    root?.setFocus();
  };
  const pressEnter = () => {
    if (entry.digits()) entry.enter();
    else if (area() === "filters") search();
    else watch();
  };
  const [holdEnter, releaseEnter] = useHold({
    onEnter: pressEnter,
    onHold: () => {
      if (!openOptions()) pressEnter();
    },
    holdThreshold: HOLD_MS,
    holdRequiresRepeat: HOLD_REQUIRES_REPEAT,
  });

  exposeToProbes("guidePage", {
    optionsFor,
    groupOptionsFor,
    filters,
    moving,
    cursor,
    top,
    from,
    anchor: anchorAt,
    area,
    list,
    filter,
    query,
    focusedCell,
    cursorChannel,
    previewId,
    rows: () => rows.map(row => row()),
    days,
  });

  const digit = (value: number) => () => {
    entry.digit(value);
    return true;
  };
  /** The focused programme's day: its start's, or today while it's on. */
  const focusedDay = () => {
    const cell = focusedCell();
    if (!cell) return now();
    return cell.stop <= now() ? cell.start : Math.max(cell.start, now());
  };
  /** Where a channel's archive starts, now; undefined without catch-up. */
  const archiveStart = (channel: Channel) => {
    const back = catchupDays(channel);
    return back > 0 ? now() - back * DAY : undefined;
  };
  /** The focused programme, for `channel`'s options. */
  const focusedProgramme = (channel: Channel) =>
    channel.id === cursorChannel()?.id && area() === "grid" && !isBlocked(channel)
      ? focusedCell()?.programme
      : undefined;
  /** What OK or the options can do with the focused programme. */
  const detailsNote = () => {
    const channel = cursorChannel();
    const programme = focusedCell()?.programme;
    if (!channel || !programme || isBlocked(channel)) return undefined;
    if (reminders.has(channel.id, programme.start)) return $t("guide.reminderSet");
    if (!inArchive(channel, programme.start, now())) return undefined;
    return programme.stop <= now() ? $t("guide.okPlays") : $t("guide.canStartOver");
  };
  // What the voice guide reads: the group, or the channel, then the
  // programme under the cursor, its day and time, and what OK does.
  sayWhileFocused(focused, () => {
    if (area() === "filters") return [filter().label, $tn("count.channels", list().length)];
    const channel = cursorChannel();
    if (!channel)
      return filter().id === SEARCH ? $t("guide.noMatches", { query: query() }) : $t("live.groupEmpty");
    const cell = focusedCell();
    const heading = `${cursorNumber()} ${channel.name}`;
    if (moving()) return [heading, $t("guide.moveHint")];
    if (!cell || cell.kind === "loading") return [heading];
    if (cell.kind === "none") return [heading, $t("live.noGuide")];
    if (cell.kind === "locked") return [heading, $t("live.locked")];
    const when = `${dayLabel(focusedDay(), now(), dayWords())}, ${timeRange(cell.start, cell.stop)}`;
    return [heading, cell.programme?.title ?? $t("guide.noInformation"), when, detailsNote()];
  });
  const ticks = () => Array.from({ length: SPAN / STEP }, (_, i) => from() + i * STEP);
  const nowX = () => GRID_X + (now() - from()) * PX_PER_MS;

  return (
    <View
      ref={element => (root = element)}
      width={PAGE_WIDTH}
      height={1080}
      // Read by sayWhileFocused above, not as the page's whole text.
      announce=""
      onFocusChanged={setFocused}
      // While a favourite moves, it has every key.
      onCaptureKey={(_event, _element, _focused, key) => (moving() ? movingKey(key) : false)}
      onUp={() => {
        if (area() === "filters") return true;
        if (cursor() === 0 || list().length === 0) setArea("filters");
        else moveCursor(cursor() - 1);
        return true;
      }}
      onDown={() => {
        if (area() === "filters") {
          if (list().length > 0) setArea("grid");
        } else {
          moveCursor(cursor() + 1);
        }
        return true;
      }}
      onChannelUp={() => {
        setArea("grid");
        moveCursor(clampIndex(cursor(), -GUIDE_ROWS, list().length));
        return true;
      }}
      onChannelDown={() => {
        setArea("grid");
        moveCursor(clampIndex(cursor(), GUIDE_ROWS, list().length));
        return true;
      }}
      onLeft={() => {
        if (area() === "filters") {
          changeFilter(-1);
          return true;
        }
        const row = currentRow();
        const previous = row && previousAnchor(row.cells, anchorAt(), rowEarliest(row.channel), STEP);
        // From the first programme, on to the menu.
        if (previous === undefined) return false;
        moveTo(previous);
        return true;
      }}
      onRight={() => {
        if (area() === "filters") {
          changeFilter(1);
          return true;
        }
        const row = currentRow();
        const next = row && nextAnchor(row.cells, anchorAt(), latest());
        if (next !== undefined) moveTo(next);
        return true;
      }}
      onEnter={holdEnter}
      onEnterRelease={releaseEnter}
      onTools={() => {
        openOptions();
        return true;
      }}
      onBack={() => {
        if (entry.active()) entry.clear();
        else if (area() === "filters") setArea("grid");
        else if (handoff?.backTo === "/watch") {
          // Opened from full screen with the Guide key: back to the channel.
          handOff({ channelId: handoff.channelId, group: handoff.group });
          navigate("/watch", { replace: true });
        } else return false;
        return true;
      }}
      onKey0={digit(0)}
      onKey1={digit(1)}
      onKey2={digit(2)}
      onKey3={digit(3)}
      onKey4={digit(4)}
      onKey5={digit(5)}
      onKey6={digit(6)}
      onKey7={digit(7)}
      onKey8={digit(8)}
      onKey9={digit(9)}
    >
      <Show
        when={liveView().channels.length > 0}
        fallback={
          <>
            <Text x={LEFT} y={50} fontSize={56}>
              {$t("menu.live")}
            </Text>
            <Text x={LEFT} y={170} fontSize={44}>
              {lineup.loading() ? $t("live.loading") : $t("live.empty")}
            </Text>
            <Text x={LEFT} y={240} width={1300} contain="width" fontSize={30} color="#ffffffb3">
              {lineup.loading() ? "" : $t("live.emptyHint")}
            </Text>
          </>
        }
      >
        <Show when={cursorBlocked() ? $t("live.locked") : previewId() ? statusText() : undefined}>
          {text => (
            <Text
              x={LEFT + 20}
              y={PREVIEW.y}
              width={PREVIEW.width - 40}
              height={PREVIEW.height}
              lineHeight={PREVIEW.height}
              maxLines={1}
              contain="width"
              textAlign="center"
              fontSize={26}
              color="#ffffffcc"
            >
              {text()}
            </Text>
          )}
        </Show>
        <GuideDetails
          x={DETAILS_X}
          y={PREVIEW.y}
          width={PAGE_WIDTH - DETAILS_X - 40}
          channel={cursorChannel()}
          number={cursorNumber()}
          cell={focusedCell()}
          details={focusedDetails()}
          day={dayLabel(focusedDay(), now(), dayWords())}
          now={now()}
          note={detailsNote()}
        />

        <View
          x={LEFT}
          y={HEADER_Y}
          width={PAGE_WIDTH - LEFT - 30}
          height={HEADER_HEIGHT}
          borderRadius={10}
          color={focused() && area() === "filters" ? "#2e6bd6ff" : "#ffffff0f"}
        >
          <Text
            x={20}
            width={760}
            height={HEADER_HEIGHT}
            lineHeight={HEADER_HEIGHT}
            maxLines={1}
            contain="width"
            fontSize={28}
          >
            {`‹  ${filter().label}  ›`}
          </Text>
          <Text
            x={PAGE_WIDTH - LEFT - 50}
            mountX={1}
            height={HEADER_HEIGHT}
            lineHeight={HEADER_HEIGHT}
            fontSize={24}
            color="#ffffffb3"
          >
            {moving()
              ? $t("guide.moveHint")
              : focused() && area() === "filters"
                ? $t("guide.filterHint")
                : $tn("count.channels", list().length)}
          </Text>
        </View>

        <Text x={LEFT} y={TIMES_Y} width={CHANNEL_WIDTH} maxLines={1} contain="width" fontSize={26}>
          {dayLabel(from(), now(), dayWords())}
        </Text>
        <Index each={ticks()}>
          {time => (
            <>
              <View
                x={GRID_X + (time() - from()) * PX_PER_MS}
                y={TIMES_Y + 4}
                width={2}
                height={26}
                color="#ffffff4d"
              />
              <Text
                x={GRID_X + (time() - from()) * PX_PER_MS + 10}
                y={TIMES_Y}
                fontSize={26}
                color="#ffffffcc"
              >
                {clockTime(time())}
              </Text>
            </>
          )}
        </Index>

        <For each={SLOTS}>
          {slot => (
            <Show when={rows[slot]()}>
              {row => (
                <View x={LEFT} y={ROWS_Y + slot * ROW_HEIGHT} width={PAGE_WIDTH - LEFT} height={ROW_HEIGHT}>
                  <GuideRow
                    channel={row().channel}
                    number={numberOf(row().channel)}
                    playing={row().channel.id === previewId()}
                    cells={row().cells}
                    from={from()}
                    to={to()}
                    pxPerMs={PX_PER_MS}
                    gridX={GRID_X - LEFT}
                    now={now()}
                    archiveFrom={archiveStart(row().channel)}
                    reminded={start => reminders.has(row().channel.id, start)}
                    current={top() + slot === cursor()}
                    moving={moving()?.id === row().channel.id}
                    focused={
                      focused() && area() === "grid" && top() + slot === cursor() ? focusedCell() : undefined
                    }
                  />
                </View>
              )}
            </Show>
          )}
        </For>
        <Show when={list().length === 0}>
          <Text x={LEFT} y={ROWS_Y + 20} fontSize={30} color="#ffffffb3">
            {filter().id === SEARCH ? $t("guide.noMatches", { query: query() }) : $t("live.groupEmpty")}
          </Text>
        </Show>
        <Show when={now() >= from() && now() < to()}>
          <View
            x={nowX()}
            y={TIMES_Y + 34}
            width={3}
            height={ROWS_Y - TIMES_Y - 34 + GUIDE_ROWS * ROW_HEIGHT}
            color="#ff6b6bcc"
          />
        </Show>
      </Show>

      <Show when={entry.active()}>
        <View
          zIndex={OVERLAY_Z}
          x={PAGE_WIDTH - 40}
          y={40}
          mountX={1}
          width={420}
          height={110}
          borderRadius={16}
          color="#071423f2"
        >
          <Text
            width={420}
            height={110}
            lineHeight={110}
            contain="width"
            textAlign="center"
            fontSize={entry.digits() ? 64 : 32}
          >
            {entry.digits() || $t("live.noNumber", { number: entry.missing() ?? "" })}
          </Text>
        </View>
      </Show>

      <Show when={groupOptionsFor()}>
        {key => (
          <OptionsPanel menu={groupMenu(key())} x={PAGE_WIDTH - OPTIONS_WIDTH} onClose={closeOptions} />
        )}
      </Show>
      <Show when={optionsFor()}>
        {channel => (
          <ChannelOptions
            channel={channel()}
            x={PAGE_WIDTH - OPTIONS_WIDTH}
            onClose={closeOptions}
            extra={[
              ...programmeOptions(channel(), focusedProgramme(channel()), Date.now(), programme =>
                watchFromStart(channel(), programme),
              ),
              ...(inFavourites()
                ? [
                    {
                      id: "move",
                      label: $t("options.move"),
                      run: () => {
                        setMoving(channel());
                      },
                    },
                  ]
                : []),
            ]}
          />
        )}
      </Show>
    </View>
  );
};
