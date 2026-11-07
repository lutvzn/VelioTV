import { Text, View } from "@solidtv/solid";
import { batch, createEffect, createMemo, createSignal, Index } from "solid-js";
import type { Channel } from "../../data/lineup";
import { exposeToProbes } from "../../devHooks";
import { scrollTop, wrapIndex } from "../../live/listWindow";
import { channelMenu, type Menu, type MenuOption } from "./menus";

export type { Menu, MenuOption } from "./menus";

export const OPTIONS_WIDTH = 640;
/**
 * For views drawn over others. The renderer holds text back and draws it
 * after the shapes, except that a shape with a zIndex first draws the text
 * queued before it; without one, the text behind a panel shows through it.
 */
export const OVERLAY_Z = 1;
/** How long OK is held on a channel to open its options. */
export const HOLD_MS = 600;
/**
 * A Samsung remote sends one key-down when OK is pressed and one key-up when
 * it's let go, with no repeats between (`keys` probe, 2026-11-07), so a press
 * still down after HOLD_MS is a hold. useHold otherwise waits for a repeat
 * and takes every press for a tap.
 */
export const HOLD_REQUIRES_REPEAT = false;
const ROW_HEIGHT = 66;
const ROWS_Y = 150;
const ROW_WIDTH = OPTIONS_WIDTH - 48;
/** Rows drawn; longer menus, such as every group to move to, scroll. */
const ROWS = Math.floor((1080 - ROWS_Y - 30) / ROW_HEIGHT);
const SLOTS = Array.from({ length: ROWS }, (_, slot) => slot);

interface Level {
  menu: Menu;
  cursor: number;
  top: number;
}

/**
 * A menu down the right of the screen (PLAN.md, Phase 5), such as a
 * channel's options, opened by holding OK on a channel or with the Tools
 * key. It takes the focus while open and keeps every key from the page
 * behind: Up and Down move, OK does the option, which may open another menu
 * in its place, and otherwise closes; Back goes back a menu, or closes.
 */
export const OptionsPanel = (props: {
  menu: Menu;
  /** The panel's left edge in its parent's pixels; it runs to the screen's right edge. */
  x: number;
  onClose: () => void;
}) => {
  const [stack, setStack] = createSignal<Level[]>([{ menu: props.menu, cursor: 0, top: 0 }]);
  const level = () => stack()[stack().length - 1];
  const options = createMemo(() => level().menu.options());
  const setLevel = (change: Partial<Level>) =>
    setStack(levels => [...levels.slice(0, -1), { ...levels[levels.length - 1], ...change }]);
  const place = (cursor: number) =>
    setLevel({ cursor, top: scrollTop(cursor, level().top, ROWS, options().length) });
  // An option that went away, such as after a change, leaves the cursor in range.
  createEffect(() => {
    const count = options().length;
    if (count > 0 && level().cursor >= count) place(count - 1);
  });
  const move = (step: number) => {
    place(wrapIndex(level().cursor, step, options().length));
    return true;
  };
  const back = () => {
    if (stack().length > 1) setStack(levels => levels.slice(0, -1));
    else props.onClose();
    return true;
  };

  exposeToProbes("channelOptions", {
    title: () => level().menu.title,
    depth: () => stack().length,
    cursor: () => level().cursor,
    options: () => options().map(option => option.id),
  });

  return (
    <View
      autofocus
      // Over the page's text: the renderer draws text after the shapes
      // queued with it, unless a shape has a zIndex.
      zIndex={OVERLAY_Z}
      x={props.x}
      width={OPTIONS_WIDTH}
      height={1080}
      color="#071423f2"
      onUp={() => move(-1)}
      onDown={() => move(1)}
      onEnter={() => {
        const next = options()[level().cursor]?.run();
        if (next === "stay") return true;
        if (next) batch(() => setStack(levels => [...levels, { menu: next, cursor: 0, top: 0 }]));
        else props.onClose();
        return true;
      }}
      onBack={back}
      onTools={() => {
        props.onClose();
        return true;
      }}
      // Every other key stops here.
      onKeyPress={() => true}
    >
      <Text x={32} y={56} width={ROW_WIDTH} maxLines={1} contain="width" fontSize={36}>
        {level().menu.title}
      </Text>
      <Index each={SLOTS}>
        {slot => {
          const at = () => level().top + slot();
          const option = () => options()[at()] as MenuOption | undefined;
          return (
            <View
              x={24}
              y={ROWS_Y + slot() * ROW_HEIGHT}
              width={ROW_WIDTH}
              height={ROW_HEIGHT - 6}
              borderRadius={10}
              alpha={option() ? 1 : 0}
              color={at() === level().cursor ? "#2e6bd6ff" : "#00000000"}
            >
              <Text
                x={24}
                width={ROW_WIDTH - 48}
                height={ROW_HEIGHT - 6}
                lineHeight={ROW_HEIGHT - 6}
                maxLines={1}
                contain="width"
                fontSize={32}
                color={option()?.dim ? "#ffffffb3" : "#ffffffff"}
              >
                {option()?.label ?? ""}
              </Text>
            </View>
          );
        }}
      </Index>
    </View>
  );
};

/** A channel's options (src/pages/live/menus.ts), with any the page adds after the first. */
export const ChannelOptions = (props: {
  channel: Channel;
  x: number;
  onClose: () => void;
  extra?: MenuOption[];
}) => <OptionsPanel menu={channelMenu(props.channel, props.extra)} x={props.x} onClose={props.onClose} />;
