import { Text, View } from "@solidtv/solid";
import { Show } from "solid-js";
import type { NowAndNext } from "../../data/guideCache";
import type { Channel } from "../../data/lineup";
import { clockTime, progress, timeRange } from "../../live/format";
import { $t } from "../../translate";

export const BANNER_HEIGHT = 270;
const TEXT_X = 260;
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
    <View y={1080 - BANNER_HEIGHT} width={1920} height={BANNER_HEIGHT} color="#071423eb">
      <Text x={80} y={36} width={160} contain="width" fontSize={56} fontFamily="NotoSans700">
        {String(props.number)}
      </Text>
      <Text x={TEXT_X} y={40} width={1240} maxLines={1} contain="width" fontSize={48}>
        {props.channel.name}
      </Text>
      <Text x={1840} y={44} mountX={1} fontSize={44}>
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
        color="#ffffff99"
      >
        {props.channel.group ?? ""}
      </Text>
      <Show
        when={current()}
        fallback={
          <Text x={TEXT_X} y={124} fontSize={30} color="#ffffff99">
            {props.channel.guideId ? "" : $t("live.noGuide")}
          </Text>
        }
      >
        {programme => (
          <>
            <Text x={TEXT_X} y={120} width={1300} maxLines={1} contain="width" fontSize={36}>
              {`${timeRange(programme().start, programme().stop)}   ${programme().title}`}
            </Text>
            <View x={TEXT_X} y={176} width={BAR_WIDTH} height={6} borderRadius={3} color="#ffffff33" />
            <View
              x={TEXT_X}
              y={176}
              width={BAR_WIDTH * progress(programme().start, programme().stop, props.now)}
              height={6}
              borderRadius={3}
              color="#7fb2ffff"
            />
          </>
        )}
      </Show>
      <Show when={next()}>
        {programme => (
          <Text x={TEXT_X} y={200} width={1300} maxLines={1} contain="width" fontSize={28} color="#ffffffb3">
            {$t("live.next", { time: clockTime(programme().start), title: programme().title })}
          </Text>
        )}
      </Show>
    </View>
  );
};
