import { Text, View } from "@solidtv/solid";
import { createMemo, Index, Show } from "solid-js";
import { ChannelLogo } from "../../components/ChannelLogo";
import { FavouriteDot } from "../../components/FavouriteDot";
import { Fill } from "../../components/Fill";
import type { Channel } from "../../data/lineup";
import { type Cell, placeCell } from "../../guide/timeline";
import { progress } from "../../live/format";
import { BOLD, colors, RING } from "../../theme";
import { $t } from "../../translate";

export const ROW_HEIGHT = 74;
// Room for 306 px of name beside a logo (170 px before, +80% as asked).
export const CHANNEL_WIDTH = 456;
/** The space under each row's cells. */
export const ROW_GAP = 6;
const INNER = ROW_HEIGHT - ROW_GAP;
const CELL_GAP = 4;
// Narrower cells have no room for a title.
const MIN_TEXT_WIDTH = 56;

const CELL_RADIUS = 10;
// Where the number ends: room for five digits inside the row's highlight,
// which numbers of four or more stuck out of at 50.
const NUMBER_RIGHT = 74;
const LOGO_X = NUMBER_RIGHT + 12;
const LOGO_WIDTH = 64;
const LOGO_HEIGHT = 40;

const COLORS = {
  cell: colors.surface,
  onNow: colors.surfaceRaised,
  empty: colors.surfaceFaint,
  focused: colors.highlight,
  ring: colors.focus,
  channel: colors.transparent,
  transparent: colors.transparent,
  cursorChannel: colors.surfaceRaised,
  text: colors.text,
  dim: colors.textFaint,
  faint: colors.textFaint,
  focusedText: colors.accentText,
  playing: colors.accentText,
  moving: colors.goldWash,
  track: colors.track,
  elapsed: colors.accent,
  archive: colors.gold,
  reminder: colors.gold,
};

export interface GuideRowProps {
  channel: Channel;
  number: number;
  playing: boolean;
  /** The row's cells; see src/guide/timeline.ts. */
  cells: readonly Cell[];
  from: number;
  to: number;
  pxPerMs: number;
  gridX: number;
  now: number;
  /** Whether the cursor is on this row. */
  current: boolean;
  /** Whether the channel is being moved in Favourites. */
  moving?: boolean;
  /** The focused cell, when the guide has focus and the cursor is here. */
  focused?: Cell;
  /** Where the channel's catch-up starts; programmes since then that have begun can be played. */
  archiveFrom?: number;
  /** Whether a programme starting at `start` has a reminder. */
  reminded?: (start: number) => boolean;
}

interface Placed {
  x: number;
  width: number;
  label: string;
  color: string;
  textColor: string;
  /** Marked as playable from the archive. */
  archive: boolean;
  /** How far the programme on now is, from 0 to 1; undefined for the others. */
  elapsed?: number;
  reminder: boolean;
  focused: boolean;
}

/**
 * One channel's row: its number and name, then its programmes from `from` to
 * `to`. The page draws a fixed number of these and fills them as it scrolls.
 */
export const GuideRow = (props: GuideRowProps) => {
  // A row without programmes is one bar; its cells only move the focus.
  const whole = () => {
    const kind = props.cells[0]?.kind;
    return kind === "loading" || kind === "none" || kind === "locked" ? kind : undefined;
  };

  const placed = createMemo((): Placed[] => {
    if (whole()) return [];
    const list: Placed[] = [];
    for (const cell of props.cells) {
      if (cell.stop <= props.from || cell.start >= props.to) continue;
      const { x, width } = placeCell(cell, props.from, props.to, props.pxPerMs);
      if (width <= CELL_GAP) continue;
      const title = cell.programme?.title ?? "";
      const label = width - CELL_GAP < MIN_TEXT_WIDTH ? "" : cell.start < props.from ? `‹ ${title}` : title;
      const programme = cell.kind === "programme";
      const onNow = programme && cell.start <= props.now && cell.stop > props.now;
      let color: string = cell.kind === "gap" ? COLORS.empty : onNow ? COLORS.onNow : COLORS.cell;
      if (cell === props.focused) color = COLORS.focused;
      const archive =
        programme &&
        props.archiveFrom !== undefined &&
        cell.start >= props.archiveFrom &&
        cell.start < props.now;
      // Programmes that have ended, and can't be played, are fainter.
      const textColor =
        cell === props.focused
          ? COLORS.focusedText
          : programme && cell.stop <= props.now && !archive
            ? COLORS.dim
            : COLORS.text;
      const reminder = programme && cell.start > props.now && (props.reminded?.(cell.start) ?? false);
      list.push({
        x,
        width: width - CELL_GAP,
        label,
        color,
        textColor,
        archive,
        elapsed: onNow ? progress(cell.start, cell.stop, props.now) : undefined,
        reminder,
        focused: cell === props.focused,
      });
    }
    return list;
  });

  const nameX = () => (props.channel.logo ? LOGO_X + LOGO_WIDTH + 12 : LOGO_X);

  return (
    <>
      <View width={CHANNEL_WIDTH} height={INNER}>
        <Fill
          width={CHANNEL_WIDTH}
          height={INNER}
          borderRadius={CELL_RADIUS}
          color={props.moving ? COLORS.moving : props.current ? COLORS.cursorChannel : COLORS.channel}
        />
        <Text
          x={NUMBER_RIGHT}
          mountX={1}
          height={INNER}
          lineHeight={INNER}
          fontSize={22}
          color={props.playing ? COLORS.playing : COLORS.faint}
        >
          {String(props.number)}
        </Text>
        <FavouriteDot channelId={props.channel.id} x={NUMBER_RIGHT + 3} y={INNER / 2} size={8} />
        <Show when={props.channel.logo}>
          {logo => (
            <ChannelLogo
              x={LOGO_X}
              y={(INNER - LOGO_HEIGHT) / 2}
              width={LOGO_WIDTH}
              height={LOGO_HEIGHT}
              src={logo()}
            />
          )}
        </Show>
        <Text
          x={nameX()}
          width={CHANNEL_WIDTH - nameX() - 12}
          height={INNER}
          lineHeight={INNER}
          maxLines={1}
          contain="width"
          fontSize={26}
          fontFamily={props.playing || props.current ? BOLD : undefined}
          color={props.playing ? COLORS.playing : COLORS.text}
        >
          {props.channel.name}
        </Text>
      </View>
      <Show
        when={whole()}
        fallback={
          <Index each={placed()}>
            {cell => (
              <View
                x={props.gridX + cell().x}
                width={cell().width}
                height={INNER}
                borderRadius={CELL_RADIUS}
                // The focused cell is outlined: its colour shows as a ring
                // round the fill inside it.
                color={cell().focused ? COLORS.ring : cell().color}
              >
                <Fill
                  x={RING}
                  y={RING}
                  width={Math.max(0, cell().width - 2 * RING)}
                  height={INNER - 2 * RING}
                  borderRadius={CELL_RADIUS - RING}
                  color={cell().focused ? COLORS.focused : COLORS.transparent}
                />
                <Text
                  x={14}
                  width={Math.max(0, cell().width - 24)}
                  height={INNER}
                  lineHeight={INNER}
                  maxLines={1}
                  contain="width"
                  fontSize={25}
                  fontFamily={cell().focused ? BOLD : undefined}
                  color={cell().textColor}
                >
                  {cell().label}
                </Text>
                {/* Under the programme on now, how far it is; amber under one
                    that can be played from the catch-up. */}
                <Show when={cell().archive || cell().elapsed !== undefined}>
                  <View
                    x={12}
                    y={INNER - 11}
                    width={Math.max(0, cell().width - 24)}
                    height={4}
                    borderRadius={2}
                    color={
                      cell().elapsed === undefined
                        ? COLORS.archive
                        : cell().archive
                          ? colors.goldWash
                          : COLORS.track
                    }
                  />
                </Show>
                <Show when={cell().elapsed}>
                  {elapsed => (
                    <View
                      x={12}
                      y={INNER - 11}
                      width={Math.max(0, cell().width - 24) * elapsed()}
                      height={4}
                      borderRadius={2}
                      color={COLORS.elapsed}
                    />
                  )}
                </Show>
                <Show when={cell().reminder}>
                  <View
                    x={cell().width - 16}
                    y={8}
                    width={10}
                    height={10}
                    borderRadius={5}
                    color={COLORS.reminder}
                  />
                </Show>
              </View>
            )}
          </Index>
        }
      >
        {kind => (
          <View
            x={props.gridX}
            width={Math.round((props.to - props.from) * props.pxPerMs) - CELL_GAP}
            height={INNER}
            borderRadius={CELL_RADIUS}
            color={props.focused ? COLORS.ring : COLORS.empty}
          >
            <Fill
              x={RING}
              y={RING}
              width={Math.max(0, Math.round((props.to - props.from) * props.pxPerMs) - CELL_GAP - 2 * RING)}
              height={INNER - 2 * RING}
              borderRadius={CELL_RADIUS - RING}
              color={props.focused ? COLORS.focused : COLORS.transparent}
            />
            <Text
              x={14}
              height={INNER}
              lineHeight={INNER}
              fontSize={25}
              fontFamily={props.focused ? BOLD : undefined}
              color={props.focused ? COLORS.focusedText : COLORS.faint}
            >
              {kind() === "none" ? $t("live.noGuide") : kind() === "locked" ? $t("live.locked") : ""}
            </Text>
          </View>
        )}
      </Show>
    </>
  );
};
