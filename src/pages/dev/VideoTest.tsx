import { useSearchParams } from "@solidjs/router";
import { type ElementNode, Text, View } from "@solidtv/solid";
import { Column } from "@solidtv/solid/primitives";
import { createEffect, createSignal, For, onCleanup, onMount } from "solid-js";
import { MENU_WIDTH } from "../../components/SideMenu";
import { player } from "../../player";
import { FULL_SCREEN, type Rect } from "../../videoWindow";

declare global {
  interface Window {
    videoTestStats?: { fps: number; minFps: number; state: string };
  }
}

// Developer page for PLAN.md's Phase 0 test 2: whether the UI stays smooth
// over video. It plays a stream behind the UI through the app's player
// (src/player/), shows it through a hole in the app's background, and keeps
// the UI moving on top.
//
// Open #/dev/video?url=<stream URL>. Enter switches between a preview window
// and full screen, where the app hides its menu; Back leaves full screen. Up
// and Down move through the list. The yellow frame should sit exactly on the
// video's edges.

// In screen pixels.
const PREVIEW: Rect = { x: MENU_WIDTH + 80, y: 180, width: 960, height: 540 };
const CHANNELS = Array.from({ length: 40 }, (_, i) => `Channel ${i + 1}`);

// A 4-pixel outline drawn as four bars. A bordered node the size of the page
// costs about a third of the frame rate, as its shader runs on every pixel.
const Frame = (props: { rect: Rect }) => {
  const line = { color: "#ffcc00ff" };
  return (
    <>
      <View {...line} x={props.rect.x} y={props.rect.y} width={props.rect.width} height={4} />
      <View
        {...line}
        x={props.rect.x}
        y={props.rect.y + props.rect.height - 4}
        width={props.rect.width}
        height={4}
      />
      <View {...line} x={props.rect.x} y={props.rect.y} width={4} height={props.rect.height} />
      <View
        {...line}
        x={props.rect.x + props.rect.width - 4}
        y={props.rect.y}
        width={4}
        height={props.rect.height}
      />
    </>
  );
};

const ListItem = (props: { label: string }) => {
  const [focused, setFocused] = createSignal(false);
  return (
    <View
      width={400}
      height={64}
      borderRadius={10}
      color={focused() ? "#2e6bd6ff" : "#0b1d33e6"}
      onFocusChanged={setFocused}
    >
      <Text x={20} height={64} lineHeight={64} fontSize={30}>
        {props.label}
      </Text>
    </View>
  );
};

const describeStatus = () => {
  const { state, error, startMs } = player.status();
  if (error) return `${state}: ${error}`;
  return startMs === undefined ? state : `${state}, started in ${startMs} ms`;
};

const VideoTest = () => {
  const [params] = useSearchParams();
  const [full, setFull] = createSignal(false);
  const [fps, setFps] = createSignal(0);
  const [minFps, setMinFps] = createSignal(0);
  let bar: ElementNode | undefined;

  const screenRect = () => (full() ? FULL_SCREEN : PREVIEW);
  // In page pixels: the page sits to the right of the menu.
  const pageRect = () => ({ ...screenRect(), x: screenRect().x - MENU_WIDTH });

  createEffect(() => player.setWindow(screenRect()));

  onMount(() => {
    bar?.animate({ x: 1300 }, { duration: 2000, loop: true, stopMethod: "reverse" }).start();

    // Frames per second as the browser draws them; drops show as stutter.
    let frames = 0;
    let lowest = Infinity;
    let since = performance.now();
    let frame = requestAnimationFrame(function count(now) {
      frames++;
      if (now - since >= 1000) {
        const value = Math.round((frames * 1000) / (now - since));
        // The first second includes start-up.
        if (lowest !== Infinity || value > 5) lowest = Math.min(lowest, value);
        setFps(value);
        setMinFps(lowest);
        window.videoTestStats = { fps: value, minFps: lowest, state: player.status().state };
        frames = 0;
        since = now;
      }
      frame = requestAnimationFrame(count);
    });
    onCleanup(() => cancelAnimationFrame(frame));

    if (typeof params.url === "string") void player.play({ url: params.url });
  });

  onCleanup(() => player.stop());

  return (
    <>
      <Text x={80} y={50} fontSize={48}>
        Video behind the UI
      </Text>
      <Text x={80} y={115} fontSize={28} color="#ffffffb3">
        {`${params.url ? describeStatus() : "add ?url=<stream URL> to the page address"} | ${fps()} fps, lowest ${minFps()} | Enter: ${full() ? "preview" : "full screen"}`}
      </Text>
      <Frame rect={pageRect()} />
      <Column
        autofocus
        x={1110}
        y={180}
        width={400}
        height={860}
        gap={10}
        scroll="auto"
        onEnter={() => {
          setFull(value => !value);
          return true;
        }}
        onBack={() => {
          if (!full()) return false;
          setFull(false);
          return true;
        }}
      >
        <For each={CHANNELS}>{label => <ListItem label={label} />}</For>
      </Column>
      <View
        ref={element => (bar = element)}
        x={80}
        y={1000}
        width={200}
        height={24}
        borderRadius={12}
        color="#2e6bd6ff"
      />
    </>
  );
};

export default VideoTest;
