import { Text, View } from "@solidtv/solid";
import { For } from "solid-js";
import type { TrackRow } from "../../live/trackRows";

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
  <View x={1920 - PANEL_WIDTH} width={PANEL_WIDTH} height={1080} color="#071423f2">
    <For each={props.rows}>
      {(row, at) => (
        <View
          x={24}
          y={ROWS_Y + at() * ROW_HEIGHT}
          width={ROW_WIDTH}
          height={ROW_HEIGHT - 6}
          borderRadius={10}
          color={at() === props.cursor ? "#2e6bd6ff" : "#00000000"}
        >
          <Text
            x={row.type === "heading" ? 16 : 70}
            width={ROW_WIDTH - 90}
            height={ROW_HEIGHT - 6}
            lineHeight={ROW_HEIGHT - 6}
            maxLines={1}
            contain="width"
            fontSize={row.type === "heading" ? 26 : 32}
            color={row.type === "choice" ? "#ffffffff" : "#ffffff99"}
          >
            {row.text}
          </Text>
          <View
            x={32}
            y={(ROW_HEIGHT - 6) / 2 - 9}
            width={18}
            height={18}
            borderRadius={9}
            color="#7fb2ffff"
            alpha={row.type === "choice" && row.selected ? 1 : 0}
          />
        </View>
      )}
    </For>
  </View>
);
