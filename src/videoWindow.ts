import { createSignal } from "solid-js";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Where video shows through the UI, in screen pixels on the 1920x1080 app,
// or null when no video is showing. Samsung's player draws video on a layer
// behind the web page, so the app cuts a hole in its background there; see
// src/pages/App.tsx.
export const [videoWindow, setVideoWindow] = createSignal<Rect | null>(null);

export const FULL_SCREEN: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

// Whether video fills the screen, in which case the app hides its menu.
export const videoFillsScreen = () => {
  const video = videoWindow();
  return !!video && video.x <= 0 && video.y <= 0 && video.width >= 1920 && video.height >= 1080;
};
