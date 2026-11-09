import { View } from "@solidtv/solid";

/** Whether a colour ("#rrggbbaa", or the number the build makes of it) is fully see-through. */
export const isClear = (color: string | number) =>
  typeof color === "number" ? (color & 0xff) === 0 : color.length === 9 && color.endsWith("00");

/**
 * A rounded background, such as a row's highlight, that's clear at times.
 * The renderer draws a node with rounded corners even when its colour is
 * clear, running the corner shader over every pixel of it for nothing, so
 * a clear fill is hidden instead (a hidden node isn't drawn). Draw it as
 * the first child of the row it lights, at the row's size.
 */
export const Fill = (props: {
  x?: number;
  y?: number;
  width: number;
  height: number;
  borderRadius: number;
  color: string;
}) => (
  <View
    x={props.x ?? 0}
    y={props.y ?? 0}
    width={props.width}
    height={props.height}
    borderRadius={props.borderRadius}
    color={props.color}
    alpha={isClear(props.color) ? 0 : 1}
  />
);
