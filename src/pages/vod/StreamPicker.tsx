import { activeElement, type ElementNode, Text, View } from "@solidtv/solid";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Fill } from "../../components/Fill";
import { exposeToProbes } from "../../devHooks";
import { addons, lastLinks, playChoices } from "../../library";
import { type ChosenStream, chosenStreams, streamText } from "../../play/addonPlay";
import { autoPick, autoPlayable, type Candidate } from "../../play/autoPlay";
import type { AutoPicked, TitleChoice } from "../../play/titlePlay";
import type { FoundStreams, StreamSearch, TitleType } from "../../stremio/addons";
import type { FileQuality } from "../../data/vod";
import { heightLabel, qualityLabel, sizeLabel } from "../../stremio/streamText";
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
/** Room on a row's right for its quality and size. */
const LABEL_WIDTH = 240;
/** How long the picker shows what auto-play will play, so a key can stop it. */
export const AUTO_PLAY_WAIT_MS = 1500;

/** One of a title's copies from the TV's sources, as a row. */
export interface PickerLink<L> {
  link: L;
  /** Such as the source's name and the provider's name for it. */
  text: string;
  /** Such as the file's kind. */
  detail: string;
  /** What's known of the file now, such as the height its name gives ("Film 4K"). */
  quality?: FileQuality;
  /** What the source's server says of the file, asked for when the picker opens. */
  details?: () => Promise<FileQuality>;
}

export interface StreamPickerProps<L> {
  /** What's being played, as its heading. */
  title: string;
  type: TitleType;
  /** The film's, or the episode's, id in Stremio; without one the add-ons aren't asked. */
  id?: string;
  /** The title's copies from the TV's sources, listed first (PLAN.md, "Movies and Series by title", step 5). */
  links?: PickerLink<L>[];
  /**
   * The film's or episode's key in the resume list (src/data/watched.ts), to
   * play the add-on link it last played again ("Play the last link again").
   */
  itemKey?: string;
  /**
   * `auto` is set when it was picked without a key (auto-play, or the last
   * link again): the others it would play, to try if this one doesn't start.
   */
  onPick: (choice: TitleChoice<L>, auto?: AutoPicked<L>) => void;
  onClose: () => void;
}

interface Row<L> {
  /** Stays the same as more streams come, so the cursor keeps to it. */
  key: string;
  text: string;
  detail: string;
  /** Such as "4K  2.1 GB". */
  label: string;
  choice: TitleChoice<L>;
  /** The text auto-play's pattern is matched against. */
  match: string;
  /** Nothing still to come would be listed before it. */
  settled: boolean;
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

/** "4K  2.1 GB": what the stream's text says of its picture and size. */
const labelOf = (chosen: ChosenStream) =>
  [heightLabel(chosen.stream.height), sizeLabel(chosen.stream.sizeBytes)].filter(Boolean).join("  ");

const streamKey = (chosen: ChosenStream) => `${chosen.addon} ${chosen.stream.url}`;

/**
 * Whether nothing could still come before this stream: every add-on before
 * its own has answered, or all have for one listed last for its sound.
 */
const isSettled = (search: StreamSearch, chosen: ChosenStream) => {
  if (search.done) return true;
  if (chosen.stream.silent) return false;
  const at = search.asked.indexOf(chosen.addon);
  return !search.waiting.some(addon => search.asked.indexOf(addon) < at);
};

/**
 * A film's or an episode's links, over its page: its sources' copies, then the
 * add-ons' streams (PLAN.md, "Stremio add-ons", step 5). Up and Down move,
 * OK plays, Back closes. Each row is the source or add-on and the stream's
 * name, with its description below.
 */
export const StreamPicker = <L,>(props: StreamPickerProps<L>) => {
  const before: ElementNode | undefined = activeElement();
  let box: ElementNode | undefined;
  const [search, setSearch] = createSignal<StreamSearch>({
    found: [],
    done: !props.id,
    asked: [],
    waiting: [],
  });
  const found = () => (search().done ? search().found : undefined);
  const [cursor, setCursor] = createSignal(0);
  const streams = createMemo(() => chosenStreams(search().found));
  // What the sources' servers say of their files, by the link's place.
  const [told, setTold] = createSignal<(FileQuality | undefined)[]>([]);
  onMount(() =>
    (props.links ?? []).forEach((one, at) => {
      void one
        .details?.()
        .then(quality =>
          setTold(list => {
            const next = list.slice();
            next[at] = quality;
            return next;
          }),
        )
        .catch(() => undefined);
    }),
  );
  const rows = createMemo((): Row<L>[] => [
    ...(props.links ?? []).map((one, at) => {
      const known = one.quality ?? {};
      const server = told()[at] ?? {};
      return {
        key: `source ${at}`,
        text: one.text,
        detail: one.detail,
        label: qualityLabel({
          height: server.height ?? known.height,
          estimatedBytes: server.estimatedBytes ?? known.estimatedBytes,
        }),
        choice: { kind: "source" as const, link: one.link },
        // What it's known as when the picker opens, so auto-play's pick doesn't change under it.
        match: `${one.text} ${one.detail} ${qualityLabel(known)}`.trim(),
        settled: true,
      };
    }),
    ...streams().map(chosen => ({
      key: streamKey(chosen),
      text: rowText(chosen),
      detail: chosen.stream.silent
        ? `${$t("stremio.noSound")} · ${firstLine(chosen.stream.description)}`
        : firstLine(chosen.stream.description),
      label: labelOf(chosen),
      choice: { kind: "addon" as const, chosen },
      match: streamText(chosen),
      settled: isSettled(search(), chosen),
    })),
  ]);
  // Streams that come in above the cursor's row don't move it off that row.
  createEffect(
    on(rows, (now, was) => {
      const under = was?.[cursor()]?.key;
      if (under === undefined) return;
      const at = now.findIndex(row => row.key === under);
      if (at >= 0 && at !== cursor()) setCursor(at);
    }),
  );
  const top = () => Math.max(0, Math.min(cursor() - SHOWN + 2, rows().length - SHOWN));

  // Auto-play, or the last link again: what it will play, shown for a
  // moment, unless a key is pressed first.
  const [autoOn, setAutoOn] = createSignal(true);
  const choices = playChoices.choices();
  const reused = (() => {
    if (!choices.reuseLast || !props.itemKey) return undefined;
    const link = lastLinks.find(props.itemKey);
    return link ? { addon: link.addon, addonName: link.addonName, stream: link.stream } : undefined;
  })();
  const candidates = (): Candidate<Row<L>>[] =>
    rows().map(row => ({ choice: row, text: row.match, settled: row.settled }));
  const autoRow = createMemo((): Row<L> | undefined => {
    if (!autoOn()) return undefined;
    if (reused) {
      const chosen: ChosenStream = reused;
      return {
        key: streamKey(chosen),
        text: rowText(chosen),
        detail: firstLine(chosen.stream.description),
        label: labelOf(chosen),
        choice: { kind: "addon", chosen },
        match: streamText(chosen),
        settled: true,
      };
    }
    return autoPick(candidates(), choices)?.choice;
  });
  /** The rows auto-play would try after `picked`, once every add-on has answered. */
  const othersAfter = (picked: Row<L>) => async (): Promise<TitleChoice<L>[]> => {
    if (props.id) await addons.streams(props.type, props.id).catch(() => []);
    const all = autoPlayable(
      candidates().map(one => ({ ...one, settled: true })),
      // The last link again tries the first streams after it, as auto-play "first" would.
      choices.autoPlay === "off" ? { ...choices, autoPlay: "first" } : choices,
    );
    return all
      .filter(one => one.choice.key !== picked.key)
      .slice(0, choices.fallbacks)
      .map(one => one.choice.choice);
  };
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  // By its key, as the rows are made again at each answer.
  const autoKey = createMemo(() => autoRow()?.key);
  createEffect(
    on(autoKey, key => {
      clearTimeout(autoTimer);
      if (key === undefined) return;
      autoTimer = setTimeout(() => {
        const row = autoRow();
        if (row && row.key === key) props.onPick(row.choice, { others: othersAfter(row) });
      }, AUTO_PLAY_WAIT_MS);
    }),
  );
  onCleanup(() => clearTimeout(autoTimer));
  /** A key stops auto-play for this time. */
  const stopAuto = () => {
    if (!autoOn()) return;
    setAutoOn(false);
    clearTimeout(autoTimer);
  };

  onMount(() => {
    box?.setFocus();
    const id = props.id;
    if (!id) return;
    onCleanup(addons.watchStreams(props.type, id, setSearch));
  });
  const close = () => {
    props.onClose();
    before?.setFocus();
  };
  const move = (step: number) => {
    stopAuto();
    const count = rows().length;
    if (count) setCursor(Math.max(0, Math.min(count - 1, cursor() + step)));
    return true;
  };
  const status = () =>
    rows().length ? "" : found() === undefined ? $t("stremio.finding") : noneText(found() ?? []);
  /** Under the rows: what auto-play will play, or that the add-ons are still asked. */
  const footer = () => {
    const auto = autoRow();
    if (auto) return $t("stremio.autoPlaying", { name: auto.text });
    if (autoOn() && (choices.autoPlay !== "off" || reused) && rows().length > 0 && !search().done)
      return $t("stremio.autoWaiting");
    return rows().length > 0 && !search().done ? $t("stremio.finding") : "";
  };

  sayWhileFocused(
    () => true,
    () => {
      const auto = autoRow();
      if (auto) return [props.title, footer()];
      const shown = rows()[cursor()];
      if (shown) return [props.title, shown.text, shown.label, shown.detail];
      return [props.title, status()];
    },
  );
  exposeToProbes("streamPicker", {
    found,
    search,
    streams,
    rows,
    cursor,
    setCursor,
    autoRow,
    stopAuto,
    pick: () => pick(),
  });

  const pick = () => {
    stopAuto();
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
      // Every other key stops here, and stops auto-play.
      onKeyPress={() => {
        stopAuto();
        return true;
      }}
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
      <Show when={footer()}>
        <Text
          x={40}
          y={HEIGHT - 64}
          width={WIDTH - 80}
          contain="width"
          maxLines={1}
          fontSize={24}
          color={colors.textFaint}
        >
          {footer()}
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
                width={ROW_WIDTH - 48 - (row.label ? LABEL_WIDTH : 0)}
                maxLines={1}
                contain="width"
                fontSize={30}
                fontFamily={BOLD}
                color={focused() ? colors.onFocus : colors.text}
              >
                {row.text}
              </Text>
              <Show when={row.label}>
                <Text
                  x={ROW_WIDTH - 24}
                  mountX={1}
                  y={14}
                  maxLines={1}
                  fontSize={26}
                  fontFamily={BOLD}
                  color={focused() ? colors.onFocus : colors.accentText}
                >
                  {row.label}
                </Text>
              </Show>
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
