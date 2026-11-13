import { activeElement, type ElementNode, Text, View } from "@solidtv/solid";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { Fill } from "../../components/Fill";
import { exposeToProbes } from "../../devHooks";
import { addons } from "../../library";
import { type ChosenStream, chosenStreams } from "../../play/addonPlay";
import type { TitleChoice } from "../../play/titlePlay";
import type { FoundStreams, TitleType } from "../../stremio/addons";
import { BOLD, colors, dialogShadow, radius } from "../../theme";
import { $t, $tn } from "../../translate";
import { sayWhileFocused } from "../../voiceGuide";
import { OVERLAY_Z } from "../live/ChannelOptions";

const WIDTH = 1200;
const HEIGHT = 820;
const ROW_HEIGHT = 104;
const ROWS_Y = 130;
const SHOWN = 6;
const ROW_WIDTH = WIDTH - 80;

/** One of a title's IPTV copies, as a row. */
export interface PickerLink<L> {
  link: L;
  /** Such as the source's name and the provider's name for it. */
  text: string;
  /** Such as the file's kind. */
  detail: string;
}

export interface StreamPickerProps<L> {
  /** What's being played, as its heading. */
  title: string;
  type: TitleType;
  /** The film's, or the episode's, id in Stremio; without one the add-ons aren't asked. */
  id?: string;
  /** The title's IPTV copies, listed first (PLAN.md, "Movies and Series by title", step 5). */
  links?: PickerLink<L>[];
  onPick: (choice: TitleChoice<L>) => void;
  onClose: () => void;
}

interface Row<L> {
  text: string;
  detail: string;
  choice: TitleChoice<L>;
}

/** Why nothing can be played: what the add-ons had that the TV can't. */
const noneText = (found: FoundStreams[]) => {
  const lines = [$t("stremio.noStreams")];
  const unplayable = found.reduce((sum, one) => sum + one.unplayable, 0);
  const referer = found.reduce((sum, one) => sum + one.needReferer, 0);
  if (unplayable) lines.push($tn("stremio.unplayable", unplayable));
  if (referer) lines.push($tn("stremio.needReferer", referer));
  for (const one of found)
    if (one.problem) lines.push($t("stremio.addonFailed", { addon: one.addonName, problem: one.problem }));
  if (found.length === 0) lines.push($t("stremio.noAddonStreams"));
  return lines.join("\n");
};

/** The first line of a stream's description, which add-ons fill with the file's name and size. */
const firstLine = (text: string) => text.split("\n")[0] ?? "";

/** The add-on and the stream's name. */
const rowText = (chosen: ChosenStream) =>
  chosen.stream.name ? `${chosen.addonName} · ${chosen.stream.name.replace(/\n/g, " ")}` : chosen.addonName;

/**
 * A film's or an episode's links, over its page: its IPTV copies, then the
 * add-ons' streams (PLAN.md, "Stremio add-ons", step 5). Up and Down move,
 * OK plays, Back closes. Each row is the source or add-on and the stream's
 * name, with its description below.
 */
export const StreamPicker = <L,>(props: StreamPickerProps<L>) => {
  const before: ElementNode | undefined = activeElement();
  let box: ElementNode | undefined;
  const [found, setFound] = createSignal<FoundStreams[] | undefined>(props.id ? undefined : []);
  const [cursor, setCursor] = createSignal(0);
  const streams = createMemo(() => chosenStreams(found() ?? []));
  const rows = createMemo((): Row<L>[] => [
    ...(props.links ?? []).map(one => ({
      text: one.text,
      detail: one.detail,
      choice: { kind: "iptv" as const, link: one.link },
    })),
    ...streams().map(chosen => ({
      text: rowText(chosen),
      detail: chosen.stream.silent
        ? `${$t("stremio.noSound")} · ${firstLine(chosen.stream.description)}`
        : firstLine(chosen.stream.description),
      choice: { kind: "addon" as const, chosen },
    })),
  ]);
  const top = () => Math.max(0, Math.min(cursor() - SHOWN + 2, rows().length - SHOWN));

  onMount(() => {
    box?.setFocus();
    const id = props.id;
    if (!id) return;
    addons
      .streams(props.type, id)
      .then(setFound)
      .catch(() => setFound([]));
  });
  const close = () => {
    props.onClose();
    before?.setFocus();
  };
  const move = (step: number) => {
    const count = rows().length;
    if (count) setCursor(Math.max(0, Math.min(count - 1, cursor() + step)));
    return true;
  };
  const status = () =>
    rows().length ? "" : found() === undefined ? $t("stremio.finding") : noneText(found() ?? []);
  /** Under the rows, while the add-ons are still asked. */
  const stillFinding = () => rows().length > 0 && found() === undefined;

  sayWhileFocused(
    () => true,
    () => {
      const shown = rows()[cursor()];
      if (shown) return [props.title, shown.text, shown.detail];
      return [props.title, status()];
    },
  );
  exposeToProbes("streamPicker", { found, streams, rows, cursor, setCursor, pick: () => pick() });

  const pick = () => {
    const row = rows()[cursor()];
    if (row) props.onPick(row.choice);
    return true;
  };

  return (
    <View
      ref={element => (box = element)}
      id="streamPicker"
      announce=""
      zIndex={OVERLAY_Z + 1}
      x={(1920 - WIDTH) / 2}
      y={(1080 - HEIGHT) / 2}
      width={WIDTH}
      height={HEIGHT}
      borderRadius={radius.xlarge}
      color={colors.dialog}
      border={{ width: 1, color: colors.line }}
      shadow={dialogShadow}
      onUp={() => move(-1)}
      onDown={() => move(1)}
      onEnter={pick}
      onBack={() => {
        close();
        return true;
      }}
      // Every other key stops here.
      onKeyPress={() => true}
    >
      <Text x={40} y={40} width={WIDTH - 80} maxLines={1} contain="width" fontSize={38} fontFamily={BOLD}>
        {props.title}
      </Text>
      <Show when={status()}>
        <Text
          x={40}
          y={ROWS_Y}
          width={WIDTH - 80}
          contain="width"
          maxLines={8}
          lineHeight={46}
          fontSize={30}
          color={colors.textDim}
        >
          {status()}
        </Text>
      </Show>
      <Show when={stillFinding()}>
        <Text
          x={40}
          y={HEIGHT - 64}
          width={WIDTH - 80}
          contain="width"
          maxLines={1}
          fontSize={24}
          color={colors.textFaint}
        >
          {$t("stremio.finding")}
        </Text>
      </Show>
      <For each={rows().slice(top(), top() + SHOWN)}>
        {(row, at) => {
          const index = () => top() + at();
          const focused = () => index() === cursor();
          return (
            <View x={40} y={ROWS_Y + at() * ROW_HEIGHT} width={ROW_WIDTH} height={ROW_HEIGHT - 8}>
              <Fill
                width={ROW_WIDTH}
                height={ROW_HEIGHT - 8}
                borderRadius={radius.medium}
                color={focused() ? colors.focus : colors.transparent}
              />
              <Text
                x={24}
                y={12}
                width={ROW_WIDTH - 48}
                maxLines={1}
                contain="width"
                fontSize={30}
                fontFamily={BOLD}
                color={focused() ? colors.onFocus : colors.text}
              >
                {row.text}
              </Text>
              <Text
                x={24}
                y={54}
                width={ROW_WIDTH - 48}
                maxLines={1}
                contain="width"
                fontSize={24}
                color={focused() ? colors.onFocus : colors.textDim}
              >
                {row.detail}
              </Text>
            </View>
          );
        }}
      </For>
    </View>
  );
};
