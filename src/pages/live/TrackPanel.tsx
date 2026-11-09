import { Text, View } from "@solidtv/solid";
import { For } from "solid-js";
import type { TrackRow } from "../../live/trackRows";
import { BOLD, colors, radius } from "../../theme";
import { OVERLAY_Z } from "./ChannelOptions";

export const PANEL_WIDTH = 640;
const ROW_HEIGHT = 66;
const ROWS_Y = 60;
const ROW_WIDTH = PANEL_WIDTH - 48;

export interface TrackPanelProps {
  rows: TrackRow[];
  cursor: number;
}

/**
 * The audio and subtitle choices, down the right of the screen over the
 * video. The page moves the cursor; this only draws. A dot marks what's
 * playing or showing.
 */
export const TrackPanel = (props: TrackPanelProps) => (
  <View x={1920 - PANEL_WIDTH} width={PANEL_WIDTH} height={1080} color={colors.panel} zIndex={OVERLAY_Z}>
    <View width={1} height={1080} color={colors.line} />
    <For each={props.rows}>
      {(row, at) => (
        <View
          x={24}
          y={ROWS_Y + at() * ROW_HEIGHT}
          width={ROW_WIDTH}
          height={ROW_HEIGHT - 6}
          borderRadius={radius.medium}
          color={at() === props.cursor ? colors.focus : colors.transparent}
        >
          <Text
            x={row.type === "heading" ? 16 : 70}
            width={ROW_WIDTH - 90}
            height={ROW_HEIGHT - 6}
            lineHeight={ROW_HEIGHT - 6}
            maxLines={1}
            contain="width"
            fontSize={row.type === "heading" ? 24 : 30}
            fontFamily={row.type === "heading" ? BOLD : undefined}
            color={
              at() === props.cursor
                ? colors.onFocus
                : row.type === "choice"
                  ? colors.text
                  : row.type === "heading"
                    ? colors.accentText
                    : colors.textFaint
            }
          >
            {row.text}
          </Text>
          <View
            x={32}
            y={(ROW_HEIGHT - 6) / 2 - 9}
            width={18}
            height={18}
            borderRadius={9}
            color={at() === props.cursor ? colors.onFocus : colors.accent}
            alpha={row.type === "choice" && row.selected ? 1 : 0}
          />
        </View>
      )}
    </For>
  </View>
);
