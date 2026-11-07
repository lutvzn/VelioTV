import { useNavigate } from "@solidjs/router";
import { type ElementNode, Text, View } from "@solidtv/solid";
import { useHold } from "@solidtv/solid/primitives";
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { MENU_WIDTH } from "../components/SideMenu";
import { exposeToProbes } from "../devHooks";
import type { Channel } from "../data/lineup";
import { inArchive } from "../data/catchup";
import { appStorage } from "../data/settingsCopy";
import { duration } from "../live/format";
import { channelStream, handOff, holdPlayer, playChannel, statusText, takeHandoff } from "../live/handoff";
import { centredTop, clampIndex, scrollTop, wrapIndex } from "../live/listWindow";
import { firstChoice, nextChoice, trackRows } from "../live/trackRows";
import { createNowNext } from "../live/nowNext";
import { createZapper } from "../live/zapper";
import { groupTitle, guide, isBlocked, library, lineup, liveGroups, liveNumbers, liveView } from "../library";
import { askPin } from "../pin";
import { canPlaySecond, player, secondPlayer } from "../player";
import { programmeAt, watchRecording } from "../play/start";
import { $t } from "../translate";
import { FULL_SCREEN } from "../videoWindow";
import { Banner } from "./live/Banner";
import { ChannelList, LIST_ROWS } from "./live/ChannelList";
import {
  ChannelOptions,
  HOLD_MS,
  HOLD_REQUIRES_REPEAT,
  OPTIONS_WIDTH,
  OVERLAY_Z,
} from "./live/ChannelOptions";
import { type MenuOption, programmeOptions } from "./live/menus";
import { TrackPanel } from "./live/TrackPanel";

// Live TV full screen (PLAN.md, Phase 3, step 3, and Phase 4). The app
// starts here, on the last channel watched; OK in the guide (src/pages/
// Guide.tsx, the Live TV page) opens a channel here.
//
// Up and Down (and the channel keys) zap, with the banner following each
// press and the stream changing once they stop; Left or the channel-list
// key opens the list over the video, where Left and Right change group, and
// OK picks; Right opens the audio and subtitle choices (step 5); OK or Info
// shows or hides the banner, the channel's card (decided 2026-11-07);
// number keys pick a channel by number. Holding OK, or the Tools key, opens
// the options for the channel playing or highlighted (Phase 5, step 1). Back closes whatever is open, and
// then goes to the guide, on the channel playing; the Guide key goes there
// at once, and Back there comes back (src/live/handoff.ts). On a channel
// with catch-up, the options can play the programme on now from its start
// (Phase 6).

const BANNER_MS = 5000;
const MISSING_MS = 2000;
const CLOCK_MS = 10_000;
/**
 * A live channel paused for less than this plays on where it paused; after
 * longer, the TV's player can't (PLAN.md, Phase 7, step 1).
 */
const RESUME_IN_PLACE_MS = 10_000;
/** Rewind on live TV goes this far back, on a channel with catch-up. */
const REWIND_MS = 60_000;
// The small window's places, clockwise from the top right.
const SMALL_WIDTH = 640;
const SMALL_HEIGHT = 360;
const SMALL_CORNERS = [
  { x: 1920 - SMALL_WIDTH - 60, y: 60 },
  { x: 1920 - SMALL_WIDTH - 60, y: 1080 - SMALL_HEIGHT - 60 },
  { x: 60, y: 1080 - SMALL_HEIGHT - 60 },
  { x: 60, y: 60 },
].map(corner => ({ ...corner, width: SMALL_WIDTH, height: SMALL_HEIGHT }));

// A locked channel's programmes don't show until the PIN is entered.
const unblocked = (channel: Channel | undefined) => (channel && !isBlocked(channel) ? channel : undefined);

/** Whether `channel`'s archive has `time`, for a channel the viewer may watch. */
const hasArchive = (channel: Channel | undefined, time: number) =>
  channel !== undefined && !isBlocked(channel) && inArchive(channel, time, Date.now());

export default () => {
  const navigate = useNavigate();
  let watchNode: ElementNode | undefined;
  const [clock, setClock] = createSignal(Date.now());
  const ticker = setInterval(() => setClock(Date.now()), CLOCK_MS);
  holdPlayer();
  // From the guide: the channel to watch.
  let handoff = takeHandoff();

  // The first channel may be one the guide left playing; it carries on. A
  // locked channel waits for the PIN (PLAN.md, Phase 5, step 5): OK asks.
  let first = true;
  const [lockedChannel, setLockedChannel] = createSignal<Channel>();
  const zapper = createZapper({
    channels: () => liveView().channels,
    groups: liveGroups,
    find: lineup.find,
    numbers: liveNumbers,
    play: channel => {
      const keep = first;
      first = false;
      if (isBlocked(channel)) {
        player.stop();
        setLockedChannel(channel);
        return;
      }
      setLockedChannel(undefined);
      playChannel(channel, { keep });
    },
    storage: appStorage,
  });
  // Plays it once the PIN is entered, or the lock comes off.
  createEffect(() => {
    const channel = lockedChannel();
    if (!channel || isBlocked(channel)) return;
    setLockedChannel(undefined);
    playChannel(channel);
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
    if (zapper.shown() || lineup.loading() || !library.loaded() || liveView().channels.length > 0) return;
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
  const groupNames = createMemo(() => [undefined, ...liveGroups().map(group => group.name)]);

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

  // Pausing live TV (PLAN.md, Phase 7, step 2). On a channel with catch-up,
  // Play carries on from the archive, on the player page. Without, the TV's
  // player can only carry on after a short pause, so after a longer one
  // Play goes back to live.
  const [pausedAt, setPausedAt] = createSignal<number>();
  const [pauseClock, setPauseClock] = createSignal(0);
  let pauseTicker: ReturnType<typeof setInterval> | undefined;
  const clearPause = () => {
    clearInterval(pauseTicker);
    pauseTicker = undefined;
    setPausedAt(undefined);
  };
  const pauseLive = () => {
    const { state } = player.status();
    if (pausedAt() !== undefined || lockedChannel() || !["playing", "buffering"].includes(state)) return;
    player.setPaused(true);
    setPausedAt(Date.now());
    setPauseClock(Date.now());
    pauseTicker = setInterval(() => setPauseClock(Date.now()), 1000);
    hideBanner();
  };
  /** Plays `channel` from `time`, from its archive. */
  const fromArchive = async (channel: Channel, time: number) => {
    const programme = await programmeAt(channel, time).catch(() => undefined);
    if (!programme) return false;
    watchRecording(navigate, channel, programme, { group: zapper.group(), from: time, fromLive: true });
    return true;
  };
  const playOn = async () => {
    const at = pausedAt();
    const channel = zapper.playing();
    if (at === undefined || !channel) return;
    clearPause();
    if (Date.now() - at < RESUME_IN_PLACE_MS) {
      player.setPaused(false);
      return;
    }
    if (hasArchive(channel, at) && (await fromArchive(channel, at))) return;
    playChannel(channel, { keep: false });
    showBanner();
  };
  /** Back to live, from a pause. */
  const cancelPause = () => {
    const channel = zapper.playing();
    clearPause();
    if (channel) playChannel(channel, { keep: false });
  };
  const rewind = () => {
    const channel = zapper.playing();
    const from = Date.now() - REWIND_MS;
    if (!channel || !hasArchive(channel, from)) return;
    clearPause();
    void fromArchive(channel, from);
  };
  // Another channel, or the stream opening again (as after the app was
  // hidden), ends the pause.
  createEffect(on(zapper.playing, clearPause, { defer: true }));
  createEffect(
    on(
      () => player.status().state,
      state => {
        if (pausedAt() !== undefined && state !== "paused") clearPause();
      },
    ),
  );
  const pausedFor = () => pauseClock() - (pausedAt() ?? pauseClock());
  const pausedHint = () => {
    const at = pausedAt();
    if (at === undefined) return "";
    return pausedFor() < RESUME_IN_PLACE_MS || hasArchive(zapper.playing(), at)
      ? $t("live.pausedCarryOn")
      : $t("live.pausedBackToLive");
  };

  // A second channel in a small window (PLAN.md, Phase 7, step 3), without
  // sound, on TVs with a second player; the main one keeps the keys. Each
  // time the main stream opens (a zap, a reconnect, a swap), the small one
  // closes first and opens again once the main one plays: opened the other
  // way round, or left playing, the TV may draw the main picture over it.
  const [smallChannel, setSmallChannel] = createSignal<Channel>();
  const [smallWaiting, setSmallWaiting] = createSignal(false);
  const [corner, setCorner] = createSignal(0);
  const smallRect = () => SMALL_CORNERS[corner()];
  const showSmall = (channel: Channel, afterMain = false) => {
    secondPlayer.stop();
    setSmallChannel(channel);
    secondPlayer.setWindow(smallRect());
    setSmallWaiting(afterMain);
    if (!afterMain) void secondPlayer.play(channelStream(channel));
  };
  createEffect(() => {
    const channel = smallChannel();
    if (!smallWaiting() || !channel) return;
    const { state } = player.status();
    // A locked channel stops the main one, with nothing to wait for.
    if (state !== "playing" && state !== "failed" && !(state === "idle" && lockedChannel())) return;
    setSmallWaiting(false);
    void secondPlayer.play(channelStream(channel));
  });
  // The main stream opening: the small one waits for it. (player.play() says
  // "starting" before the main player opens, after the next frame.)
  createEffect(
    on(
      () => player.status().state,
      state => {
        if (!smallChannel() || smallWaiting()) return;
        if (state !== "starting" && state !== "reconnecting") return;
        secondPlayer.stop();
        setSmallWaiting(true);
      },
    ),
  );
  const closeSmall = () => {
    secondPlayer.stop();
    setSmallWaiting(false);
    setSmallChannel(undefined);
  };
  // Zapping to the small window's channel: it's full screen now.
  createEffect(
    on(zapper.playing, channel => {
      if (channel && channel.id === smallChannel()?.id) closeSmall();
    }),
  );
  const swapSmall = () => {
    const main = zapper.playing();
    const small = smallChannel();
    if (!main || !small) return;
    secondPlayer.stop();
    zapper.tune(small, zapper.group());
    showSmall(main, true);
    showBanner();
  };
  const moveSmall = () => {
    setCorner(at => (at + 1) % SMALL_CORNERS.length);
    secondPlayer.setWindow(smallRect());
  };
  const smallOptions = (channel: Channel): MenuOption[] => {
    const small = smallChannel();
    const isMain = channel.id === zapper.playing()?.id;
    const options: MenuOption[] = [];
    if (canPlaySecond() && !isMain && !isBlocked(channel) && channel.id !== small?.id) {
      options.push({
        id: "smallOpen",
        label: small ? $t("options.smallReplace") : $t("options.smallOpen"),
        run: () => {
          setListOpen(false);
          showSmall(channel);
        },
      });
    }
    if (small && isMain) {
      options.push(
        { id: "smallSwap", label: $t("options.smallSwap", { name: small.name }), run: swapSmall },
        {
          id: "smallMove",
          label: $t("options.smallMove"),
          run: () => {
            moveSmall();
            return "stay";
          },
        },
        { id: "smallClose", label: $t("options.smallClose"), run: closeSmall },
      );
    }
    return options;
  };
  const smallText = () => {
    const { state } = secondPlayer.status();
    if (state === "failed") return $t("live.smallFailed");
    return smallWaiting() || ["starting", "buffering", "reconnecting"].includes(state)
      ? $t("live.smallWaiting")
      : "";
  };

  // OK: a tap acts at once; a hold opens the options.
  const pressEnter = () => {
    if (lockedChannel() && !listOpen() && !tracksOpen() && !zapper.digits() && !zapper.pending()) {
      void askPin();
      return;
    }
    if (tracksOpen()) chooseTrack();
    else if (zapper.digits()) {
      zapper.enterNumber();
      showBanner();
    } else if (listOpen()) {
      const channel = listChannels()[cursor()];
      setListOpen(false);
      if (channel) zapper.tune(channel, listGroup());
      showBanner();
    } else if (bannerShown()) hideBanner();
    else showBanner();
  };
  const [holdEnter, releaseEnter] = useHold({
    onEnter: pressEnter,
    onHold: () => {
      if (!openOptions()) pressEnter();
    },
    holdThreshold: HOLD_MS,
    holdRequiresRepeat: HOLD_REQUIRES_REPEAT,
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
    lockedChannel,
    pausedAt,
    pausedHint,
    smallChannel,
    smallWaiting,
    corner,
    smallOptions,
    listChannel: () => listChannels()[cursor()],
  });

  const nowNext = createNowNext(() => unblocked(zapper.shown()), { guide, clock });
  const listGuide = createNowNext(() => (listOpen() ? unblocked(listChannels()[cursor()]) : undefined), {
    guide,
    clock,
    delayMs: 400,
  });

  onCleanup(() => {
    clearInterval(ticker);
    clearTimeout(bannerTimer);
    zapper.dispose();
    closeSmall();
    // A paused channel plays on for the page after, as the guide's preview.
    if (pausedAt() !== undefined) player.setPaused(false);
    clearPause();
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
        else openList();
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
      onPause={() => {
        if (!watching()) return false;
        pauseLive();
        return true;
      }}
      onPlay={() => {
        if (!watching()) return false;
        void playOn();
        return true;
      }}
      onPlayPause={() => {
        if (!watching()) return false;
        if (pausedAt() === undefined) pauseLive();
        else void playOn();
        return true;
      }}
      onRewind={() => {
        if (!watching()) return false;
        rewind();
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
        else if (pausedAt() !== undefined) cancelPause();
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
        <Show when={smallChannel()}>
          {channel => (
            <View
              x={smallRect().x - 4}
              y={smallRect().y - 4}
              width={SMALL_WIDTH + 8}
              height={SMALL_HEIGHT + 8}
              borderRadius={8}
              border={{ width: 4, color: "#ffffffcc" }}
            >
              <View
                x={4}
                y={4}
                height={44}
                display="flex"
                flexBoundary="contain"
                padding={[6, 16]}
                color="#000000b3"
              >
                <Text maxWidth={SMALL_WIDTH - 32} maxLines={1} fontSize={26}>
                  {channel().name}
                </Text>
              </View>
              <Show when={smallText()}>
                <Text
                  y={SMALL_HEIGHT / 2 - 16}
                  width={SMALL_WIDTH + 8}
                  textAlign="center"
                  maxLines={1}
                  contain="width"
                  fontSize={28}
                  color="#ffffffcc"
                >
                  {smallText()}
                </Text>
              </Show>
            </View>
          )}
        </Show>
        <Show when={pausedAt() !== undefined}>
          <View x={60} y={60} width={760} height={130} borderRadius={16} color="#071423e6">
            <Text
              x={32}
              y={20}
              width={696}
              maxLines={1}
              contain="width"
              fontSize={40}
              fontFamily="NotoSans700"
            >
              {$t("live.paused", { time: duration(pausedFor()) })}
            </Text>
            <Text x={32} y={78} width={696} maxLines={1} contain="width" fontSize={26} color="#ffffffb3">
              {pausedHint()}
            </Text>
          </View>
        </Show>
        <Show when={lockedChannel() && !zapper.pending() && !listOpen()}>
          <View x={460} y={470} width={1000} height={110} borderRadius={16} color="#071423d9">
            <Text
              width={1000}
              height={110}
              lineHeight={110}
              maxLines={1}
              contain="width"
              textAlign="center"
              fontSize={32}
            >
              {$t("pin.lockedHint")}
            </Text>
          </View>
        </Show>
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
          <View
            zIndex={OVERLAY_Z}
            x={1840}
            y={60}
            mountX={1}
            width={420}
            height={110}
            borderRadius={16}
            color="#071423e6"
          >
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
          {channel => (
            <ChannelOptions
              channel={channel()}
              x={1920 - OPTIONS_WIDTH}
              onClose={closeOptions}
              extra={[
                ...smallOptions(channel()),
                // The programme on now, for the channel playing.
                ...(channel().id === zapper.shown()?.id && !isBlocked(channel())
                  ? programmeOptions(channel(), nowNext().now, Date.now(), programme =>
                      watchRecording(navigate, channel(), programme, { group: zapper.group() }),
                    )
                  : []),
              ]}
            />
          )}
        </Show>
      </Show>
    </View>
  );
};
