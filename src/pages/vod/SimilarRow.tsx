import { activeElement, type ElementNode, Text, View } from "@solidtv/solid";
import { createResource, createSignal, For, onMount, Show } from "solid-js";
import { Artwork } from "../../components/Artwork";
import { MENU_WIDTH } from "../../components/SideMenu";
import type { Similar } from "../../data/moreLikeThis";
import { exposeToProbes } from "../../devHooks";
import { BOLD, colors, radius } from "../../theme";
import { $t } from "../../translate";
import { sayWhileFocused } from "../../voiceGuide";
import { OVERLAY_Z } from "../live/ChannelOptions";

// "More like this" (PLAN.md, "Movies and Series by title"): a row of the
// titles TMDB recommends, over the bottom of a film's or series' page.
// Left and Right move, OK opens one, Back closes the row.

const PAGE_WIDTH = 1920 - MENU_WIDTH;
const HEIGHT = 470;
const LEFT = 80;
const POSTER_WIDTH = 200;
const POSTER_HEIGHT = 300;
const GAP = 28;
const STEP = POSTER_WIDTH + GAP;
const SHOWN = Math.floor((PAGE_WIDTH - 2 * LEFT + GAP) / STEP);
const ROW_Y = 96;

export const SimilarRow = (props: {
  load: () => Promise<Similar[]>;
  onPick: (one: Similar) => void;
  onClose: () => void;
}) => {
  const before: ElementNode | undefined = activeElement();
  let box: ElementNode | undefined;
  const [found] = createResource(() => props.load().catch((): Similar[] => []));
  const items = () => found() ?? [];
  const [cursor, setCursor] = createSignal(0);
  const left = () => Math.max(0, Math.min(cursor() - SHOWN + 2, items().length - SHOWN));
  onMount(() => box?.setFocus());
  const close = () => {
    props.onClose();
    before?.setFocus();
  };
  const move = (step: number) => {
    const count = items().length;
    if (count) setCursor(Math.max(0, Math.min(count - 1, cursor() + step)));
    return true;
  };
  const status = () =>
    found.loading ? $t("live.loading") : items().length === 0 ? $t("vod.nothingSimilar") : "";
  sayWhileFocused(
    () => true,
    () => {
      const one = items()[cursor()];
      return one ? [$t("vod.moreLikeThis"), one.title, one.year ? String(one.year) : undefined] : status();
    },
  );
  exposeToProbes("similarRow", { items, cursor, setCursor });

  return (
    <View
      ref={element => (box = element)}
      announce=""
      zIndex={OVERLAY_Z + 2}
      y={1080 - HEIGHT}
      width={PAGE_WIDTH}
      height={HEIGHT}
      color={colors.dialog}
      onLeft={() => move(-1)}
      onRight={() => move(1)}
      onUp={() => true}
      onDown={() => true}
      onEnter={() => {
        const one = items()[cursor()];
        if (one) props.onPick(one);
        return true;
      }}
      onBack={() => {
        close();
        return true;
      }}
      onKeyPress={() => true}
    >
      <Text x={LEFT} y={30} fontSize={34} fontFamily={BOLD}>
        {$t("vod.moreLikeThis")}
      </Text>
      <Show when={status()}>
        <Text x={LEFT} y={ROW_Y + 20} fontSize={30} color={colors.textDim}>
          {status()}
        </Text>
      </Show>
      <For each={items()}>
        {(one, at) => {
          const slot = () => at() - left();
          const selected = () => at() === cursor();
          return (
            <Show when={slot() >= 0 && slot() < SHOWN}>
              <View
                x={LEFT + slot() * STEP - 6}
                y={ROW_Y - 6}
                width={POSTER_WIDTH + 12}
                height={POSTER_HEIGHT + 12}
                borderRadius={radius.large + 4}
                color={selected() ? colors.focus : colors.dialog}
              />
              <Artwork
                x={LEFT + slot() * STEP}
                y={ROW_Y}
                width={POSTER_WIDTH}
                height={POSTER_HEIGHT}
                borderRadius={radius.large}
                src={one.poster}
                title={one.title}
                fontSize={26}
              />
              <Text
                x={LEFT + slot() * STEP}
                y={ROW_Y + POSTER_HEIGHT + 14}
                width={POSTER_WIDTH}
                maxLines={1}
                contain="width"
                fontSize={22}
                fontFamily={selected() ? BOLD : undefined}
                color={selected() ? colors.text : colors.textDim}
              >
                {one.year ? `${one.title} (${one.year})` : one.title}
              </Text>
            </Show>
          );
        }}
      </For>
    </View>
  );
};
