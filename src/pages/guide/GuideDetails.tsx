import { Text, View } from "@solidtv/solid";
import { Show } from "solid-js";
import type { ProgrammeDetails } from "../../data/guideCodec";
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
  /** The programme's subtitle and description, once read. */
  details?: ProgrammeDetails;
  /** "Today", "Tomorrow" or a date, for the cell's day. */
  day: string;
  now: number;
  /** What OK or the options can do with it, such as playing it from the catch-up. */
  note?: string;
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
    return [shown?.episode, props.details?.subTitle].filter(Boolean).join("  ·  ");
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
            <Show when={props.note}>
              {note => (
                <Text
                  x={onNow() ? 390 : 0}
                  y={140}
                  width={props.width - (onNow() ? 390 : 0)}
                  maxLines={1}
                  contain="width"
                  fontSize={24}
                  color="#7fb2ffff"
                >
                  {note()}
                </Text>
              )}
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
              {props.details?.description ?? ""}
            </Text>
          </>
        )}
      </Show>
    </View>
  );
};
