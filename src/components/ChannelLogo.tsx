import { View } from "@solidtv/solid";
import { createSignal } from "solid-js";

/**
 * A channel's logo, fitted inside its box whatever its shape. Logos that
 * fail to load leave the box empty.
 */
export const ChannelLogo = (props: { x: number; y: number; width: number; height: number; src: string }) => {
  const [failed, setFailed] = createSignal<string | undefined>();
  return (
    <View
      x={props.x}
      y={props.y}
      width={props.width}
      height={props.height}
      src={props.src}
      textureOptions={{ resizeMode: { type: "contain" } }}
      alpha={failed() === props.src ? 0 : 1}
      onEvent={{ failed: target => setFailed(target.src ?? undefined) }}
    />
  );
};
