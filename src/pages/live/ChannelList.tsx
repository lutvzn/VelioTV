import { Text, View } from "@solidtv/solid";
import { For, Show } from "solid-js";
import type { NowAndNext } from "../../data/guideCache";
import type { Channel } from "../../data/lineup";
import { timeRange } from "../../live/format";
import { $t } from "../../translate";

export const LIST_WIDTH = 760;
export const LIST_ROWS = 12;
const ROW_HEIGHT = 72;
const ROWS_Y = 120;
const ROW_WIDTH = LIST_WIDTH - 48;
const SLOTS = Array.from({ length: LIST_ROWS }, (_, slot) => slot);

export interface ChannelListProps {
  /** The group's name as shown. */
  title: string;
  channels: Channel[];
  cursor: number;
  /** The first row drawn; see src/live/listWindow.ts. */
  top: number;
  playingId?: string;
  numberOf: (channel: Channel) => number;
  /** What's on the channel at the cursor. */
  guide: NowAndNext;
}

/**
 * The channel list over the video, down the left of the screen. It draws
 * LIST_ROWS rows and fills them from `top`, rather than a row per channel.
 * The page moves the cursor; this only draws.
 */
export const ChannelList = (props: ChannelListProps) => {
  const at = (slot: number) => props.channels[props.top + slot] as Channel | undefined;
  const current = () => props.guide.now;
  return (
    <View width={LIST_WIDTH} height={1080} color="#071423f2">
      <Text x={40} y={40} width={LIST_WIDTH - 260} maxLines={1} contain="width" fontSize={36}>
        {`‹  ${props.title}  ›`}
      </Text>
      <Text x={LIST_WIDTH - 40} y={48} mountX={1} fontSize={26} color="#ffffff99">
        {$t("live.channelCount", { count: props.channels.length })}
      </Text>
      <For each={SLOTS}>
        {slot => (
          <Show when={at(slot)}>
            {channel => (
              <View
                x={24}
                y={ROWS_Y + slot * ROW_HEIGHT}
                width={ROW_WIDTH}
                height={ROW_HEIGHT - 6}
                borderRadius={10}
                color={props.top + slot === props.cursor ? "#2e6bd6ff" : "#00000000"}
              >
                <Text
                  x={100}
                  mountX={1}
                  height={ROW_HEIGHT - 6}
                  lineHeight={ROW_HEIGHT - 6}
                  fontSize={28}
                  color="#ffffffb3"
                >
                  {String(props.numberOf(channel()))}
                </Text>
                <Text
                  x={130}
                  width={ROW_WIDTH - 150}
                  height={ROW_HEIGHT - 6}
                  lineHeight={ROW_HEIGHT - 6}
                  maxLines={1}
                  contain="width"
                  fontSize={32}
                  color={channel().id === props.playingId ? "#7fb2ffff" : "#ffffffff"}
                >
                  {channel().name}
                </Text>
              </View>
            )}
          </Show>
        )}
      </For>
      <Show when={props.channels.length === 0}>
        <Text x={40} y={ROWS_Y + 20} fontSize={30} color="#ffffffb3">
          {$t("live.groupEmpty")}
        </Text>
      </Show>
      <Show when={current()}>
        {programme => (
          <Text
            x={40}
            y={ROWS_Y + LIST_ROWS * ROW_HEIGHT + 20}
            width={LIST_WIDTH - 80}
            maxLines={1}
            contain="width"
            fontSize={26}
            color="#ffffffcc"
          >
            {`${timeRange(programme().start, programme().stop)}   ${programme().title}`}
          </Text>
        )}
      </Show>
    </View>
  );
};
