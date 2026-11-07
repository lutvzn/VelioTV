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
import { MENU_WIDTH } from "../../components/SideMenu";
import type { Episode, SeriesDetails } from "../../data/vod";
import type { SeriesEntry } from "../../data/vodLibrary";
import { exposeToProbes } from "../../devHooks";
import { vod, watched } from "../../library";
import { duration } from "../../live/format";
import { scrollTop } from "../../live/listWindow";
import { episodeKey, episodeLabel, episodeToContinue } from "../../play/vodPlay";
import { $t } from "../../translate";
import { OVERLAY_Z } from "../live/ChannelOptions";

const PAGE_WIDTH = 1920 - MENU_WIDTH;
const LEFT = 60;
const POSTER_WIDTH = 300;
const POSTER_HEIGHT = 450;
const TEXT_X = LEFT + POSTER_WIDTH + 60;
const TEXT_WIDTH = PAGE_WIDTH - TEXT_X - LEFT;
const SEASON_Y = 350;
const LIST_Y = 430;
const ROW_HEIGHT = 76;
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
      props.show.rating ? `★ ${props.show.rating}` : undefined,
      details()?.genre ?? props.show.category,
      seasons().length ? $t("vod.seasons", { count: seasons().length }) : undefined,
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
      color="#071423ff"
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
      <View x={LEFT} y={80} width={POSTER_WIDTH} height={POSTER_HEIGHT} borderRadius={10} color="#1d2b3dff">
        <Text
          x={20}
          y={30}
          width={POSTER_WIDTH - 40}
          maxLines={5}
          contain="width"
          fontSize={32}
          color="#ffffffb3"
        >
          {props.show.name}
        </Text>
      </View>
      <Show when={props.show.poster}>
        {src => (
          <View x={LEFT} y={80} width={POSTER_WIDTH} height={POSTER_HEIGHT} borderRadius={10} src={src()} />
        )}
      </Show>
      <Text
        x={TEXT_X}
        y={70}
        width={TEXT_WIDTH}
        maxLines={1}
        contain="width"
        fontSize={52}
        fontFamily="NotoSans700"
      >
        {props.show.name}
      </Text>
      <Text
        x={TEXT_X}
        y={146}
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
        y={196}
        width={TEXT_WIDTH}
        maxLines={3}
        contain="width"
        lineHeight={40}
        fontSize={28}
        color="#ffffffb3"
      >
        {details()?.plot ?? props.show.plot ?? ""}
      </Text>
      <Show
        when={seasons().length > 0}
        fallback={
          <Text x={TEXT_X} y={SEASON_Y} fontSize={30} color="#ffffffb3">
            {details.loading ? $t("live.loading") : $t("vod.noEpisodes")}
          </Text>
        }
      >
        <Text x={TEXT_X} y={SEASON_Y} fontSize={34}>
          {seasons().length > 1
            ? `‹  ${$t("vod.season", { number: seasons()[seasonAt()]?.season ?? 1 })}  ›`
            : $t("vod.season", { number: seasons()[0]?.season ?? 1 })}
        </Text>
        <For each={SLOTS}>
          {slot => (
            <Show when={episodes()[top() + slot]}>
              {episode => {
                const selected = () => focused() && top() + slot === cursor();
                const entry = () => entryOf(episode());
                return (
                  <View
                    x={TEXT_X - 20}
                    y={LIST_Y + slot * ROW_HEIGHT}
                    width={TEXT_WIDTH + 20}
                    height={ROW_HEIGHT - 8}
                    borderRadius={10}
                    color={selected() ? "#2e6bd6ff" : "#ffffff0a"}
                  >
                    <Text
                      x={20}
                      width={TEXT_WIDTH - 300}
                      height={ROW_HEIGHT - 8}
                      lineHeight={ROW_HEIGHT - 8}
                      maxLines={1}
                      contain="width"
                      fontSize={30}
                    >
                      {episodeLabel(episode())}
                    </Text>
                    <Text
                      x={TEXT_WIDTH}
                      mountX={1}
                      height={ROW_HEIGHT - 8}
                      lineHeight={ROW_HEIGHT - 8}
                      fontSize={24}
                      color="#ffffffb3"
                    >
                      {entry()?.finished
                        ? $t("vod.watched")
                        : episode().durationMs
                          ? duration(episode().durationMs ?? 0)
                          : ""}
                    </Text>
                    <Show when={progressOf(episode()) > 0}>
                      <View
                        x={20}
                        y={ROW_HEIGHT - 18}
                        width={300}
                        height={5}
                        borderRadius={2}
                        color="#ffffff33"
                      />
                      <View
                        x={20}
                        y={ROW_HEIGHT - 18}
                        width={300 * progressOf(episode())}
                        height={5}
                        borderRadius={2}
                        color="#7fb2ffff"
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
