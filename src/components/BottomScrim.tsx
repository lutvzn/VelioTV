import { View } from "@solidtv/solid";
import { colors } from "../theme";

const FADE = 180;

/**
 * The shade under a bar along the bottom of the screen over video: dark
 * where the bar's text is, and fading out above it rather than ending in
 * an edge. Draw it first in the bar; it reaches FADE pixels above the bar.
 */
export const BottomScrim = (props: { height: number }) => (
  <>
    <View y={-FADE} width={1920} height={FADE} colorTop={colors.scrimClear} colorBottom={colors.scrimSoft} />
    <View width={1920} height={props.height} colorTop={colors.scrimSoft} colorBottom={colors.scrim} />
  </>
);
