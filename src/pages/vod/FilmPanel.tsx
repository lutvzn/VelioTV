import { type ElementNode, Text, View } from "@solidtv/solid";
import { createMemo, createResource, createSignal, Index, onMount, Show } from "solid-js";
import { MENU_WIDTH } from "../../components/SideMenu";
import type { FilmDetails } from "../../data/vod";
import type { FilmEntry } from "../../data/vodLibrary";
import { exposeToProbes } from "../../devHooks";
import { vod, watched } from "../../library";
import { duration } from "../../live/format";
import { $t } from "../../translate";
import { OVERLAY_Z } from "../live/ChannelOptions";

const PAGE_WIDTH = 1920 - MENU_WIDTH;
const LEFT = 60;
const POSTER_WIDTH = 360;
const POSTER_HEIGHT = 540;
const TEXT_X = LEFT + POSTER_WIDTH + 60;
const TEXT_WIDTH = PAGE_WIDTH - TEXT_X - LEFT;
const BUTTON_HEIGHT = 70;
const BUTTON_WIDTH = 520;

export interface Action {
  id: string;
  label: string;
  run: () => void;
}

/** A column of buttons; Up and Down move, OK presses. The panel passes it the keys. */
export const ActionList = (props: {
  actions: Action[];
  cursor: number;
  focused: boolean;
  x: number;
  y: number;
}) => (
  <Index each={props.actions}>
    {(action, at) => (
      <View
        x={props.x}
        y={props.y + at * (BUTTON_HEIGHT + 16)}
        width={BUTTON_WIDTH}
        height={BUTTON_HEIGHT}
        borderRadius={12}
        color={props.focused && at === props.cursor ? "#2e6bd6ff" : "#ffffff14"}
      >
        <Text
          x={28}
          width={BUTTON_WIDTH - 56}
          height={BUTTON_HEIGHT}
          lineHeight={BUTTON_HEIGHT}
          maxLines={1}
          contain="width"
          fontSize={30}
        >
          {action().label}
        </Text>
      </View>
    )}
  </Index>
);

/**
 * A film's page, over the grid: its poster, details from the server, and
 * Play, or Resume and Play from the start when it was left partway.
 */
export const FilmPanel = (props: {
  film: FilmEntry;
  onClose: () => void;
  onPlay: (startMs?: number) => void;
}) => {
  let root: ElementNode | undefined;
  const [focused, setFocused] = createSignal(false);
  const [details] = createResource(
    () => props.film,
    film => vod.filmDetails(film).catch((): FilmDetails => ({})),
  );
  const resumeAt = () => watched.resumeAt(props.film.key);
  const actions = createMemo((): Action[] => {
    const at = resumeAt();
    return at === undefined
      ? [{ id: "play", label: $t("vod.play"), run: () => props.onPlay() }]
      : [
          { id: "resume", label: $t("vod.resume", { time: duration(at) }), run: () => props.onPlay(at) },
          { id: "start", label: $t("vod.fromStart"), run: () => props.onPlay(0) },
        ];
  });
  const [cursor, setCursor] = createSignal(0);
  onMount(() => root?.setFocus());
  exposeToProbes("filmPanel", { film: () => props.film, details, actions, cursor });

  const facts = () => {
    const info = details();
    const film = props.film;
    return [
      info?.year ?? film.year,
      film.rating ? `★ ${film.rating}` : undefined,
      info?.genre ?? film.category,
      info?.durationMs ? duration(info.durationMs) : undefined,
    ]
      .filter(Boolean)
      .join("   ·   ");
  };
  const poster = () => details()?.poster || props.film.poster;

  return (
    <View
      ref={element => (root = element)}
      zIndex={OVERLAY_Z}
      width={PAGE_WIDTH}
      height={1080}
      color="#071423ff"
      onFocusChanged={setFocused}
      onUp={() => {
        setCursor(Math.max(0, cursor() - 1));
        return true;
      }}
      onDown={() => {
        setCursor(Math.min(actions().length - 1, cursor() + 1));
        return true;
      }}
      onLeft={() => true}
      onRight={() => true}
      onEnter={() => {
        actions()[cursor()]?.run();
        return true;
      }}
      onBack={() => {
        props.onClose();
        return true;
      }}
    >
      <View x={LEFT} y={80} width={POSTER_WIDTH} height={POSTER_HEIGHT} borderRadius={10} color="#1d2b3dff">
        <Text
          x={20}
          y={30}
          width={POSTER_WIDTH - 40}
          maxLines={5}
          contain="width"
          fontSize={34}
          color="#ffffffb3"
        >
          {props.film.name}
        </Text>
      </View>
      <Show when={poster()}>
        {src => (
          <View x={LEFT} y={80} width={POSTER_WIDTH} height={POSTER_HEIGHT} borderRadius={10} src={src()} />
        )}
      </Show>
      <Text
        x={TEXT_X}
        y={80}
        width={TEXT_WIDTH}
        maxLines={2}
        contain="width"
        fontSize={52}
        fontFamily="NotoSans700"
      >
        {props.film.name}
      </Text>
      <Text
        x={TEXT_X}
        y={210}
        width={TEXT_WIDTH}
        maxLines={1}
        contain="width"
        fontSize={28}
        color="#ffffffcc"
      >
        {facts()}
      </Text>
      <Text
        x={TEXT_X}
        y={270}
        width={TEXT_WIDTH}
        maxLines={6}
        contain="width"
        lineHeight={40}
        fontSize={28}
        color="#ffffffb3"
      >
        {details.loading ? $t("live.loading") : (details()?.plot ?? "")}
      </Text>
      <Text
        x={TEXT_X}
        y={530}
        width={TEXT_WIDTH}
        maxLines={2}
        contain="width"
        fontSize={24}
        color="#ffffff99"
      >
        {[
          details()?.director ? $t("vod.director", { name: details()?.director ?? "" }) : "",
          details()?.cast ? $t("vod.cast", { names: details()?.cast ?? "" }) : "",
        ]
          .filter(Boolean)
          .join("\n")}
      </Text>
      <ActionList actions={actions()} cursor={cursor()} focused={focused()} x={TEXT_X} y={660} />
    </View>
  );
};
