import { View } from "@solidtv/solid";
import { Show } from "solid-js";
import { colors } from "../theme";

/**
 * The picture behind a film's or series' page, fading into the background
 * to the left and bottom, where the text is. Without one, a faint glow of
 * the accent colour stands in.
 */
export const Backdrop = (props: { width: number; height: number; src?: string }) => {
  const fade = () => Math.round(props.width * 0.32);
  return (
    <View width={props.width} height={props.height} clipping color={colors.background}>
      <View
        width={props.width}
        height={Math.round(props.height * 0.6)}
        colorTop={colors.accentGlow}
        colorBottom={colors.scrimClear}
      />
      {/* The picture stays under the scrims in this box, as a Show adds
          its node at the end of its parent. It's drawn at half size and
          scaled up: under the scrims nobody sees the difference, it takes a
          quarter of the texture memory, and an SVG at full size (1560×1080)
          didn't draw in WebKit. */}
      <View width={props.width} height={props.height}>
        <Show when={props.src} keyed>
          {image => (
            <View
              width={props.width / 2}
              height={props.height / 2}
              scale={2}
              pivot={0}
              src={image}
              textureOptions={{ resizeMode: { type: "cover" } }}
              alpha={0.85}
            />
          )}
        </Show>
      </View>
      <View width={fade()} height={props.height} color={colors.scrimSolid} />
      <View
        x={fade()}
        width={props.width - fade()}
        height={props.height}
        colorLeft={colors.scrimSolid}
        colorRight={colors.scrimLight}
      />
      <View
        y={Math.round(props.height * 0.4)}
        width={props.width}
        height={Math.round(props.height * 0.6)}
        colorTop={colors.scrimClear}
        colorBottom={colors.scrimSolid}
      />
    </View>
  );
};
