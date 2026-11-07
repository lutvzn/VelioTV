import { Text, View } from "@solidtv/solid";
import { Show } from "solid-js";
import type { Channel } from "../../data/lineup";
import type { Cell } from "../../guide/timeline";
import { progress, timeRange } from "../../live/format";
import { $t } from "../../translate";

export interface GuideDetailsProps {
  x: number;
  y: number;
  width: number;
  channel?: Channel;
  number?: number;
  cell?: Cell;
  /** "Today", "Tomorrow" or a date, for the cell's day. */
  day: string;
  now: number;
}

/** The highlighted programme, beside the preview: its title, time and description. */
export const GuideDetails = (props: GuideDetailsProps) => {
  const programme = () => props.cell?.programme;
  const onNow = () => {
    const shown = programme();
    return !!shown && shown.start <= props.now && shown.stop > props.now;
  };
  const emptyText = () => {
    const kind = props.cell?.kind;
    if (kind === "none") return $t("live.noGuide");
    if (kind === "gap") return $t("guide.noInformation");
    if (kind === "locked") return $t("pin.lockedHint");
    return "";
  };
  const extra = () => {
    const shown = programme();
    return [shown?.episode, shown?.subTitle].filter(Boolean).join("  ·  ");
  };

  return (
    <View x={props.x} y={props.y} width={props.width} height={330}>
      <Text width={props.width} maxLines={1} contain="width" fontSize={28} color="#ffffffb3">
        {props.channel ? `${props.number ?? ""}   ${props.channel.name}` : ""}
      </Text>
      <Show
        when={programme()}
        fallback={
          <Text y={50} width={props.width} maxLines={1} contain="width" fontSize={36} color="#ffffff99">
            {emptyText()}
          </Text>
        }
      >
        {shown => (
          <>
            <Text
              y={44}
              width={props.width}
              maxLines={1}
              contain="width"
              fontSize={42}
              fontFamily="NotoSans700"
            >
              {shown().title}
            </Text>
            <Text y={106} width={props.width} maxLines={1} contain="width" fontSize={28} color="#ffffffcc">
              {`${props.day}   ${timeRange(shown().start, shown().stop)}${extra() ? `   ${extra()}` : ""}`}
            </Text>
            <Show when={onNow()}>
              <View y={152} width={360} height={6} borderRadius={3} color="#ffffff33" />
              <View
                y={152}
                width={360 * progress(shown().start, shown().stop, props.now)}
                height={6}
                borderRadius={3}
                color="#7fb2ffff"
              />
            </Show>
            <Text
              y={176}
              width={props.width}
              maxLines={4}
              contain="width"
              lineHeight={36}
              fontSize={26}
              color="#ffffffb3"
            >
              {shown().description ?? ""}
            </Text>
          </>
        )}
      </Show>
    </View>
  );
};
