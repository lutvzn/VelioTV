import { type ElementNode, Text, View } from "@solidtv/solid";
import { Column, type KeyHandler } from "@solidtv/solid/primitives";
import { createSignal, For } from "solid-js";
import { OVERLAY_Z } from "../pages/live/ChannelOptions";
import type { Section } from "../sections";
import { BOLD, colors, radius } from "../theme";
import { $t, type TextKey } from "../translate";
import { Fill } from "./Fill";
import { Glow } from "./Glow";

/** The rail's width at rest, which pages start right of. */
export const MENU_WIDTH = 96;
/** Its width while it has the focus, drawn over the page. */
export const MENU_OPEN_WIDTH = 340;
const OPEN_WIDTH = MENU_OPEN_WIDTH;

// Whether the rail is open, for what sits beside it to move aside, such as
// the guide's groups. There's one menu.
const [open, setOpen] = createSignal(false);
export const menuOpen = open;
const ITEM_X = 16;
const ITEM_SIZE = 64;
const OPEN_ITEM_WIDTH = OPEN_WIDTH - 2 * ITEM_X;
const ICON_SIZE = 32;
const LOGO_SIZE = 52;
const LOGO_X = (MENU_WIDTH - LOGO_SIZE) / 2;
const ITEMS_Y = 200;
/** The shade the open rail casts over the page. */
const SHADE_WIDTH = 260;

const MenuItem = (props: { label: TextKey; icon: string; current: boolean; open: boolean }) => {
  const [focused, setFocused] = createSignal(false);
  const width = () => (props.open ? OPEN_ITEM_WIDTH : ITEM_SIZE);
  const ink = () => {
    if (focused()) return colors.onFocus;
    return props.current ? colors.accentText : colors.textDim;
  };

  return (
    <View width={width()} height={ITEM_SIZE} onFocusChanged={setFocused}>
      <Fill
        width={width()}
        height={ITEM_SIZE}
        borderRadius={radius.large}
        color={props.current && !focused() ? colors.accentWash : colors.transparent}
      />
      <Glow width={width()} height={ITEM_SIZE} borderRadius={radius.large} shown={focused()} />
      <View
        x={(ITEM_SIZE - ICON_SIZE) / 2}
        y={(ITEM_SIZE - ICON_SIZE) / 2}
        width={ICON_SIZE}
        height={ICON_SIZE}
        src={props.icon}
        color={ink()}
      />
      <Text
        x={ITEM_SIZE + 4}
        height={ITEM_SIZE}
        lineHeight={ITEM_SIZE}
        fontSize={28}
        fontFamily={focused() || props.current ? BOLD : undefined}
        color={focused() ? colors.onFocus : props.current ? colors.text : colors.textDim}
        alpha={props.open ? 1 : 0}
      >
        {$t(props.label)}
      </Text>
    </View>
  );
};

interface SideMenuProps {
  ref?: ElementNode | ((element: ElementNode) => void);
  autofocus?: boolean;
  hidden?: boolean;
  sections: readonly Section[];
  currentPath: string;
  onSelect: (path: string) => void;
  /** A line at the bottom, such as an import in progress. */
  status?: string;
  onRight?: KeyHandler;
  onBack?: KeyHandler;
}

/**
 * The menu: a rail of icons on the left that widens over the page, with the
 * sections' names, while it has the focus. Moving up and down opens each
 * section straight away.
 */
export const SideMenu = (props: SideMenuProps) => {
  // Follows the page, which can also change from the pages themselves.
  const currentIndex = () =>
    Math.max(
      0,
      props.sections.findIndex(section => section.path === props.currentPath),
    );
  const width = () => (open() ? OPEN_WIDTH : MENU_WIDTH);

  return (
    // The rail's panel is its root. Its zIndex draws the page's text before
    // it, which the renderer would otherwise draw over the open rail
    // (PLAN.md, Phase 5, step 1, "Text showing through the panel").
    <View width={width()} height={1080} color={colors.menu} zIndex={OVERLAY_Z} alpha={props.hidden ? 0 : 1}>
      <View
        x={width()}
        width={SHADE_WIDTH}
        height={1080}
        colorLeft={colors.caption}
        colorRight={colors.transparent}
        alpha={open() ? 1 : 0}
      />
      <View x={width() - 1} width={1} height={1080} color={colors.line} />
      <View
        x={LOGO_X}
        y={48}
        width={LOGO_SIZE}
        height={LOGO_SIZE}
        borderRadius={radius.large}
        colorTop={colors.accentTop}
        colorBottom={colors.accentBottom}
      >
        <Text
          width={LOGO_SIZE}
          height={LOGO_SIZE}
          lineHeight={LOGO_SIZE}
          contain="width"
          textAlign="center"
          fontSize={32}
          fontFamily={BOLD}
          color={colors.onFocus}
        >
          V
        </Text>
      </View>
      <Text
        x={LOGO_X + LOGO_SIZE + 18}
        y={48}
        height={LOGO_SIZE}
        lineHeight={LOGO_SIZE}
        fontSize={38}
        fontFamily={BOLD}
        alpha={open() ? 1 : 0}
      >
        Velio
      </Text>
      <Column
        ref={props.ref}
        autofocus={props.autofocus}
        x={ITEM_X}
        y={ITEMS_Y}
        width={OPEN_ITEM_WIDTH}
        height={1080 - ITEMS_Y - 160}
        gap={14}
        scroll="none"
        selected={currentIndex()}
        onFocusChanged={setOpen}
        // Column also reports the selection each time the menu takes focus;
        // only an actual move opens a section.
        onSelectedChanged={(index, _menu, _item, lastIndex) => {
          if (index !== lastIndex) props.onSelect(props.sections[index].path);
        }}
        onRight={props.onRight}
        onBack={props.onBack}
      >
        <For each={props.sections}>
          {section => (
            <MenuItem
              label={section.label}
              icon={section.icon}
              current={section.path === props.currentPath}
              open={open()}
            />
          )}
        </For>
      </Column>
      {/* An import in progress: a dot on the rail, and its words when open. */}
      <View
        x={(MENU_WIDTH - 12) / 2}
        y={1080 - 72}
        width={12}
        height={12}
        borderRadius={6}
        color={colors.gold}
        alpha={props.status && !open() ? 1 : 0}
      />
      <Text
        x={ITEM_X + 8}
        y={1080 - 110}
        width={OPEN_WIDTH - 2 * ITEM_X - 16}
        contain="width"
        maxLines={2}
        lineHeight={30}
        fontSize={22}
        color={colors.textFaint}
        alpha={open() ? 1 : 0}
      >
        {props.status ?? ""}
      </Text>
    </View>
  );
};
