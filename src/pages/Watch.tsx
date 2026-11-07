import { useNavigate } from "@solidjs/router";
import { type ElementNode, Text, View } from "@solidtv/solid";
import { useHold } from "@solidtv/solid/primitives";
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { MENU_WIDTH } from "../components/SideMenu";
import { exposeToProbes } from "../devHooks";
import type { Channel } from "../data/lineup";
import { handOff, holdPlayer, playChannel, statusText, takeHandoff } from "../live/handoff";
import { centredTop, clampIndex, scrollTop, wrapIndex } from "../live/listWindow";
import { firstChoice, nextChoice, trackRows } from "../live/trackRows";
import { createNowNext } from "../live/nowNext";
import { createZapper } from "../live/zapper";
import { guide, library, lineup } from "../library";
import { player } from "../player";
import { $t } from "../translate";
import { FULL_SCREEN } from "../videoWindow";
import { Banner } from "./live/Banner";
import { ChannelList, LIST_ROWS } from "./live/ChannelList";
import { ChannelOptions, HOLD_MS, OPTIONS_WIDTH } from "./live/ChannelOptions";
import { TrackPanel } from "./live/TrackPanel";

// Live TV full screen (PLAN.md, Phase 3, step 3, and Phase 4). The app
// starts here, on the last channel watched; OK in the guide (src/pages/
// Guide.tsx, the Live TV page) opens a channel here.
//
// Up and Down (and the channel keys) zap, with the banner following each
// press and the stream changing once they stop; OK or the channel-list key
// opens the list over the video, where Left and Right change group; Right
// opens the audio and subtitle choices (step 5); Info shows the banner;
// number keys pick a channel by number. Holding OK, or the Tools key, opens
// the options for the channel playing or highlighted (Phase 5, step 1). Back closes whatever is open, and
// then goes to the guide, on the channel playing; the Guide key goes there
// at once, and Back there comes back (src/live/handoff.ts).

const BANNER_MS = 5000;
const MISSING_MS = 2000;
const CLOCK_MS = 10_000;

const groupTitle = (name: string | undefined) => {
  if (name === undefined) return $t("live.allChannels");
  return name || $t("live.noGroup");
};

export default () => {
  const navigate = useNavigate();
  let watchNode: ElementNode | undefined;
  const [clock, setClock] = createSignal(Date.now());
  const ticker = setInterval(() => setClock(Date.now()), CLOCK_MS);
  holdPlayer();
  // From the guide: the channel to watch.
  let handoff = takeHandoff();

  // The first channel may be one the guide left playing; it carries on.
  let first = true;
  const zapper = createZapper({
    channels: lineup.channels,
    groups: lineup.groups,
    find: lineup.find,
    play: channel => {
      playChannel(channel, { keep: first });
      first = false;
    },
    storage: localStorage,
  });

  const watching = () => zapper.shown() !== undefined;
  player.setWindow(FULL_SCREEN);

  /** Goes to the guide on the channel playing; with `backTo`, Back there returns here. */
  const openGuide = (backTo?: "/watch") => {
    handOff({ channelId: zapper.playing()?.id, group: zapper.group(), backTo });
    navigate("/", { replace: true });
  };

  // The banner, shown for a while after each change.
  const [bannerShown, setBannerShown] = createSignal(false);
  let bannerTimer: ReturnType<typeof setTimeout> | undefined;
  const showBanner = () => {
    setBannerShown(true);
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => setBannerShown(false), BANNER_MS);
  };
  const hideBanner = () => {
    clearTimeout(bannerTimer);
    setBannerShown(false);
  };

  // Plays the channel handed over, or else the last one, once the lineup
  // has it.
  createEffect(() => {
    if (zapper.shown()) return;
    const handed = handoff?.channelId === undefined ? undefined : lineup.find(handoff.channelId);
    if (handed && handoff) {
      zapper.tune(handed, handoff.group);
      handoff = undefined;
      showBanner();
    } else if (handoff?.channelId !== undefined && lineup.loading()) {
      // Wait for the channel handed over.
    } else if (zapper.start(lineup.loading())) {
      handoff = undefined;
      showBanner();
    }
  });
  // The page is only ever full screen, so it always has the focus.
  onMount(() => watchNode?.setFocus());

  // With nothing to play (no sources, or their channels gone), the guide
  // says so and leads to the menu. A moment's wait lets a list being read
  // show up first.
  createEffect(() => {
    if (zapper.shown() || lineup.loading() || !library.loaded() || lineup.channels().length > 0) return;
    const timer = setTimeout(() => openGuide(), 500);
    onCleanup(() => clearTimeout(timer));
  });

  // A number that matches no channel shows for a moment.
  createEffect(
    on(zapper.missing, missing => {
      if (!missing) return;
      const timer = setTimeout(() => zapper.clearDigits(), MISSING_MS);
      onCleanup(() => clearTimeout(timer));
    }),
  );

  // The channel list: its group (undefined for every channel), cursor, and
  // first row drawn.
  const [listOpen, setListOpen] = createSignal(false);
  const [listGroup, setListGroup] = createSignal<string>();
  const [cursor, setCursor] = createSignal(0);
  const [top, setTop] = createSignal(0);
  const listChannels = createMemo(() => zapper.groupChannels(listGroup()));
  const groupNames = createMemo(() => [undefined, ...lineup.groups().map(group => group.name)]);

  const showInList = (channels: Channel[]) => {
    const id = zapper.shown()?.id;
    const index = Math.max(
      0,
      channels.findIndex(channel => channel.id === id),
    );
    setCursor(index);
    setTop(centredTop(index, LIST_ROWS, channels.length));
  };
  const openList = () => {
    hideBanner();
    setListGroup(zapper.group());
    showInList(listChannels());
    setListOpen(true);
  };
  const moveCursor = (index: number) => {
    setCursor(index);
    setTop(scrollTop(index, top(), LIST_ROWS, listChannels().length));
  };
  const changeGroup = (step: number) => {
    const names = groupNames();
    const at = Math.max(0, names.indexOf(listGroup()));
    setListGroup(names[wrapIndex(at, step, names.length)]);
    showInList(listChannels());
  };

  // The audio and subtitle choices.
  const [tracksOpen, setTracksOpen] = createSignal(false);
  const [trackCursor, setTrackCursor] = createSignal(0);
  const rows = createMemo(() =>
    trackRows(player.tracks(), {
      audio: $t("live.tracks.audio"),
      subtitles: $t("live.tracks.subtitles"),
      off: $t("live.tracks.off"),
      noAudio: $t("live.tracks.noAudio"),
      noSubtitles: $t("live.tracks.noSubtitles"),
      unnamed: number => $t("live.tracks.unnamed", { number }),
    }),
  );
  const openTracks = () => {
    hideBanner();
    player.refreshTracks();
    setTrackCursor(firstChoice(rows()));
    setTracksOpen(true);
  };
  const chooseTrack = () => {
    const row = rows()[trackCursor()];
    if (row?.type === "choice") player.selectTrack(row.kind, row.id);
  };
  // A new channel has other tracks.
  createEffect(on(zapper.playing, () => setTracksOpen(false), { defer: true }));

  // Options for the channel playing, or the one highlighted in the list.
  const [optionsFor, setOptionsFor] = createSignal<Channel>();
  const openOptions = () => {
    const channel = listOpen() ? listChannels()[cursor()] : zapper.shown();
    if (tracksOpen() || zapper.digits() || !channel) return false;
    hideBanner();
    setOptionsFor(channel);
    return true;
  };
  const closeOptions = () => {
    setOptionsFor(undefined);
    watchNode?.setFocus();
  };

  // OK: a tap acts at once; a hold opens the options.
  const pressEnter = () => {
    if (tracksOpen()) chooseTrack();
    else if (zapper.digits()) {
      zapper.enterNumber();
      showBanner();
    } else if (listOpen()) {
      const channel = listChannels()[cursor()];
      setListOpen(false);
      if (channel) zapper.tune(channel, listGroup());
      showBanner();
    } else {
      openList();
    }
  };
  const [holdEnter, releaseEnter] = useHold({
    onEnter: pressEnter,
    onHold: () => {
      if (!openOptions()) pressEnter();
    },
    holdThreshold: HOLD_MS,
  });

  exposeToProbes("live", {
    zapper,
    watching,
    listOpen,
    bannerShown,
    tracksOpen,
    rows,
    trackCursor,
    optionsFor,
  });

  const nowNext = createNowNext(zapper.shown, { guide, clock });
  const listGuide = createNowNext(() => (listOpen() ? listChannels()[cursor()] : undefined), {
    guide,
    clock,
    delayMs: 400,
  });

  onCleanup(() => {
    clearInterval(ticker);
    clearTimeout(bannerTimer);
    zapper.dispose();
  });

  // Key handlers act only once a channel shows; until then, Back goes to the guide.
  const zap = (step: number) => {
    if (!watching()) return false;
    if (tracksOpen()) {
      if (Math.abs(step) === 1) setTrackCursor(nextChoice(rows(), trackCursor(), step > 0 ? -1 : 1));
      return true;
    }
    if (listOpen()) {
      moveCursor(
        Math.abs(step) === 1
          ? wrapIndex(cursor(), -step, listChannels().length)
          : clampIndex(cursor(), -step, listChannels().length),
      );
    } else {
      zapper.zap(step);
      showBanner();
    }
    return true;
  };
  const digit = (value: number) => () => {
    if (!watching()) return false;
    zapper.digit(value);
    return true;
  };

  return (
    <View
      ref={element => (watchNode = element)}
      x={-MENU_WIDTH}
      width={1920}
      height={1080}
      // Up is the next channel, as on the TV's own channel keys.
      onUp={() => zap(1)}
      onDown={() => zap(-1)}
      onChannelUp={() => zap(listOpen() ? LIST_ROWS : 1)}
      onChannelDown={() => zap(listOpen() ? -LIST_ROWS : -1)}
      onLeft={() => {
        if (!watching()) return false;
        if (tracksOpen()) setTracksOpen(false);
        else if (listOpen()) changeGroup(-1);
        return true;
      }}
      onRight={() => {
        if (!watching()) return false;
        if (listOpen()) changeGroup(1);
        else if (tracksOpen()) setTracksOpen(false);
        else openTracks();
        return true;
      }}
      onEnter={(event, target, handler) => (watching() ? holdEnter(event, target, handler) : false)}
      onEnterRelease={releaseEnter}
      onTools={() => {
        if (!watching()) return false;
        openOptions();
        return true;
      }}
      onChannelList={() => {
        if (!watching()) return false;
        setTracksOpen(false);
        if (listOpen()) setListOpen(false);
        else openList();
        return true;
      }}
      onGuide={() => {
        if (!watching()) return false;
        openGuide("/watch");
        return true;
      }}
      onInfo={() => {
        if (!watching()) return false;
        if (bannerShown()) hideBanner();
        else showBanner();
        return true;
      }}
      onBack={() => {
        if (!watching()) {
          openGuide();
          return true;
        }
        if (zapper.digits() || zapper.missing()) zapper.clearDigits();
        else if (tracksOpen()) setTracksOpen(false);
        else if (listOpen()) setListOpen(false);
        else if (zapper.pending()) zapper.cancelZap();
        else if (bannerShown()) hideBanner();
        else openGuide();
        return true;
      }}
      onKey0={digit(0)}
      onKey1={digit(1)}
      onKey2={digit(2)}
      onKey3={digit(3)}
      onKey4={digit(4)}
      onKey5={digit(5)}
      onKey6={digit(6)}
      onKey7={digit(7)}
      onKey8={digit(8)}
      onKey9={digit(9)}
    >
      <Show
        when={watching()}
        fallback={
          <Text y={500} width={1920} textAlign="center" fontSize={40} color="#ffffffb3">
            {lineup.loading() || !library.loaded() ? $t("live.loading") : ""}
          </Text>
        }
      >
        <Show when={statusText() && !zapper.pending()}>
          <View x={560} y={470} width={800} height={110} borderRadius={16} color="#071423d9">
            <Text
              width={800}
              height={110}
              lineHeight={110}
              maxLines={1}
              contain="width"
              textAlign="center"
              fontSize={32}
            >
              {statusText() ?? ""}
            </Text>
          </View>
        </Show>
        <Show when={player.subtitle()}>
          {text => (
            <View
              x={960}
              y={1010}
              mountX={0.5}
              mountY={1}
              display="flex"
              flexBoundary="contain"
              padding={[12, 28]}
              borderRadius={10}
              color="#000000bf"
            >
              <Text maxWidth={1500} maxLines={3} textAlign="center" fontSize={42}>
                {text()}
              </Text>
            </View>
          )}
        </Show>
        <Show when={bannerShown() && !listOpen() ? zapper.shown() : undefined}>
          {channel => (
            <Banner channel={channel()} number={zapper.numberOf(channel())} guide={nowNext()} now={clock()} />
          )}
        </Show>
        <Show when={listOpen()}>
          <ChannelList
            title={groupTitle(listGroup())}
            channels={listChannels()}
            cursor={cursor()}
            top={top()}
            playingId={zapper.playing()?.id}
            numberOf={zapper.numberOf}
            guide={listGuide()}
          />
        </Show>
        <Show when={tracksOpen()}>
          <TrackPanel rows={rows()} cursor={trackCursor()} />
        </Show>
        <Show when={zapper.digits() || zapper.missing()}>
          <View x={1840} y={60} mountX={1} width={420} height={110} borderRadius={16} color="#071423e6">
            <Text
              width={420}
              height={110}
              lineHeight={110}
              contain="width"
              textAlign="center"
              fontSize={zapper.digits() ? 64 : 32}
            >
              {zapper.digits() || $t("live.noNumber", { number: zapper.missing() ?? "" })}
            </Text>
          </View>
        </Show>
        <Show when={optionsFor()}>
          {channel => <ChannelOptions channel={channel()} x={1920 - OPTIONS_WIDTH} onClose={closeOptions} />}
        </Show>
      </Show>
    </View>
  );
};
