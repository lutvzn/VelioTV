import { Text, View } from "@solidtv/solid";
import { createMemo, createSignal, For } from "solid-js";
import type { Channel } from "../../data/lineup";
import { exposeToProbes } from "../../devHooks";
import { wrapIndex } from "../../live/listWindow";
import { edits } from "../../library";
import { $t } from "../../translate";

export const OPTIONS_WIDTH = 640;
/** How long OK is held on a channel to open its options. */
export const HOLD_MS = 600;
const ROW_HEIGHT = 66;
const ROWS_Y = 150;
const ROW_WIDTH = OPTIONS_WIDTH - 48;

interface ChannelOption {
  id: string;
  label: string;
  run: () => void;
}

export interface ChannelOptionsProps {
  channel: Channel;
  /** The panel's left edge in its parent's pixels; it runs to the screen's right edge. */
  x: number;
  onClose: () => void;
}

/**
 * A channel's options, down the right of the screen (PLAN.md, Phase 5,
 * step 1), opened by holding OK on a channel or with the Tools key. It takes
 * the focus while open and keeps every key from the page behind: Up and Down
 * move, OK does the option and closes, Back closes.
 */
export const ChannelOptions = (props: ChannelOptionsProps) => {
  const [cursor, setCursor] = createSignal(0);
  const options = createMemo((): ChannelOption[] => {
    const id = props.channel.id;
    return [
      {
        id: "favourite",
        label: edits.isFavourite(id) ? $t("options.unfavourite") : $t("options.favourite"),
        run: () => edits.toggleFavourite(id),
      },
    ];
  });
  const move = (step: number) => {
    setCursor(at => wrapIndex(at, step, options().length));
    return true;
  };

  exposeToProbes("channelOptions", {
    channel: () => props.channel,
    cursor,
    options: () => options().map(option => option.id),
  });

  return (
    <View
      autofocus
      x={props.x}
      width={OPTIONS_WIDTH}
      height={1080}
      color="#071423f2"
      onUp={() => move(-1)}
      onDown={() => move(1)}
      onEnter={() => {
        options()[cursor()]?.run();
        props.onClose();
        return true;
      }}
      onBack={() => {
        props.onClose();
        return true;
      }}
      onTools={() => {
        props.onClose();
        return true;
      }}
      // Every other key stops here.
      onKeyPress={() => true}
    >
      <Text x={32} y={56} width={ROW_WIDTH} maxLines={1} contain="width" fontSize={36}>
        {props.channel.name}
      </Text>
      <For each={options()}>
        {(option, at) => (
          <View
            x={24}
            y={ROWS_Y + at() * ROW_HEIGHT}
            width={ROW_WIDTH}
            height={ROW_HEIGHT - 6}
            borderRadius={10}
            color={at() === cursor() ? "#2e6bd6ff" : "#00000000"}
          >
            <Text
              x={24}
              width={ROW_WIDTH - 48}
              height={ROW_HEIGHT - 6}
              lineHeight={ROW_HEIGHT - 6}
              maxLines={1}
              contain="width"
              fontSize={32}
            >
              {option.label}
            </Text>
          </View>
        )}
      </For>
    </View>
  );
};
