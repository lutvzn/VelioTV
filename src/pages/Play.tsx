import { useNavigate } from "@solidjs/router";
import { type ElementNode, Text, View } from "@solidtv/solid";
import { batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { MENU_WIDTH } from "../components/SideMenu";
import { archiveStart, archiveUrl } from "../data/catchup";
import { DAY, type StoredProgramme } from "../data/guideCodec";
import type { Channel } from "../data/lineup";
import { exposeToProbes } from "../devHooks";
import { guide, library, watched } from "../library";
import { clockTime, duration, timeRange } from "../live/format";
import { handOff, holdPlayer, statusText } from "../live/handoff";
import { firstChoice, nextChoice, trackRows } from "../live/trackRows";
import { createExternalSubtitles } from "../play/externalSubtitles";
import {
  takePlay,
  type CatchupPlay,
  type ExternalSubtitle,
  type PlayRequest,
  type VodPlay,
} from "../play/session";
import { createSeeker } from "../play/seeker";
import { player } from "../player";
import { languageName, sameLanguage } from "../player/language";
import { storedPreferences } from "../player/player";
import type { Stream } from "../player/player";
import { BottomScrim } from "../components/BottomScrim";
import { BOLD, colors, radius } from "../theme";
import { $t } from "../translate";
import { FULL_SCREEN } from "../videoWindow";
import { TrackPanel } from "./live/TrackPanel";

// Full screen for a recording from a channel's catch-up, a film or an
// episode (PLAN.md, Phase 6). A bar along the bottom shows what it is, how
// far it has played and how long it is.
//
// OK, Play and Pause pause and play on; Left and Right (and Rewind and Fast
// forward) seek, in steps that grow while pressed, jumping once the presses
// stop; Down opens the audio and subtitle choices; Up or Info shows or
// hides the bar; Back closes what's open, then leaves, as Stop does.
//
// A recording is a programme's archive asked for from a time, so seeking
// asks for it again from the new time, and the place shown is that time
// plus how far the stream has played since. When it ends, the next
// programme plays if it has been on, or else the channel live.
//
// A film or episode seeks within the stream. Its place is saved every few
// seconds and on leaving (src/data/watched.ts); at the end an episode goes
// on to the next.
//
// A film or episode from an add-on can also have subtitle files, which are
// offered after the stream's own and drawn by the app (PLAN.md, "Stremio
// add-ons", step 6). One in the language last chosen is shown when the
// stream has none in it.

const BAR_MS = 5000;
const SAVE_MS = 10_000;
const TICK_MS = 500;
/** How close to now a recording can be asked for from. */
const LIVE_MARGIN_MS = 30_000;
/** A seek this close to the live margin counts as going live. */
const LIVE_SLACK_MS = 5000;
/** A recording that drops is asked for again this many times. */
const CATCHUP_RETRIES = 3;
const BAR_HEIGHT = 230;
const BAR_X = 80;
const BAR_WIDTH = 1920 - 2 * BAR_X;

/** The Xtream server's time zone, for its archive's times. */
const timeZoneOf = (channel: Channel) => library.statusOf(channel.source).state?.account?.timeZone;

/** A channel's recording from `from`, as a stream. */
const archiveStream = (channel: Channel, programme: StoredProgramme, from: number): Stream | undefined => {
  const url = archiveUrl(channel, {
    from,
    to: programme.stop,
    now: Date.now(),
    timeZone: timeZoneOf(channel),
  });
  return url
    ? { url, userAgent: channel.headers?.userAgent, referer: channel.headers?.referer, live: false }
    : undefined;
};

/** A subtitle file's id among the choices. */
const fileId = (file: ExternalSubtitle) => `${file.from}/${file.id}`;

const playFilm = (film: VodPlay) => {
  void player.play({ ...film.stream, live: false, startMs: film.startMs });
};

/** The programme after `programme` on its channel, if the guide has it. */
const programmeAfter = async (channel: Channel, programme: StoredProgramme) => {
  if (!channel.guideId) return undefined;
  const day = await guide.day(channel.source, channel.guideId, Math.floor(programme.stop / DAY));
  return day.find(next => next.start >= programme.stop);
};

export default () => {
  const navigate = useNavigate();
  let root: ElementNode | undefined;
  holdPlayer();
  player.setWindow(FULL_SCREEN);
  const first = takePlay();
  const [request, setRequest] = createSignal<PlayRequest | undefined>(first);
  const [tick, setTick] = createSignal(Date.now());

  // A recording: the time it was asked for from, the player's position when
  // it started from there, and the place last seen playing, as a stream
  // that stopped has no position.
  let archiveFrom = 0;
  const [basePosition, setBasePosition] = createSignal<number>();
  let lastPlace = 0;
  let catchupRetries = 0;
  const ticker = setInterval(() => {
    setTick(Date.now());
    const recording = catchup();
    const { state } = player.status();
    if (!recording || !["playing", "buffering", "paused"].includes(state)) return;
    lastPlace = place();
    // Many archives don't stop at the programme's end (asked for without a
    // duration, they run on for hours), so past it the next one is asked for.
    if (state === "playing" && lastPlace >= recording.programme.stop) void ended(recording);
  }, TICK_MS);

  const catchup = () => {
    const current = request();
    return current?.kind === "catchup" ? current : undefined;
  };
  const vod = () => {
    const current = request();
    return current?.kind === "vod" ? current : undefined;
  };

  /** Where it has got to: a time of day for a recording, ms into a film. */
  const place = () => {
    tick();
    if (catchup()) {
      const base = basePosition();
      return base === undefined ? archiveFrom : archiveFrom + Math.max(0, player.position() - base);
    }
    return player.position();
  };
  /** The ends of what's playing, in the same terms as place(). */
  const span = () => {
    const recording = catchup();
    if (recording) return { start: recording.programme.start, stop: recording.programme.stop };
    tick();
    return { start: 0, stop: player.duration() };
  };

  const playRecording = (recording: CatchupPlay, asked: number) => {
    const from = archiveStart(recording.channel, asked);
    const stream = archiveStream(recording.channel, recording.programme, from);
    if (!stream) {
      leave();
      return;
    }
    archiveFrom = from;
    lastPlace = from;
    setBasePosition(undefined);
    void player.play(stream);
  };
  const start = (next: PlayRequest) => {
    batch(() => {
      setRequest(next);
      setPaused(false);
      setFiles([]);
    });
    external.off();
    if (next.kind === "vod" && next.subtitles) {
      next
        .subtitles()
        .then(found => {
          if (request() === next) setFiles(found);
          return undefined;
        })
        .catch(() => undefined);
    }
    catchupRetries = 0;
    if (next.kind === "catchup")
      playRecording(next, Math.max(next.programme.start, next.from ?? next.programme.start));
    else playFilm(next);
    showBar();
  };

  const saveFilm = () => {
    const film = vod();
    const { state } = player.status();
    if (!film || !["playing", "paused", "buffering"].includes(state)) return;
    const at = player.position();
    if (at > 0) watched.progress(film.item, at, player.duration());
  };
  const saver = setInterval(saveFilm, SAVE_MS);

  const leave = () => {
    saveFilm();
    seeker.cancel();
    const current = request();
    if (current?.kind === "vod") {
      navigate(current.back, { replace: true });
    } else if (current?.fromLive) {
      goLive(current);
    } else {
      handOff({ channelId: current?.channel.id, group: current?.group });
      navigate("/", { replace: true });
    }
  };
  /** The channel, live, full screen. */
  const goLive = (recording: CatchupPlay) => {
    handOff({ channelId: recording.channel.id, group: recording.group });
    navigate("/watch", { replace: true });
  };

  // The bar, shown for a while after each change, and while paused or seeking.
  const [barShown, setBarShown] = createSignal(true);
  let barTimer: ReturnType<typeof setTimeout> | undefined;
  const showBar = () => {
    setBarShown(true);
    clearTimeout(barTimer);
    barTimer = setTimeout(() => setBarShown(false), BAR_MS);
  };
  const hideBar = () => {
    clearTimeout(barTimer);
    setBarShown(false);
  };

  const [paused, setPaused] = createSignal(false);
  const togglePause = (value = !paused()) => {
    const { state } = player.status();
    if (!["playing", "paused", "buffering"].includes(state)) return;
    setPaused(value);
    player.setPaused(value);
    if (value) {
      clearTimeout(barTimer);
      setBarShown(true);
      saveFilm();
    } else showBar();
  };

  const seeker = createSeeker({
    position: place,
    min: () => span().start,
    max: () => {
      const recording = catchup();
      if (recording) return Math.min(recording.programme.stop, Date.now() - LIVE_MARGIN_MS);
      return Math.max(0, span().stop - 5000);
    },
    commit: target => jumpTo(target),
  });
  /** Plays on from `target`: a time for a recording, ms into a film. */
  const jumpTo = (target: number) => {
    const recording = catchup();
    setPaused(false);
    // Up to now, on a programme still on: that's live.
    const now = Date.now();
    if (recording && recording.programme.stop > now && target >= now - LIVE_MARGIN_MS - LIVE_SLACK_MS) {
      goLive(recording);
      return;
    }
    if (recording) playRecording(recording, target);
    else {
      // The player seeks only while it plays; paused, it plays on there.
      if (player.status().state === "paused") player.setPaused(false);
      player.seek(target);
    }
    showBar();
  };
  const seek = (step: 1 | -1, firstPress = 1) => {
    if (!request() || !span().stop) return;
    hideTracks();
    seeker.press(step, firstPress);
    clearTimeout(barTimer);
    setBarShown(true);
  };
  createEffect(
    on(seeker.target, target => {
      if (target === undefined && !paused()) showBar();
    }),
  );

  // What the player says.
  createEffect(
    on(
      () => player.status().state,
      state => {
        const current = request();
        if (!current) return;
        if (state === "playing" && current.kind === "catchup" && basePosition() === undefined) {
          setBasePosition(player.position());
        }
        if (state === "playing") catchupRetries = 0;
        // A recording that drops is asked for again from where it was; the
        // player would open the same URL there, which a recording can't seek.
        if (current.kind === "catchup" && (state === "reconnecting" || state === "suspended")) {
          if (state === "reconnecting" && catchupRetries < CATCHUP_RETRIES) {
            catchupRetries++;
            playRecording(current, lastPlace);
          }
          return;
        }
        if (state === "ended") void ended(current);
      },
    ),
  );
  // Back from the app being hidden: a recording is asked for again from where it was.
  let hiddenAt: number | undefined;
  createEffect(
    on(
      () => player.status().state,
      state => {
        const recording = catchup();
        if (!recording) return;
        if (state === "suspended") hiddenAt = lastPlace;
        else if (state === "starting" && hiddenAt !== undefined) {
          const at = hiddenAt;
          hiddenAt = undefined;
          playRecording(recording, at);
        }
      },
    ),
  );

  // What's being moved on from, so the ticker and the player don't both do it.
  let ending: PlayRequest | undefined;
  const ended = async (current: PlayRequest) => {
    if (ending === current) return;
    ending = current;
    if (current.kind === "vod") {
      watched.finish(current.item);
      const next = await current.next?.();
      if (request() !== current) return;
      if (next) start(next);
      else leave();
      return;
    }
    const after = await programmeAfter(current.channel, current.programme).catch(() => undefined);
    if (request() !== current) return;
    if (after && after.start < Date.now() - LIVE_MARGIN_MS) {
      start({ ...current, programme: after, from: undefined });
      return;
    }
    // Caught up: the channel, live.
    goLive(current);
  };

  // Subtitle files from add-ons, and the one shown.
  const [files, setFiles] = createSignal<ExternalSubtitle[]>([]);
  const external = createExternalSubtitles({ position: () => player.position() });
  const showFile = (file: ExternalSubtitle) => {
    player.selectTrack("text", undefined);
    void external.show(fileId(file), file.url);
    storedPreferences.save({ ...storedPreferences.load(), text: file.language });
  };
  // Once it plays and the files are known: one in the language last chosen,
  // if the stream shows none of its own.
  createEffect(
    on([() => player.status().state === "playing", files], ([playing, found]) => {
      if (!playing || found.length === 0 || external.chosen()) return;
      const wanted = storedPreferences.load().text;
      if (!wanted || player.tracks().some(track => track.kind === "text" && track.selected)) return;
      const file = found.find(one => sameLanguage(one.language, wanted));
      if (file) showFile(file);
    }),
  );

  // The audio and subtitle choices.
  const [tracksOpen, setTracksOpen] = createSignal(false);
  const [trackCursor, setTrackCursor] = createSignal(0);
  const rows = createMemo(() =>
    trackRows(
      player.tracks(),
      {
        audio: $t("live.tracks.audio"),
        subtitles: $t("live.tracks.subtitles"),
        off: $t("live.tracks.off"),
        noAudio: $t("live.tracks.noAudio"),
        noSubtitles: $t("live.tracks.noSubtitles"),
        unnamed: number => $t("live.tracks.unnamed", { number }),
      },
      files().map(file => ({
        id: fileId(file),
        text: `${languageName(file.language) ?? file.language} · ${file.from}`,
        selected: external.chosen() === fileId(file),
      })),
    ),
  );
  const openTracks = () => {
    hideBar();
    player.refreshTracks();
    setTrackCursor(firstChoice(rows()));
    setTracksOpen(true);
  };
  const hideTracks = () => setTracksOpen(false);

  onMount(() => {
    if (first) start(first);
    else navigate("/", { replace: true });
    root?.setFocus();
  });
  onCleanup(() => {
    saveFilm();
    clearInterval(ticker);
    clearInterval(saver);
    clearTimeout(barTimer);
    seeker.cancel();
    external.off();
  });

  exposeToProbes("playPage", {
    request,
    place,
    span,
    paused,
    barShown,
    tracksOpen,
    seekTarget: seeker.target,
    basePosition,
    seek,
    jumpTo,
    togglePause,
    files,
    externalText: external.text,
    externalChosen: external.chosen,
    rows,
    trackCursor,
  });

  // The bar's words and numbers.
  const title = () => {
    const current = request();
    if (!current) return "";
    return current.kind === "catchup" ? current.programme.title : current.item.title;
  };
  const subtitle = () => {
    const current = request();
    if (!current) return "";
    if (current.kind === "catchup") {
      const { programme, channel } = current;
      const line = `${channel.name}   ${timeRange(programme.start, programme.stop)}`;
      // A programme still on: how far behind live this is.
      const behind = tick() - shownPlace();
      return programme.stop > tick() && behind > LIVE_MARGIN_MS + LIVE_SLACK_MS
        ? `${line}   ·   ${$t("play.behindLive", { time: duration(behind) })}`
        : line;
    }
    return current.item.kind === "episode" ? (current.item.seriesName ?? "") : "";
  };
  const shownPlace = () => seeker.target() ?? place();
  const fraction = () => {
    const { start: from, stop } = span();
    return stop > from ? Math.max(0, Math.min(1, (shownPlace() - from) / (stop - from))) : 0;
  };
  const leftText = () => {
    if (catchup()) return clockTime(shownPlace());
    return duration(shownPlace());
  };
  const rightText = () => {
    const recording = catchup();
    if (recording) return clockTime(recording.programme.stop);
    const { stop } = span();
    return stop > 0 ? duration(stop) : "";
  };
  // How much of a recording's programme has been on so far, as the bar's lighter part.
  const airedFraction = () => {
    const recording = catchup();
    if (!recording) return 1;
    const { start: from, stop } = recording.programme;
    return Math.max(0, Math.min(1, (tick() - from) / (stop - from)));
  };
  const status = () => (paused() ? undefined : statusText());

  return (
    <View
      ref={element => (root = element)}
      x={-MENU_WIDTH}
      width={1920}
      height={1080}
      onEnter={() => {
        if (tracksOpen()) {
          const row = rows()[trackCursor()];
          if (row?.type === "choice") {
            if (row.kind === "text") external.off();
            player.selectTrack(row.kind, row.id);
          } else if (row?.type === "file") {
            const file = files().find(one => fileId(one) === row.id);
            if (file) showFile(file);
          }
        } else if (seeker.target() !== undefined) seeker.finish();
        else togglePause();
        return true;
      }}
      onPlayPause={() => {
        togglePause();
        return true;
      }}
      onPlay={() => {
        togglePause(false);
        return true;
      }}
      onPause={() => {
        togglePause(true);
        return true;
      }}
      onLeft={() => {
        if (tracksOpen()) hideTracks();
        else seek(-1);
        return true;
      }}
      onRight={() => {
        if (tracksOpen()) hideTracks();
        else seek(1);
        return true;
      }}
      onRewind={() => {
        seek(-1, 4);
        return true;
      }}
      onFastForward={() => {
        seek(1, 4);
        return true;
      }}
      onUp={() => {
        if (tracksOpen()) setTrackCursor(nextChoice(rows(), trackCursor(), -1));
        else if (barShown() && !paused()) hideBar();
        else showBar();
        return true;
      }}
      onDown={() => {
        if (tracksOpen()) setTrackCursor(nextChoice(rows(), trackCursor(), 1));
        else openTracks();
        return true;
      }}
      onInfo={() => {
        if (barShown() && !paused()) hideBar();
        else showBar();
        return true;
      }}
      onStop={() => {
        leave();
        return true;
      }}
      onBack={() => {
        if (tracksOpen()) hideTracks();
        else if (seeker.target() !== undefined) {
          seeker.cancel();
          showBar();
        } else if (barShown() && !paused()) hideBar();
        else leave();
        return true;
      }}
    >
      <Show when={status()}>
        {text => (
          <View x={560} y={470} width={800} height={110} borderRadius={radius.xlarge} color={colors.dialog}>
            <Text
              width={800}
              height={110}
              lineHeight={110}
              maxLines={1}
              contain="width"
              textAlign="center"
              fontSize={32}
            >
              {text()}
            </Text>
          </View>
        )}
      </Show>
      <Show when={player.subtitle() ?? external.text()}>
        {text => (
          <View
            x={960}
            y={barShown() ? 1080 - BAR_HEIGHT - 30 : 1010}
            mountX={0.5}
            mountY={1}
            display="flex"
            flexBoundary="contain"
            padding={[12, 28]}
            borderRadius={radius.medium}
            color={colors.caption}
          >
            <Text maxWidth={1500} maxLines={3} textAlign="center" fontSize={42}>
              {text()}
            </Text>
          </View>
        )}
      </Show>
      <Show when={barShown() && request()}>
        <View y={1080 - BAR_HEIGHT} width={1920} height={BAR_HEIGHT}>
          <BottomScrim height={BAR_HEIGHT} />
          <Text x={BAR_X} y={34} width={1300} maxLines={1} contain="width" fontSize={46} fontFamily={BOLD}>
            {title()}
          </Text>
          <Text x={1840} y={40} mountX={1} fontSize={40} fontFamily={BOLD}>
            {clockTime(tick())}
          </Text>
          <Text
            x={BAR_X}
            y={98}
            width={1300}
            maxLines={1}
            contain="width"
            fontSize={28}
            color={colors.textDim}
          >
            {subtitle()}
          </Text>
          <Show when={paused() || seeker.target() !== undefined}>
            <Text
              x={1840}
              y={98}
              mountX={1}
              fontSize={28}
              fontFamily={BOLD}
              color={seeker.target() === undefined ? colors.accentText : colors.gold}
            >
              {paused() ? $t("play.paused") : $t("play.seeking")}
            </Text>
          </Show>
          <View x={BAR_X} y={158} width={BAR_WIDTH} height={8} borderRadius={4} color={colors.track} />
          <View
            x={BAR_X}
            y={158}
            width={BAR_WIDTH * airedFraction()}
            height={8}
            borderRadius={4}
            color={colors.track}
          />
          <View
            x={BAR_X}
            y={158}
            width={BAR_WIDTH * fraction()}
            height={8}
            borderRadius={4}
            color={seeker.target() === undefined ? colors.accent : colors.gold}
          />
          <View
            x={BAR_X + BAR_WIDTH * fraction()}
            y={162}
            mountX={0.5}
            mountY={0.5}
            width={24}
            height={24}
            borderRadius={12}
            color={seeker.target() === undefined ? colors.focus : colors.gold}
            shadow={{ color: "#00000099", blur: 12, spread: 0, x: 0, y: 2 }}
          />
          <Text x={BAR_X} y={180} fontSize={28}>
            {leftText()}
          </Text>
          <Text x={1840} y={180} mountX={1} fontSize={28} color={colors.textDim}>
            {rightText()}
          </Text>
        </View>
      </Show>
      <Show when={tracksOpen()}>
        <TrackPanel rows={rows()} cursor={trackCursor()} />
      </Show>
    </View>
  );
};
