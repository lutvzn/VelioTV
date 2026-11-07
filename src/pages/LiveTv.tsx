import { type ElementNode, Text, View } from "@solidtv/solid";
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import { MENU_WIDTH } from "../components/SideMenu";
import { exposeToProbes } from "../devHooks";
import type { Channel } from "../data/lineup";
import { centredTop, clampIndex, scrollTop, wrapIndex } from "../live/listWindow";
import { firstChoice, nextChoice, trackRows } from "../live/trackRows";
import { createNowNext } from "../live/nowNext";
import { createZapper } from "../live/zapper";
import { guide, lineup } from "../library";
import { player } from "../player";
import { DROPPED, NEEDS_REFERER, OFFLINE, STALLED, TIMEOUT } from "../player/player";
import { $t } from "../translate";
import { FULL_SCREEN, type Rect } from "../videoWindow";
import { Banner } from "./live/Banner";
import { ChannelList, LIST_ROWS } from "./live/ChannelList";
import { TrackPanel } from "./live/TrackPanel";
import { clockTime, timeRange } from "../live/format";

// Live TV (PLAN.md, Phase 3, step 3). With the side menu focused, the channel
// plays in a preview window; Right from the menu watches it full screen. At
// app start it goes straight to full screen with the last channel watched.
//
// Full screen: Up and Down (and the channel keys) zap, with the banner
// following each press and the stream changing once they stop; OK or the
// channel-list key opens the list over the video, where Left and Right
// change group; Right opens the audio and subtitle choices (step 5); Info
// shows the banner; number keys pick a channel by number. Back closes
// whatever is open, and then returns to the menu.

// In screen pixels; the page sits to the right of the menu.
const PREVIEW: Rect = { x: MENU_WIDTH + 80, y: 150, width: 1024, height: 576 };
const INFO_X = PREVIEW.x;
const BANNER_MS = 5000;
const MISSING_MS = 2000;
const CLOCK_MS = 10_000;

// Full screen happens by itself once, at app start; after that only on Right.
let launched = false;

/** What went wrong, in words. */
const errorText = (error: string | undefined) => {
  if (error === NEEDS_REFERER) return $t("live.error.referer");
  if (error === TIMEOUT) return $t("live.error.timeout");
  if (error === STALLED) return $t("live.error.stalled");
  if (error === DROPPED) return $t("live.error.dropped");
  if (error && /CONNECTION|NETWORK/i.test(error)) return $t("live.error.connection");
  if (error && /NOT_SUPPORTED|UNSUPPORTED/i.test(error)) return $t("live.error.format");
  return error ?? "";
};

const statusText = () => {
  const { state, error, attempt, attempts } = player.status();
  if (state === "starting") return $t("live.starting");
  if (state === "buffering") return $t("live.buffering");
  if (state === "ended") return $t("live.ended");
  if (state === "reconnecting" && error === OFFLINE) return $t("live.offline");
  if (state === "reconnecting") {
    return `${errorText(error)} ${$t("live.reconnecting", { attempt: attempt ?? 1, attempts: attempts ?? 1 })}`;
  }
  if (state !== "failed") return undefined;
  return `${$t("live.failed")}. ${errorText(error)}`;
};

const groupTitle = (name: string | undefined) => {
  if (name === undefined) return $t("live.allChannels");
  return name || $t("live.noGroup");
};

export default () => {
  let watchNode: ElementNode | undefined;
  const [focused, setFocused] = createSignal(false);
  const [clock, setClock] = createSignal(Date.now());
  const ticker = setInterval(() => setClock(Date.now()), CLOCK_MS);

  const zapper = createZapper({
    channels: lineup.channels,
    groups: lineup.groups,
    find: lineup.find,
    play: channel =>
      void player.play({
        url: channel.url,
        userAgent: channel.headers?.userAgent,
        referer: channel.headers?.referer,
        live: true,
      }),
    storage: localStorage,
  });

  const watching = () => focused() && zapper.shown() !== undefined;
  createEffect(() => player.setWindow(watching() ? FULL_SCREEN : PREVIEW));

  // Plays the last channel once the lineup has it, and stops if every
  // channel goes.
  createEffect(() => {
    if (zapper.shown()) return;
    if (zapper.start(lineup.loading())) {
      if (!launched) watchNode?.setFocus();
      launched = true;
    } else if (lineup.channels().length === 0 && !lineup.loading()) {
      zapper.reset();
      player.stop();
    }
  });

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

  exposeToProbes("live", { zapper, watching, listOpen, bannerShown, tracksOpen, rows, trackCursor });

  const nowNext = createNowNext(zapper.shown, { guide, clock });
  const listGuide = createNowNext(() => (listOpen() ? listChannels()[cursor()] : undefined), {
    guide,
    clock,
    delayMs: 400,
  });

  onCleanup(() => {
    launched = true;
    clearInterval(ticker);
    clearTimeout(bannerTimer);
    zapper.dispose();
    player.stop();
  });

  // Key handlers act only full screen; otherwise keys go on to the app.
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
      onFocusChanged={has => {
        setFocused(has);
        if (has && zapper.shown()) showBanner();
      }}
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
      onEnter={() => {
        if (!watching()) return false;
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
        return true;
      }}
      onChannelList={() => {
        if (!watching()) return false;
        setTracksOpen(false);
        if (listOpen()) setListOpen(false);
        else openList();
        return true;
      }}
      onInfo={() => {
        if (!watching()) return false;
        if (bannerShown()) hideBanner();
        else showBanner();
        return true;
      }}
      onBack={() => {
        if (!watching()) return false;
        if (zapper.digits() || zapper.missing()) zapper.clearDigits();
        else if (tracksOpen()) setTracksOpen(false);
        else if (listOpen()) setListOpen(false);
        else if (zapper.pending()) zapper.cancelZap();
        else if (bannerShown()) hideBanner();
        else {
          // Out of full screen, so that the app's own Back handler, next,
          // finds the menu showing and moves to it.
          player.setWindow(PREVIEW);
          return false;
        }
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
          <>
            <Text x={INFO_X} y={50} fontSize={56}>
              {$t("menu.live")}
            </Text>
            <Show
              when={zapper.shown()}
              fallback={
                <>
                  <Text x={INFO_X} y={170} fontSize={44}>
                    {lineup.loading() ? $t("live.loading") : $t("live.empty")}
                  </Text>
                  <Text x={INFO_X} y={240} width={1300} contain="width" fontSize={30} color="#ffffffb3">
                    {lineup.loading() ? "" : $t("live.emptyHint")}
                  </Text>
                </>
              }
            >
              {channel => (
                <>
                  <Text
                    x={INFO_X}
                    y={PREVIEW.y + PREVIEW.height + 30}
                    width={1300}
                    maxLines={1}
                    contain="width"
                    fontSize={40}
                  >
                    {`${zapper.numberOf(channel())}   ${channel().name}`}
                  </Text>
                  <Text
                    x={INFO_X}
                    y={PREVIEW.y + PREVIEW.height + 90}
                    width={1300}
                    maxLines={1}
                    contain="width"
                    fontSize={30}
                  >
                    {nowNext().now
                      ? `${timeRange(nowNext().now?.start ?? 0, nowNext().now?.stop ?? 0)}   ${nowNext().now?.title ?? ""}`
                      : ""}
                  </Text>
                  <Text
                    x={INFO_X}
                    y={PREVIEW.y + PREVIEW.height + 140}
                    width={1300}
                    maxLines={1}
                    contain="width"
                    fontSize={26}
                    color="#ffffffb3"
                  >
                    {statusText() ??
                      (nowNext().next
                        ? $t("live.next", {
                            time: clockTime(nowNext().next?.start ?? 0),
                            title: nowNext().next?.title ?? "",
                          })
                        : "")}
                  </Text>
                  <Text x={INFO_X} y={1000} width={1300} contain="width" fontSize={26} color="#ffffff99">
                    {$t("live.watchHint")}
                  </Text>
                </>
              )}
            </Show>
          </>
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
      </Show>
    </View>
  );
};
