import { type ElementNode, Text, View } from "@solidtv/solid";
import { createEffect, createMemo, createResource, createSignal, Index, on, onMount, Show } from "solid-js";
import { Artwork } from "../../components/Artwork";
import { Backdrop } from "../../components/Backdrop";
import { Glow } from "../../components/Glow";
import { MENU_WIDTH } from "../../components/SideMenu";
import type { Similar } from "../../data/moreLikeThis";
import type { FilmDetails } from "../../data/vod";
import type { FilmEntry } from "../../data/vodLibrary";
import { exposeToProbes } from "../../devHooks";
import { vod, watched } from "../../library";
import { duration } from "../../live/format";
import { qualityLabel } from "../../stremio/streamText";
import { BOLD, colors, motion, radius, raisedShadow, textOn } from "../../theme";
import { $t } from "../../translate";
import { OVERLAY_Z } from "../live/ChannelOptions";
import { SimilarRow } from "./SimilarRow";

const PAGE_WIDTH = 1920 - MENU_WIDTH;
const LEFT = 80;
const TOP = 150;
const POSTER_WIDTH = 300;
const POSTER_HEIGHT = 450;
const TEXT_X = LEFT + POSTER_WIDTH + 64;
const TEXT_WIDTH = PAGE_WIDTH - TEXT_X - LEFT;
const BUTTON_HEIGHT = 68;
const BUTTON_WIDTH = 440;
const BUTTONS_Y = 650;

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
    {(action, at) => {
      const selected = () => props.focused && at === props.cursor;
      return (
        <>
          <Glow
            x={props.x}
            y={props.y + at * (BUTTON_HEIGHT + 16)}
            width={BUTTON_WIDTH}
            height={BUTTON_HEIGHT}
            borderRadius={BUTTON_HEIGHT / 2}
            shown={selected()}
          />
          <View
            x={props.x}
            y={props.y + at * (BUTTON_HEIGHT + 16)}
            width={BUTTON_WIDTH}
            height={BUTTON_HEIGHT}
            borderRadius={BUTTON_HEIGHT / 2}
            color={selected() ? colors.focus : colors.surfaceRaised}
            transition={{ color: motion.quick }}
          >
            <Text
              x={36}
              width={BUTTON_WIDTH - 72}
              height={BUTTON_HEIGHT}
              lineHeight={BUTTON_HEIGHT}
              maxLines={1}
              contain="width"
              fontSize={28}
              fontFamily={BOLD}
              color={textOn(selected())}
            >
              {action().label}
            </Text>
          </View>
        </>
      );
    }}
  </Index>
);

/** A film's or series' poster on its page, raised off the backdrop. */
export const PagePoster = (props: {
  x: number;
  y: number;
  width: number;
  height: number;
  src?: string;
  title: string;
}) => (
  <>
    <View
      x={props.x}
      y={props.y}
      width={props.width}
      height={props.height}
      borderRadius={radius.large}
      color={colors.background}
      shadow={raisedShadow}
    />
    <Artwork
      x={props.x}
      y={props.y}
      width={props.width}
      height={props.height}
      borderRadius={radius.large}
      src={props.src}
      title={props.title}
      fontSize={34}
    />
  </>
);

/** The line under a title: a rating badge, then the year, genre and length. */
export const Facts = (props: { rating?: number; text: string; width: number }) => (
  <View display="flex" flexDirection="row" alignItems="center" gap={20} width={props.width} height={40}>
    <Show when={props.rating}>
      {rating => (
        <View width={RATING_WIDTH} height={36} borderRadius={radius.small} color={colors.gold}>
          <Text
            width={RATING_WIDTH}
            height={36}
            lineHeight={36}
            contain="width"
            textAlign="center"
            fontSize={22}
            fontFamily={BOLD}
            color={colors.onFocus}
          >
            {String(rating())}
          </Text>
        </View>
      )}
    </Show>
    <Text
      maxLines={1}
      width={props.width - RATING_WIDTH - 20}
      contain="width"
      fontSize={26}
      color={colors.textDim}
    >
      {props.text}
    </Text>
  </View>
);
const RATING_WIDTH = 72;

/**
 * A film's page, over the grid: its poster, details from the server, and
 * Play, or Resume and Play from the start when it was left partway.
 */
export const FilmPanel = (props: {
  film: FilmEntry;
  onClose: () => void;
  onPlay: (startMs?: number) => void;
  /** "More like this": TMDB's recommendations, and opening one. */
  similar?: () => Promise<Similar[]>;
  onSimilar?: (one: Similar) => void;
}) => {
  let root: ElementNode | undefined;
  const [focused, setFocused] = createSignal(false);
  const [details] = createResource(
    () => props.film,
    film => vod.filmDetails(film).catch((): FilmDetails => ({})),
  );
  const resumeAt = () => watched.resumeAt(props.film.key);
  // Only offered once TMDB has some.
  const [similar] = createResource(
    () => (props.similar ? props.film : undefined),
    () => (props.similar?.() ?? Promise.resolve([])).catch((): Similar[] => []),
  );
  const [similarOpen, setSimilarOpen] = createSignal(false);
  const actions = createMemo((): Action[] => {
    const at = resumeAt();
    const play: Action[] =
      at === undefined
        ? [{ id: "play", label: $t("vod.play"), run: () => props.onPlay() }]
        : [
            { id: "resume", label: $t("vod.resume", { time: duration(at) }), run: () => props.onPlay(at) },
            { id: "start", label: $t("vod.fromStart"), run: () => props.onPlay(0) },
          ];
    return similar()?.length
      ? [...play, { id: "similar", label: $t("vod.moreLikeThis"), run: () => setSimilarOpen(true) }]
      : play;
  });
  const [cursor, setCursor] = createSignal(0);
  // Another film opened from "More like this" starts at its first button.
  createEffect(
    on(
      () => props.film,
      () => setCursor(0),
      { defer: true },
    ),
  );
  onMount(() => root?.setFocus());
  exposeToProbes("filmPanel", { film: () => props.film, details, actions, cursor, similar, similarOpen });

  const facts = () => {
    const info = details();
    const film = props.film;
    return [
      info?.year ?? film.year,
      info?.genre ?? film.category,
      info?.durationMs ? duration(info.durationMs) : undefined,
      info && qualityLabel(info, "   ·   "),
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
      // No fill of its own: the page under it is hidden (VodHub), so the
      // app's background shows, in the same colour.
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
      <Backdrop width={PAGE_WIDTH} height={1080} src={details()?.backdrop} />
      <PagePoster
        x={LEFT}
        y={TOP}
        width={POSTER_WIDTH}
        height={POSTER_HEIGHT}
        src={poster()}
        title={props.film.name}
      />
      <View x={TEXT_X} y={TOP - 8} width={TEXT_WIDTH} display="flex" flexDirection="column" gap={20}>
        <Text width={TEXT_WIDTH} maxLines={2} contain="width" lineHeight={72} fontSize={60} fontFamily={BOLD}>
          {props.film.name}
        </Text>
        <Facts rating={props.film.rating} text={facts()} width={TEXT_WIDTH} />
        <Text
          width={TEXT_WIDTH}
          maxLines={4}
          contain="width"
          lineHeight={40}
          fontSize={28}
          color={colors.textDim}
          marginTop={8}
        >
          {details.loading ? $t("live.loading") : (details()?.plot ?? "")}
        </Text>
        <Text
          width={TEXT_WIDTH}
          maxLines={2}
          contain="width"
          lineHeight={34}
          fontSize={24}
          color={colors.textFaint}
        >
          {[
            details()?.director ? $t("vod.director", { name: details()?.director ?? "" }) : "",
            details()?.cast ? $t("vod.cast", { names: details()?.cast ?? "" }) : "",
          ]
            .filter(Boolean)
            .join("\n")}
        </Text>
      </View>
      <ActionList actions={actions()} cursor={cursor()} focused={focused()} x={TEXT_X} y={BUTTONS_Y} />
      <Show when={similarOpen()}>
        <SimilarRow
          load={() => Promise.resolve(similar() ?? [])}
          onClose={() => setSimilarOpen(false)}
          onPick={one => {
            setSimilarOpen(false);
            props.onSimilar?.(one);
          }}
        />
      </Show>
    </View>
  );
};
