import { Text, View } from "@solidtv/solid";
import { Show } from "solid-js";
import type { NowAndNext } from "../../data/guideCache";
import { BottomScrim } from "../../components/BottomScrim";
import { ChannelLogo } from "../../components/ChannelLogo";
import { FavouriteDot } from "../../components/FavouriteDot";
import type { Channel } from "../../data/lineup";
import { clockTime, progress, timeRange } from "../../live/format";
import { BOLD, colors, radius } from "../../theme";
import { $t } from "../../translate";

export const BANNER_HEIGHT = 270;
const LOGO_WIDTH = 140;
const LOGO_HEIGHT = 96;
const TEXT_X = 80 + LOGO_WIDTH + 40;
const BAR_WIDTH = 520;

export interface BannerProps {
  channel: Channel;
  number: number;
  guide: NowAndNext;
  now: number;
}

/** The info banner along the bottom of the screen: the channel, and what's on. */
export const Banner = (props: BannerProps) => {
  const current = () => props.guide.now;
  const next = () => props.guide.next;
  return (
    <View y={1080 - BANNER_HEIGHT} width={1920} height={BANNER_HEIGHT}>
      <BottomScrim height={BANNER_HEIGHT} />
      <View
        x={80}
        y={34}
        width={LOGO_WIDTH}
        height={LOGO_HEIGHT}
        borderRadius={radius.medium}
        color={colors.surface}
      >
        <Show
          when={props.channel.logo}
          fallback={
            <Text
              width={LOGO_WIDTH}
              height={LOGO_HEIGHT}
              lineHeight={LOGO_HEIGHT}
              contain="width"
              textAlign="center"
              fontSize={44}
              fontFamily={BOLD}
            >
              {String(props.number)}
            </Text>
          }
        >
          {logo => (
            <ChannelLogo x={12} y={10} width={LOGO_WIDTH - 24} height={LOGO_HEIGHT - 20} src={logo()} />
          )}
        </Show>
      </View>
      <FavouriteDot channelId={props.channel.id} x={TEXT_X - 22} y={70} size={14} />
      <Text x={TEXT_X} y={38} width={1240} maxLines={1} contain="width" fontSize={48} fontFamily={BOLD}>
        {props.channel.logo ? `${props.number}   ${props.channel.name}` : props.channel.name}
      </Text>
      <Text x={1840} y={44} mountX={1} fontSize={44} fontFamily={BOLD}>
        {clockTime(props.now)}
      </Text>
      <Text
        x={1840}
        y={104}
        mountX={1}
        width={300}
        maxLines={1}
        contain="width"
        textAlign="right"
        fontSize={26}
        color={colors.textFaint}
      >
        {props.channel.group ?? ""}
      </Text>
      <Show
        when={current()}
        fallback={
          <Text x={TEXT_X} y={124} fontSize={30} color={colors.textFaint}>
            {props.channel.guideId ? "" : $t("live.noGuide")}
          </Text>
        }
      >
        {programme => (
          <>
            <Text x={TEXT_X} y={118} width={1300} maxLines={1} contain="width" fontSize={34}>
              {`${timeRange(programme().start, programme().stop)}   ${programme().title}`}
            </Text>
            <View x={TEXT_X} y={176} width={BAR_WIDTH} height={6} borderRadius={3} color={colors.track} />
            <View
              x={TEXT_X}
              y={176}
              width={BAR_WIDTH * progress(programme().start, programme().stop, props.now)}
              height={6}
              borderRadius={3}
              color={colors.accent}
            />
          </>
        )}
      </Show>
      <Show when={next()}>
        {programme => (
          <Text
            x={TEXT_X}
            y={200}
            width={1300}
            maxLines={1}
            contain="width"
            fontSize={28}
            color={colors.textDim}
          >
            {$t("live.next", { time: clockTime(programme().start), title: programme().title })}
          </Text>
        )}
      </Show>
    </View>
  );
};
