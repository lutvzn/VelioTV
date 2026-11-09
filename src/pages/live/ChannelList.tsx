import { Text, View } from "@solidtv/solid";
import { ChannelLogo } from "../../components/ChannelLogo";
import { FavouriteDot } from "../../components/FavouriteDot";
import { OVERLAY_Z } from "./ChannelOptions";
import { For, Show } from "solid-js";
import type { NowAndNext } from "../../data/guideCache";
import type { Channel } from "../../data/lineup";
import { timeRange } from "../../live/format";
import { BOLD, colors, radius } from "../../theme";
import { $t, $tn } from "../../translate";

export const LIST_WIDTH = 760;
export const LIST_ROWS = 12;
const ROW_HEIGHT = 72;
const ROWS_Y = 120;
const ROW_WIDTH = LIST_WIDTH - 48;
const SLOTS = Array.from({ length: LIST_ROWS }, (_, slot) => slot);
const LOGO_X = 92;
const LOGO_WIDTH = 64;
const LOGO_HEIGHT = 42;

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
    <View width={LIST_WIDTH} height={1080} color={colors.panel} zIndex={OVERLAY_Z}>
      <View x={LIST_WIDTH - 1} width={1} height={1080} color={colors.line} />
      <Text
        x={40}
        y={44}
        width={LIST_WIDTH - 260}
        maxLines={1}
        contain="width"
        fontSize={32}
        fontFamily={BOLD}
      >
        {`‹   ${props.title}   ›`}
      </Text>
      <Text x={LIST_WIDTH - 40} y={50} mountX={1} fontSize={24} color={colors.textFaint}>
        {$tn("count.channels", props.channels.length)}
      </Text>
      <For each={SLOTS}>
        {slot => (
          <Show when={at(slot)}>
            {channel => {
              const selected = () => props.top + slot === props.cursor;
              const playing = () => channel().id === props.playingId;
              const nameX = () => (channel().logo ? LOGO_X + LOGO_WIDTH + 16 : LOGO_X);
              return (
                <View
                  x={24}
                  y={ROWS_Y + slot * ROW_HEIGHT}
                  width={ROW_WIDTH}
                  height={ROW_HEIGHT - 6}
                  borderRadius={radius.medium}
                  color={selected() ? colors.focus : colors.transparent}
                >
                  <Text
                    x={70}
                    mountX={1}
                    height={ROW_HEIGHT - 6}
                    lineHeight={ROW_HEIGHT - 6}
                    fontSize={26}
                    color={selected() ? colors.onFocus : playing() ? colors.accentText : colors.textFaint}
                  >
                    {String(props.numberOf(channel()))}
                  </Text>
                  <FavouriteDot channelId={channel().id} x={77} y={(ROW_HEIGHT - 6) / 2} size={9} />
                  <Show when={channel().logo}>
                    {logo => (
                      <ChannelLogo
                        x={LOGO_X}
                        y={(ROW_HEIGHT - 6 - LOGO_HEIGHT) / 2}
                        width={LOGO_WIDTH}
                        height={LOGO_HEIGHT}
                        src={logo()}
                      />
                    )}
                  </Show>
                  <Text
                    x={nameX()}
                    width={ROW_WIDTH - nameX() - 20}
                    height={ROW_HEIGHT - 6}
                    lineHeight={ROW_HEIGHT - 6}
                    maxLines={1}
                    contain="width"
                    fontSize={30}
                    fontFamily={selected() || playing() ? BOLD : undefined}
                    color={selected() ? colors.onFocus : playing() ? colors.accentText : colors.text}
                  >
                    {channel().name}
                  </Text>
                </View>
              );
            }}
          </Show>
        )}
      </For>
      <Show when={props.channels.length === 0}>
        <Text x={40} y={ROWS_Y + 20} fontSize={30} color={colors.textDim}>
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
            color={colors.textDim}
          >
            {`${timeRange(programme().start, programme().stop)}   ${programme().title}`}
          </Text>
        )}
      </Show>
    </View>
  );
};
