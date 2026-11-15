import { Text, View } from "@solidtv/solid";
import { createEffect, createSignal, Show } from "solid-js";
import { sizedImage } from "../images";
import { BOLD, colors, radius } from "../theme";

export interface ArtworkProps {
  x?: number;
  y?: number;
  width: number;
  height: number;
  /** The image; without one, or until it loads, a card with the title stands in. */
  src?: string;
  /** The title on the card standing in for the image. */
  title: string;
  fontSize?: number;
  borderRadius?: number;
  /** Shows the bare card until this is false, as while a held key races past (src/heldKey.ts). */
  wait?: boolean;
  /**
   * Loads the image even while it's off screen, as for a row about to slide
   * in: loaded only once in view, it went to the GPU in the slide's frames.
   */
  preload?: boolean;
}

/**
 * A poster or other artwork, with a card in its place until it loads. The
 * renderer draws text after shapes, so the card's title would show through
 * the image; it hides once the image is in. So does the card under a JPEG,
 * which covers it whole: drawing it anyway cost the poster grid frames on
 * the TV (PLAN.md, "UI performance"). Other pictures, such as PNG logos,
 * may be see-through, so the card stays under those.
 */
/** Pictures with no see-through parts, by their address. */
const OPAQUE = /\.jpe?g(\?|#|$)/i;
const PRELOAD = { preload: true };

export const Artwork = (props: ArtworkProps) => {
  // The image that loaded, so a slot reused for another title shows its card again.
  const [loaded, setLoaded] = createSignal<string | undefined>();
  // Once an image is shown in full it stays so, but only that image: a
  // poster reused for another title waits again while a held key races past.
  const [shown, setShown] = createSignal(props.wait ? undefined : props.src);
  createEffect(() => {
    if (!props.wait) setShown(props.src);
  });
  const ready = () => !props.wait || shown() === props.src;
  const src = () => (ready() ? sizedImage(props.src, props.width) : undefined);
  const hasImage = () => !!src() && loaded() === src();
  const covered = () => hasImage() && OPAQUE.test(src() ?? "");
  const corner = () => props.borderRadius ?? radius.medium;
  const fontSize = () => props.fontSize ?? 28;
  return (
    <View x={props.x ?? 0} y={props.y ?? 0} width={props.width} height={props.height}>
      <View
        width={props.width}
        height={props.height}
        borderRadius={corner()}
        colorTop={colors.surfaceRaised}
        colorBottom={colors.surfaceFaint}
        alpha={covered() ? 0 : 1}
      />
      <Text
        x={20}
        y={24}
        width={props.width - 40}
        maxLines={4}
        contain="width"
        lineHeight={Math.round(fontSize() * 1.3)}
        fontSize={fontSize()}
        fontFamily={BOLD}
        color={colors.textDim}
        alpha={hasImage() || !ready() ? 0 : 1}
      >
        {ready() ? props.title : ""}
      </Text>
      {/* A new node for each image: the renderer keeps showing a node's old
          image until its new one is in, which would be another title's. */}
      <Show when={src()} keyed>
        {image => (
          <View
            width={props.width}
            height={props.height}
            borderRadius={corner()}
            src={image}
            textureOptions={props.preload ? PRELOAD : undefined}
            onEvent={{
              loaded: target => setLoaded(target.src ?? undefined),
              failed: () => setLoaded(undefined),
            }}
          />
        )}
      </Show>
    </View>
  );
};
