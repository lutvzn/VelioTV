import { View } from "@solidtv/solid";
import { colors, focusShadow, motion } from "../theme";

/**
 * The cyan glow behind a focused button or row: draw it just before the
 * thing it lights, at the same place. It's always there and fades in and
 * out, as SolidTV picks a node's shadow shader once, when it's made.
 */
export const Glow = (props: {
  x?: number;
  y?: number;
  width: number;
  height: number;
  borderRadius: number;
  shown: boolean;
}) => (
  <View
    x={props.x ?? 0}
    y={props.y ?? 0}
    width={props.width}
    height={props.height}
    borderRadius={props.borderRadius}
    color={colors.focus}
    shadow={focusShadow}
    alpha={props.shown ? 1 : 0}
    transition={{ alpha: motion.quick }}
  />
);
