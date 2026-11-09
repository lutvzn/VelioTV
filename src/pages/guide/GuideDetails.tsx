import { Text, View } from "@solidtv/solid";
import { Show } from "solid-js";
import type { ProgrammeDetails } from "../../data/guideCodec";
import type { Channel } from "../../data/lineup";
import type { Cell } from "../../guide/timeline";
import { progress, timeRange } from "../../live/format";
import { BOLD, colors } from "../../theme";
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

/** The most letters of a channel's name its chip shows. */
const CHIP_LETTERS = 48;
const shorten = (text: string, letters: number) =>
  text.length > letters ? `${text.slice(0, letters - 1).trimEnd()}…` : text;

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
      {/* A badge for a programme on now, then the channel. */}
      <View display="flex" flexDirection="row" gap={12} height={40}>
        <Show when={onNow()}>
          <View
            display="flex"
            flexBoundary="contain"
            alignItems="center"
            gap={10}
            padding={[0, 18]}
            height={40}
            borderRadius={20}
            color={colors.live}
          >
            <View width={10} height={10} borderRadius={5} color={colors.onLive} />
            <Text fontSize={20} fontFamily={BOLD} letterSpacing={2} color={colors.onLive}>
              {$t("guide.liveNow").toUpperCase()}
            </Text>
          </View>
        </Show>
        <Show when={props.channel}>
          {channel => (
            <View
              display="flex"
              flexBoundary="contain"
              alignItems="center"
              padding={[0, 18]}
              height={40}
              borderRadius={20}
              color={colors.surfaceRaised}
            >
              {/* Sized by its words, so a long name is cut short here. */}
              <Text maxLines={1} fontSize={22} fontFamily={BOLD}>
                {`${props.number ?? ""}  ·  ${shorten(channel().name, CHIP_LETTERS)}`}
              </Text>
            </View>
          )}
        </Show>
      </View>
      <Show
        when={programme()}
        fallback={
          <Text
            y={62}
            width={props.width}
            maxLines={1}
            contain="width"
            fontSize={36}
            color={colors.textFaint}
          >
            {emptyText()}
          </Text>
        }
      >
        {shown => (
          <>
            <Text
              y={54}
              width={props.width}
              maxLines={1}
              contain="width"
              lineHeight={64}
              fontSize={52}
              fontFamily={BOLD}
            >
              {shown().title}
            </Text>
            <Text
              y={126}
              width={props.width}
              maxLines={1}
              contain="width"
              fontSize={26}
              color={colors.textDim}
            >
              {`${props.day}   ${timeRange(shown().start, shown().stop)}${extra() ? `   ${extra()}` : ""}`}
            </Text>
            <Show when={onNow()}>
              <View y={173} width={360} height={6} borderRadius={3} color={colors.track} />
              <View
                y={173}
                width={360 * progress(shown().start, shown().stop, props.now)}
                height={6}
                borderRadius={3}
                color={colors.accent}
              />
            </Show>
            <Show when={props.note}>
              {note => (
                <Text
                  x={onNow() ? 390 : 0}
                  y={160}
                  width={props.width - (onNow() ? 390 : 0)}
                  maxLines={1}
                  contain="width"
                  fontSize={24}
                  color={colors.accentText}
                >
                  {note()}
                </Text>
              )}
            </Show>
            <Text
              y={200}
              width={props.width}
              maxLines={3}
              contain="width"
              lineHeight={36}
              fontSize={26}
              color={colors.textDim}
            >
              {props.details?.description ?? ""}
            </Text>
          </>
        )}
      </Show>
    </View>
  );
};
