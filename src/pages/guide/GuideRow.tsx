import { Text, View } from "@solidtv/solid";
import { createMemo, Index, Show } from "solid-js";
import { FavouriteDot } from "../../components/FavouriteDot";
import type { Channel } from "../../data/lineup";
import { type Cell, placeCell } from "../../guide/timeline";
import { $t } from "../../translate";

export const ROW_HEIGHT = 68;
export const CHANNEL_WIDTH = 280;
const INNER = ROW_HEIGHT - 6;
const CELL_GAP = 4;
// Narrower cells have no room for a title.
const MIN_TEXT_WIDTH = 56;

const COLORS = {
  cell: "#ffffff14",
  onNow: "#ffffff26",
  empty: "#ffffff0a",
  focused: "#2e6bd6ff",
  channel: "#00000000",
  cursorChannel: "#ffffff1f",
  text: "#ffffffff",
  dim: "#ffffffb3",
  faint: "#ffffff66",
  playing: "#7fb2ffff",
  moving: "#f2c14e59",
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
}

interface Placed {
  x: number;
  width: number;
  label: string;
  color: string;
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
      let color = cell.kind === "gap" ? COLORS.empty : COLORS.cell;
      if (cell.kind === "programme" && cell.start <= props.now && cell.stop > props.now) color = COLORS.onNow;
      if (cell === props.focused) color = COLORS.focused;
      list.push({ x, width: width - CELL_GAP, label, color });
    }
    return list;
  });

  return (
    <>
      <View
        width={CHANNEL_WIDTH}
        height={INNER}
        color={props.moving ? COLORS.moving : props.current ? COLORS.cursorChannel : COLORS.channel}
        borderRadius={8}
      >
        <Text x={78} mountX={1} height={INNER} lineHeight={INNER} fontSize={26} color={COLORS.dim}>
          {String(props.number)}
        </Text>
        <FavouriteDot channelId={props.channel.id} x={83} y={INNER / 2} size={9} />
        <Text
          x={96}
          width={CHANNEL_WIDTH - 108}
          height={INNER}
          lineHeight={INNER}
          maxLines={1}
          contain="width"
          fontSize={28}
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
              <View x={props.gridX + cell().x} width={cell().width} height={INNER} color={cell().color}>
                <Text
                  x={14}
                  width={Math.max(0, cell().width - 24)}
                  height={INNER}
                  lineHeight={INNER}
                  maxLines={1}
                  contain="width"
                  fontSize={26}
                  color={COLORS.text}
                >
                  {cell().label}
                </Text>
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
            color={props.focused ? COLORS.focused : COLORS.empty}
          >
            <Text x={14} height={INNER} lineHeight={INNER} fontSize={26} color={COLORS.faint}>
              {kind() === "none" ? $t("live.noGuide") : kind() === "locked" ? $t("live.locked") : ""}
            </Text>
          </View>
        )}
      </Show>
    </>
  );
};
