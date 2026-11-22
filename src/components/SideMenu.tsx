import { type ElementNode, Text, View } from "@solidtv/solid";
import { Column, type KeyHandler } from "@solidtv/solid/primitives";
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { OVERLAY_Z } from "../pages/live/ChannelOptions";
import { CURSOR_REST_MS, createRestingCursor } from "../restingCursor";
import type { Section } from "../sections";
import type { DeviceProfile } from "../data/accountView";
import { BOLD, colors, radius, RING } from "../theme";
import { $t, type TextKey } from "../translate";
import { Fill } from "./Fill";
import { ProfileBadge } from "./ProfileBadge";

/** The rail's width at rest, which pages start right of. */
export const MENU_WIDTH = 96;
/** Its width while it has the focus, drawn over the page. */
export const MENU_OPEN_WIDTH = 340;
const OPEN_WIDTH = MENU_OPEN_WIDTH;

// Whether the rail is open, for what sits beside it to move aside, such as
// the guide's groups. There's one menu.
const [open, setOpen] = createSignal(false);
export const menuOpen = open;
/** How far the open menu reaches past the closed one: what's beside it moves right by this. */
export const menuShift = () => (open() ? MENU_OPEN_WIDTH - MENU_WIDTH : 0);
const ITEM_X = 16;
const ITEM_SIZE = 64;
const OPEN_ITEM_WIDTH = OPEN_WIDTH - 2 * ITEM_X;
const ICON_SIZE = 32;
const LOGO_SIZE = 52;
const LOGO_X = (MENU_WIDTH - LOGO_SIZE) / 2;
const ITEM_GAP = 14;
const BADGE_SIZE = 60;
/** The profile item is larger than the sections; centred on the same line. */
const PROFILE_SIZE = 84;
const PROFILE_X = ITEM_X - (PROFILE_SIZE - ITEM_SIZE) / 2;
const PROFILE_OPEN_WIDTH = OPEN_ITEM_WIDTH + (ITEM_X - PROFILE_X) * 2;
/** The profile's place, at the top of the rail. */
const PROFILE_Y = 42;
/** The logo's place, at the bottom of the rail. */
const LOGO_Y = 1080 - 48 - LOGO_SIZE;
/** Where the profile page is, which the profile at the top opens. */
export const PROFILES_PATH = "/profiles";
/**
 * An item's background: a cyan ring with an opaque fill when it has the
 * focus, as in the group columns; a cyan wash when it's the section open.
 */
const ItemBackground = (props: { width: number; height: number; focused: boolean; current: boolean }) => (
  <>
    <Fill
      width={props.width}
      height={props.height}
      borderRadius={radius.large}
      color={props.focused ? colors.focus : props.current ? colors.accentWash : colors.transparent}
    />
    <Fill
      x={RING}
      y={RING}
      width={props.width - 2 * RING}
      height={props.height - 2 * RING}
      borderRadius={radius.large - RING}
      color={props.focused ? colors.highlight : colors.transparent}
    />
  </>
);

const MenuItem = (props: { label: TextKey; icon: string; current: boolean; open: boolean }) => {
  const [focused, setFocused] = createSignal(false);
  const width = () => (props.open ? OPEN_ITEM_WIDTH : ITEM_SIZE);
  const ink = () => {
    if (focused()) return colors.accentText;
    return props.current ? colors.accentText : colors.textDim;
  };

  return (
    <View width={width()} height={ITEM_SIZE} onFocusChanged={setFocused}>
      <ItemBackground width={width()} height={ITEM_SIZE} focused={focused()} current={props.current} />
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
        color={focused() ? colors.accentText : props.current ? colors.text : colors.textDim}
        alpha={props.open ? 1 : 0}
      >
        {$t(props.label)}
      </Text>
    </View>
  );
};

/** The profile in use, at the top of the rail: its badge, and its name while open. */
const ProfileItem = (props: {
  ref: (element: ElementNode) => void;
  profile: DeviceProfile;
  current: boolean;
  open: boolean;
  onEnter: () => boolean;
  onDown: () => boolean;
}) => {
  const [focused, setFocused] = createSignal(false);
  const width = () => (props.open ? PROFILE_OPEN_WIDTH : PROFILE_SIZE);
  return (
    <View
      ref={props.ref}
      // For probes' focusPath().
      id="menuProfile"
      x={PROFILE_X}
      y={PROFILE_Y}
      width={width()}
      height={PROFILE_SIZE}
      onFocusChanged={setFocused}
      onEnter={props.onEnter}
      onRight={props.onEnter}
      onDown={props.onDown}
      // The first item: Up stays here.
      onUp={() => true}
      announce={$t("menu.profileOf", { name: props.profile.name })}
    >
      <ItemBackground width={width()} height={PROFILE_SIZE} focused={focused()} current={props.current} />
      <View
        x={(PROFILE_SIZE - BADGE_SIZE) / 2}
        y={(PROFILE_SIZE - BADGE_SIZE) / 2}
        width={BADGE_SIZE}
        height={BADGE_SIZE}
      >
        <ProfileBadge profile={props.profile} size={BADGE_SIZE} />
      </View>
      <Text
        x={PROFILE_SIZE + 4}
        width={PROFILE_OPEN_WIDTH - PROFILE_SIZE - 20}
        height={PROFILE_SIZE}
        lineHeight={PROFILE_SIZE}
        maxLines={1}
        contain="width"
        fontSize={30}
        fontFamily={focused() || props.current ? BOLD : undefined}
        color={focused() ? colors.accentText : props.current ? colors.text : colors.textDim}
        alpha={props.open ? 1 : 0}
      >
        {props.profile.name}
      </Text>
    </View>
  );
};

interface SideMenuProps {
  ref?: (element: ElementNode) => void;
  autofocus?: boolean;
  hidden?: boolean;
  /** Whether the TV is connected to a Velio server: a green light by the name, else red. */
  online?: boolean;
  sections: readonly Section[];
  currentPath: string;
  onSelect: (path: string) => void;
  /** The cursor has rested on a section that isn't open: warm what its page needs. */
  onPreload?: (path: string) => void;
  /** A line at the bottom, such as an import in progress. */
  status?: string;
  /** Right: moves into the section, once it's open. */
  onRight?: () => boolean;
  onBack?: KeyHandler;
  /** The profile in use, at the top; OK on it opens the profile page. */
  profile?: DeviceProfile;
  profileRef?: (element: ElementNode) => void;
}

/**
 * The menu: a rail of icons on the left that widens over the page, with the
 * sections' names, while it has the focus. The section under the cursor
 * opens once the cursor rests (`CURSOR_REST_MS`), or at once on Right or
 * OK, which also move into it. The profile in use is at the top, Up
 * from the first section; OK or Right on it opens the profile page.
 */
export const SideMenu = (props: SideMenuProps) => {
  // Follows the page, which can also change from the pages themselves.
  const currentIndex = () =>
    Math.max(
      0,
      props.sections.findIndex(section => section.path === props.currentPath),
    );
  const width = () => (open() ? OPEN_WIDTH : MENU_WIDTH);
  // The sections, centred on the screen.
  const itemsHeight = () => props.sections.length * (ITEM_SIZE + ITEM_GAP) - ITEM_GAP;

  // The section under the cursor opens only on OK (or Right), not as the cursor passes.
  const cursor = createRestingCursor(
    () => props.currentPath,
    path => props.onSelect(path),
    { manual: true },
  );
  // A section opened by Right, to move into once it's there.
  let enter: string | undefined;
  createEffect(
    on(
      () => props.currentPath,
      path => {
        if (enter !== path) return;
        enter = undefined;
        // The router opens the page in a transition; it's in once the path changed.
        setTimeout(() => props.onRight?.());
      },
      { defer: true },
    ),
  );
  const onRight = () => {
    enter = cursor.settle();
    return enter ? true : (props.onRight?.() ?? false);
  };
  // Once the cursor rests on a section, its page is warmed (not opened).
  let warmTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(warmTimer));
  let column: ElementNode | undefined;
  let profileItem: ElementNode | undefined;
  const openProfiles = () => {
    if (props.currentPath === PROFILES_PATH) return props.onRight?.() ?? true;
    enter = PROFILES_PATH;
    props.onSelect(PROFILES_PATH);
    return true;
  };

  return (
    // The rail's panel is its root. Its zIndex draws the page's text before
    // it, which the renderer would otherwise draw over the open rail
    // (PLAN.md, Phase 5, step 1, "Text showing through the panel").
    <View
      width={width()}
      height={1080}
      color={colors.menu}
      zIndex={OVERLAY_Z}
      alpha={props.hidden ? 0 : 1}
      // Open while the sections or the profile have the focus.
      onFocusChanged={setOpen}
      // Up past the first section, which the column leaves, goes to the profile.
      onUp={() => {
        if (!profileItem || !props.profile) return false;
        profileItem.setFocus();
        return true;
      }}
    >
      <View x={width() - 1} width={1} height={1080} color={colors.line} />
      <View
        x={LOGO_X}
        y={LOGO_Y}
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
        y={LOGO_Y}
        height={LOGO_SIZE}
        lineHeight={LOGO_SIZE}
        fontSize={38}
        fontFamily={BOLD}
        alpha={open() ? 1 : 0}
      >
        Velio
      </Text>
      {/* The light: green when connected to a Velio server, red when not. */}
      <View
        x={OPEN_WIDTH - ITEM_X - 8 - 14}
        y={LOGO_Y + (LOGO_SIZE - 14) / 2}
        width={14}
        height={14}
        borderRadius={7}
        color={props.online ? colors.online : colors.dangerFill}
        alpha={open() ? 1 : 0}
      />
      <Column
        ref={element => {
          column = element;
          props.ref?.(element);
        }}
        autofocus={props.autofocus}
        x={ITEM_X}
        y={(1080 - itemsHeight()) / 2}
        width={OPEN_ITEM_WIDTH}
        height={itemsHeight()}
        gap={ITEM_GAP}
        scroll="none"
        selected={currentIndex()}
        onFocusChanged={hasFocus => {
          // Leaving without OK, the cursor goes back to the open section, so
          // it's there when the menu has the keys again.
          if (hasFocus) return;
          cursor.drop();
          if (column) column.selected = currentIndex();
        }}
        // Column also reports the selection each time the menu takes focus;
        // only an actual move opens a section.
        onSelectedChanged={(index, _menu, _item, lastIndex) => {
          if (index === lastIndex) return;
          enter = undefined;
          const path = props.sections[index].path;
          cursor.move(path);
          clearTimeout(warmTimer);
          if (path !== props.currentPath)
            warmTimer = setTimeout(() => props.onPreload?.(path), CURSOR_REST_MS);
        }}
        onRight={onRight}
        // OK too, as in the group columns beside the guide and the posters.
        onEnter={onRight}
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
        y={LOGO_Y - 36}
        width={12}
        height={12}
        borderRadius={6}
        color={colors.gold}
        alpha={props.status && !open() ? 1 : 0}
      />
      <Text
        x={ITEM_X + 8}
        y={LOGO_Y - 84}
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
      <Show when={props.profile}>
        {profile => (
          <ProfileItem
            ref={element => {
              profileItem = element;
              props.profileRef?.(element);
            }}
            profile={profile()}
            current={props.currentPath === PROFILES_PATH}
            open={open()}
            onEnter={openProfiles}
            onDown={() => {
              column?.setFocus();
              return true;
            }}
          />
        )}
      </Show>
    </View>
  );
};
