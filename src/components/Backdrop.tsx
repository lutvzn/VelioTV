import { View } from "@solidtv/solid";
import { createSignal, Show } from "solid-js";
import { sizedImage } from "../images";
import { colors } from "../theme";

/**
 * The picture behind a film's or series' page, fading into the background
 * to the left and bottom, where the text is. Without one, a faint glow of
 * the accent colour stands in.
 *
 * It's drawn over the app's background, which has the same colour as the
 * fades' solid end. The TV's GPU is short of fill rate (a page of these
 * layers drew at 26 fps, PLAN.md, "UI performance"), so nothing is drawn where it
 * would end up the background colour anyway: left of `fade()` the page
 * shows the background itself, and the glow goes once the picture is in,
 * as under it the glow showed through only faintly.
 */
export const Backdrop = (props: { width: number; height: number; src?: string }) => {
  const fade = () => Math.round(props.width * 0.32);
  // The picture that loaded, so another page's picture shows the glow again until it's in.
  const [loaded, setLoaded] = createSignal<string | undefined>();
  const src = () => sizedImage(props.src, props.width / 2);
  return (
    <View width={props.width} height={props.height}>
      {/* Only right of the fade; the picture and glow stay in place, cut off at it. */}
      <View x={fade()} width={props.width - fade()} height={props.height} clipping>
        <View
          x={-fade()}
          width={props.width}
          height={Math.round(props.height * 0.6)}
          colorTop={colors.accentGlow}
          colorBottom={colors.scrimClear}
          alpha={loaded() && loaded() === src() ? 0 : 1}
        />
        {/* Drawn at half size and scaled up: under the scrims nobody sees the
            difference, it takes a quarter of the texture memory, and an SVG at
            full size (1560×1080) didn't draw in WebKit. */}
        <View x={-fade()} width={props.width} height={props.height}>
          <Show when={src()} keyed>
            {image => (
              <View
                width={props.width / 2}
                height={props.height / 2}
                scale={2}
                pivot={0}
                src={image}
                textureOptions={{ resizeMode: { type: "cover" } }}
                alpha={0.85}
                onEvent={{
                  loaded: target => setLoaded(target.src ?? undefined),
                  failed: () => setLoaded(undefined),
                }}
              />
            )}
          </Show>
        </View>
      </View>
      <View
        x={fade()}
        width={props.width - fade()}
        height={props.height}
        colorLeft={colors.scrimSolid}
        colorRight={colors.scrimLight}
      />
      <View
        x={fade()}
        y={Math.round(props.height * 0.4)}
        width={props.width - fade()}
        height={Math.round(props.height * 0.6)}
        colorTop={colors.scrimClear}
        colorBottom={colors.scrimSolid}
      />
    </View>
  );
};
