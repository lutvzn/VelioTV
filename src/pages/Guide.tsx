import { useNavigate } from "@solidjs/router";
import { type ElementNode, Text, View } from "@solidtv/solid";
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
import { DAY } from "../data/guideCodec";
import type { Channel } from "../data/lineup";
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
import { clockTime, dayLabel } from "../live/format";
import { handOff, holdPlayer, playChannel, statusText, takeHandoff } from "../live/handoff";
import { centredTop, clampIndex, scrollTop, wrapIndex } from "../live/listWindow";
import { createNumberEntry } from "../live/numberEntry";
import { channelNumbers, rememberedChannel } from "../live/zapper";
import { guide, lineup } from "../library";
import { player } from "../player";
import { editText } from "../textEntry";
import { $t } from "../translate";
import type { Rect } from "../videoWindow";
import { GuideDetails } from "./guide/GuideDetails";
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
// channel names with the TV's keyboard.
//
// Like the Live TV channel list, it draws a fixed number of rows and fills
// them as it scrolls, so 10,000 channels cost the same as 8.

const HOUR = 3_600_000;
export const SPAN = 2 * HOUR;
export const STEP = HOUR / 2;
/** How far ahead the guide goes. */
const AHEAD = 7 * DAY;
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

export default () => {
  const navigate = useNavigate();
  let root: ElementNode | undefined;
  holdPlayer();
  const handoff = takeHandoff();

  const [focused, setFocused] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const ticker = setInterval(() => setNow(Date.now()), CLOCK_MS);
  const earliest = () => alignDown(now(), STEP);
  const latest = () => now() + AHEAD;

  const days = createGuideDays(guide);
  createEffect(on(lineup.channels, () => days.reset(), { defer: true }));
  const numbers = createMemo(() => channelNumbers(lineup.channels()));
  const numberOf = (channel: Channel) => numbers().byId.get(channel.id) ?? channel.index + 1;

  // Which channels show: every one, the search results, or a group.
  const [query, setQuery] = createSignal("");
  const results = createMemo(() => searchChannels(lineup.channels(), query()));
  const filters = createMemo((): Filter[] => [
    { id: ALL, label: $t("live.allChannels"), channels: lineup.channels() },
    ...(query()
      ? [{ id: SEARCH, label: $t("guide.searchResults", { query: query() }), channels: results() }]
      : []),
    ...lineup.groups().map(group => ({
      id: `group:${group.name}`,
      label: group.name || $t("live.noGroup"),
      group: group.name,
      channels: group.channels,
    })),
  ]);
  const [filterId, setFilterId] = createSignal(handoff?.group === undefined ? ALL : `group:${handoff.group}`);
  const filter = createMemo(() => filters().find(f => f.id === filterId()) ?? filters()[0]);
  const list = createMemo(() => filter().channels);

  // The cursor's row, and the first row drawn. When the channels change,
  // the cursor stays on its channel if it can.
  const [cursor, setCursor] = createSignal(0);
  const [top, setTop] = createSignal(0);
  let cursorId = handoff?.channelId ?? rememberedChannel(localStorage);
  const placeCursor = (index: number) => {
    setCursor(index);
    setTop(centredTop(index, GUIDE_ROWS, list().length));
    cursorId = list()[index]?.id;
  };
  createEffect(
    on(list, channels => {
      if (channels.length === 0) return;
      placeCursor(
        Math.max(
          0,
          channels.findIndex(channel => channel.id === cursorId),
        ),
      );
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
  const [from, setFrom] = createSignal(earliest());
  const [anchor, setAnchor] = createSignal(Date.now());
  const to = () => from() + SPAN;
  const anchorAt = () => Math.max(anchor(), earliest());
  createEffect(
    on(earliest, first => {
      if (from() < first) setFrom(first);
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
  // when the page opens. A channel already playing carries on.
  const [previewId, setPreviewId] = createSignal<string>();
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let firstPreview = true;
  createEffect(
    on(cursorChannel, channel => {
      clearTimeout(previewTimer);
      if (!channel) return;
      const delay = firstPreview ? 0 : PREVIEW_DELAY_MS;
      firstPreview = false;
      previewTimer = setTimeout(() => {
        playChannel(channel);
        setPreviewId(channel.id);
      }, delay);
    }),
  );

  const [area, setArea] = createSignal<"grid" | "filters">("grid");

  const entry = createNumberEntry({
    onNumber: number => {
      const channel = numbers().byNumber.get(number);
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

  const watch = () => {
    const channel = cursorChannel();
    if (!channel) return;
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

  exposeToProbes("guidePage", {
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
  const ticks = () => Array.from({ length: SPAN / STEP }, (_, i) => from() + i * STEP);
  const nowX = () => GRID_X + (now() - from()) * PX_PER_MS;

  return (
    <View
      ref={element => (root = element)}
      width={PAGE_WIDTH}
      height={1080}
      onFocusChanged={setFocused}
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
        const previous = row && previousAnchor(row.cells, anchorAt(), earliest(), STEP);
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
      onEnter={() => {
        if (entry.digits()) entry.enter();
        else if (area() === "filters") search();
        else watch();
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
        when={lineup.channels().length > 0}
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
        <Show when={previewId() ? statusText() : undefined}>
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
          day={dayLabel(Math.max(focusedCell()?.start ?? now(), now()), now(), {
            today: $t("guide.today"),
            tomorrow: $t("guide.tomorrow"),
          })}
          now={now()}
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
            {focused() && area() === "filters"
              ? $t("guide.filterHint")
              : $t("live.channelCount", { count: list().length })}
          </Text>
        </View>

        <Text x={LEFT} y={TIMES_Y} width={CHANNEL_WIDTH} maxLines={1} contain="width" fontSize={26}>
          {dayLabel(from(), now(), { today: $t("guide.today"), tomorrow: $t("guide.tomorrow") })}
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
                    current={top() + slot === cursor()}
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
    </View>
  );
};
