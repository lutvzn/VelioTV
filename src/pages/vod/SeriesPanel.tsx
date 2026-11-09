import { type ElementNode, Text, View } from "@solidtv/solid";
import {
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onMount,
  Show,
} from "solid-js";
import { Backdrop } from "../../components/Backdrop";
import { MENU_WIDTH } from "../../components/SideMenu";
import type { Episode, SeriesDetails } from "../../data/vod";
import type { SeriesEntry } from "../../data/vodLibrary";
import { exposeToProbes } from "../../devHooks";
import { vod, watched } from "../../library";
import { duration } from "../../live/format";
import { scrollTop } from "../../live/listWindow";
import { episodeKey, episodeLabel, episodeToContinue } from "../../play/vodPlay";
import { $t, $tn } from "../../translate";
import { BOLD, colors, motion, radius, textOn } from "../../theme";
import { OVERLAY_Z } from "../live/ChannelOptions";
import { Facts, PagePoster } from "./FilmPanel";

const PAGE_WIDTH = 1920 - MENU_WIDTH;
const LEFT = 80;
const TOP = 110;
const POSTER_WIDTH = 240;
const POSTER_HEIGHT = 360;
const TEXT_X = LEFT + POSTER_WIDTH + 64;
const TEXT_WIDTH = PAGE_WIDTH - TEXT_X - LEFT;
const SEASON_Y = 404;
const SEASON_HEIGHT = 52;
const LIST_Y = 478;
const ROW_HEIGHT = 72;
const ROWS = 8;
const SLOTS = Array.from({ length: ROWS }, (_, slot) => slot);

/**
 * A series' page, over the grid: its details, a season at a time, and the
 * season's episodes. Left and Right change season, Up and Down move through
 * the episodes, and OK plays one, from where it was left. It opens on the
 * episode to carry on with.
 */
export const SeriesPanel = (props: {
  show: SeriesEntry;
  onClose: () => void;
  onPlay: (details: SeriesDetails, episode: Episode, startMs?: number) => void;
}) => {
  let root: ElementNode | undefined;
  const [focused, setFocused] = createSignal(false);
  const [details] = createResource(
    () => props.show,
    show => vod.seriesDetails(show).catch((): SeriesDetails => ({ seasons: [] })),
  );
  const seasons = () => details()?.seasons ?? [];
  const [seasonAt, setSeasonAt] = createSignal(0);
  const episodes = () => seasons()[seasonAt()]?.episodes ?? [];
  const [cursor, setCursor] = createSignal(0);
  const [top, setTop] = createSignal(0);
  const place = (index: number) => {
    const at = Math.max(0, Math.min(index, episodes().length - 1));
    batch(() => {
      setCursor(at);
      setTop(scrollTop(at, top(), ROWS, episodes().length));
    });
  };

  // Once the episodes arrive, on the one to carry on with.
  createEffect(
    on(details, found => {
      if (!found) return;
      const next = episodeToContinue(props.show, found, watched);
      if (!next) return;
      const season = found.seasons.findIndex(one => one.episodes.includes(next));
      batch(() => {
        setSeasonAt(Math.max(0, season));
        setTop(0);
      });
      place(Math.max(0, episodes().indexOf(next)));
    }),
  );
  const changeSeason = (step: number) => {
    const count = seasons().length;
    if (count < 2) return;
    batch(() => {
      setSeasonAt(Math.max(0, Math.min(count - 1, seasonAt() + step)));
      setTop(0);
      setCursor(0);
    });
  };

  onMount(() => root?.setFocus());
  exposeToProbes("seriesPanel", { show: () => props.show, details, seasonAt, cursor, episodes });

  const entryOf = (episode: Episode) => watched.get(episodeKey(props.show, episode));
  const progressOf = (episode: Episode) => {
    const entry = entryOf(episode);
    if (!entry || entry.finished || !entry.durationMs) return 0;
    return Math.min(1, entry.positionMs / entry.durationMs);
  };
  const facts = createMemo(() =>
    [
      props.show.year,
      details()?.genre ?? props.show.category,
      seasons().length ? $tn("vod.seasons", seasons().length) : undefined,
    ]
      .filter(Boolean)
      .join("   ·   "),
  );
  const play = () => {
    const found = details();
    const episode = episodes()[cursor()];
    if (found && episode) props.onPlay(found, episode, watched.resumeAt(episodeKey(props.show, episode)));
  };

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
        place(cursor() - 1);
        return true;
      }}
      onDown={() => {
        place(cursor() + 1);
        return true;
      }}
      onChannelUp={() => {
        place(cursor() - ROWS);
        return true;
      }}
      onChannelDown={() => {
        place(cursor() + ROWS);
        return true;
      }}
      onLeft={() => {
        changeSeason(-1);
        return true;
      }}
      onRight={() => {
        changeSeason(1);
        return true;
      }}
      onEnter={() => {
        play();
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
        src={props.show.poster}
        title={props.show.name}
      />
      <View x={TEXT_X} y={TOP - 8} width={TEXT_WIDTH} display="flex" flexDirection="column" gap={18}>
        <Text width={TEXT_WIDTH} maxLines={1} contain="width" lineHeight={68} fontSize={56} fontFamily={BOLD}>
          {props.show.name}
        </Text>
        <Facts rating={props.show.rating} text={facts()} width={TEXT_WIDTH} />
        <Text
          width={TEXT_WIDTH}
          maxLines={3}
          contain="width"
          lineHeight={40}
          fontSize={28}
          color={colors.textDim}
          marginTop={6}
        >
          {details()?.plot ?? props.show.plot ?? ""}
        </Text>
      </View>
      <Show
        when={seasons().length > 0}
        fallback={
          <Text x={TEXT_X} y={SEASON_Y + 8} fontSize={30} color={colors.textDim}>
            {details.loading ? $t("live.loading") : $t("vod.noEpisodes")}
          </Text>
        }
      >
        <View
          x={TEXT_X}
          y={SEASON_Y}
          width={340}
          height={SEASON_HEIGHT}
          borderRadius={SEASON_HEIGHT / 2}
          color={colors.surfaceRaised}
        >
          <Text
            width={340}
            height={SEASON_HEIGHT}
            lineHeight={SEASON_HEIGHT}
            contain="width"
            textAlign="center"
            fontSize={26}
            fontFamily={BOLD}
          >
            {seasons().length > 1
              ? `‹   ${$t("vod.season", { number: seasons()[seasonAt()]?.season ?? 1 })}   ›`
              : $t("vod.season", { number: seasons()[0]?.season ?? 1 })}
          </Text>
        </View>
        <For each={SLOTS}>
          {slot => (
            <Show when={episodes()[top() + slot]}>
              {episode => {
                const selected = () => focused() && top() + slot === cursor();
                const entry = () => entryOf(episode());
                return (
                  <View
                    x={TEXT_X}
                    y={LIST_Y + slot * ROW_HEIGHT}
                    width={TEXT_WIDTH}
                    height={ROW_HEIGHT - 10}
                    borderRadius={radius.medium}
                    color={selected() ? colors.focus : colors.surface}
                    transition={{ color: motion.quick }}
                  >
                    <Text
                      x={24}
                      width={TEXT_WIDTH - 280}
                      height={ROW_HEIGHT - 10}
                      lineHeight={ROW_HEIGHT - 10}
                      maxLines={1}
                      contain="width"
                      fontSize={28}
                      fontFamily={selected() ? BOLD : undefined}
                      color={textOn(selected())}
                    >
                      {episodeLabel(episode())}
                    </Text>
                    <Text
                      x={TEXT_WIDTH - 24}
                      mountX={1}
                      height={ROW_HEIGHT - 10}
                      lineHeight={ROW_HEIGHT - 10}
                      fontSize={24}
                      color={
                        selected() ? colors.onFocus : entry()?.finished ? colors.accentText : colors.textFaint
                      }
                    >
                      {entry()?.finished
                        ? $t("vod.watched")
                        : episode().durationMs
                          ? duration(episode().durationMs ?? 0)
                          : ""}
                    </Text>
                    <Show when={progressOf(episode()) > 0}>
                      <View
                        x={24}
                        y={ROW_HEIGHT - 20}
                        width={300}
                        height={5}
                        borderRadius={2.5}
                        color={selected() ? colors.trackOnFocus : colors.track}
                      />
                      <View
                        x={24}
                        y={ROW_HEIGHT - 20}
                        width={300 * progressOf(episode())}
                        height={5}
                        borderRadius={2.5}
                        color={selected() ? colors.onFocus : colors.accent}
                      />
                    </Show>
                  </View>
                );
              }}
            </Show>
          )}
        </For>
      </Show>
    </View>
  );
};
