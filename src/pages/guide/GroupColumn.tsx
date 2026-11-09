import { Text, View } from "@solidtv/solid";
import { For, type JSX, Show } from "solid-js";
import { Glow } from "../../components/Glow";
import { OVERLAY_Z } from "../live/ChannelOptions";
import { BOLD, colors, radius, RING } from "../../theme";
import { $t } from "../../translate";

/** The column's width, which the guide starts right of. */
export const GROUPS_WIDTH = 320;
const ITEM_X = 16;
const ITEM_WIDTH = GROUPS_WIDTH - 2 * ITEM_X;
const ITEM_HEIGHT = 60;
const ITEM_STEP = 70;
const SEARCH_Y = 112;
const LIST_Y = 204;
/** How many groups show at once; the rest scroll. */
export const GROUP_ROWS = 12;
const SLOTS = Array.from({ length: GROUP_ROWS }, (_, slot) => slot);
const ICON_SIZE = 28;
const COUNT_WIDTH = 56;

/** Where the search field is, in the column's pixels, for the keyboard's input. */
export const SEARCH_RECT = { x: ITEM_X, y: SEARCH_Y, width: ITEM_WIDTH, height: ITEM_HEIGHT };

export interface GroupItem {
  label: string;
  count: number;
}

/** The text colour in a row, given whether it has the focus or is the group shown. */
const inkFor = (focused: boolean, current: boolean) => {
  if (focused) return colors.accentText;
  return current ? colors.text : colors.textDim;
};

/**
 * A row in the column: a cyan ring with an opaque fill when it has the
 * focus, a cyan wash when it's the group shown.
 */
const Item = (props: { y: number; focused: boolean; current: boolean; children: JSX.Element }) => (
  <View
    x={ITEM_X}
    y={props.y}
    width={ITEM_WIDTH}
    height={ITEM_HEIGHT}
    borderRadius={radius.medium}
    color={props.focused ? colors.focus : props.current ? colors.accentWash : colors.transparent}
  >
    <View
      x={RING}
      y={RING}
      width={ITEM_WIDTH - 2 * RING}
      height={ITEM_HEIGHT - 2 * RING}
      borderRadius={radius.medium - RING}
      color={props.focused ? colors.highlight : colors.transparent}
    />
    {props.children}
  </View>
);

/**
 * Live TV's groups, in a column beside the menu, with the guide right of it: a search
 * field, then every channel, Favourites and the playlists' groups. The guide
 * page moves the cursor; this only draws. `cursor` is -1 on the search field.
 */
export const GroupColumn = (props: {
  x: number;
  /** Whether it shows; the guide moves right of it then. */
  shown: boolean;
  items: readonly GroupItem[];
  /** The first group drawn. */
  top: number;
  cursor: number;
  /** The group shown in the guide. */
  current: number;
  focused: boolean;
  query: string;
}) => {
  const slotY = (slot: number) => LIST_Y + slot * ITEM_STEP;
  const searchFocused = () => props.focused && props.cursor < 0;
  const glowY = () => (props.cursor < 0 ? SEARCH_Y : slotY(props.cursor - props.top));

  return (
    // Its zIndex draws the guide's text before it (PLAN.md, Phase 5, step 1).
    <View
      x={props.x}
      width={GROUPS_WIDTH}
      height={1080}
      color={colors.menu}
      zIndex={OVERLAY_Z}
      alpha={props.shown ? 1 : 0}
    >
      <View x={GROUPS_WIDTH - 1} width={1} height={1080} color={colors.line} />
      <Text x={ITEM_X + 12} y={56} fontSize={22} fontFamily={BOLD} letterSpacing={3} color={colors.textFaint}>
        {$t("guide.groups").toUpperCase()}
      </Text>
      <Glow
        x={ITEM_X}
        y={glowY()}
        width={ITEM_WIDTH}
        height={ITEM_HEIGHT}
        borderRadius={radius.medium}
        shown={props.focused}
      />

      <Item y={SEARCH_Y} focused={searchFocused()} current={false}>
        <View
          x={20}
          y={(ITEM_HEIGHT - ICON_SIZE) / 2}
          width={ICON_SIZE}
          height={ICON_SIZE}
          src="assets/icons/search.png"
          color={inkFor(searchFocused(), false)}
        />
        <Text
          x={20 + ICON_SIZE + 14}
          width={ITEM_WIDTH - (20 + ICON_SIZE + 14) - 16}
          height={ITEM_HEIGHT}
          lineHeight={ITEM_HEIGHT}
          maxLines={1}
          contain="width"
          fontSize={24}
          color={props.query && !searchFocused() ? colors.text : inkFor(searchFocused(), false)}
        >
          {props.query || $t("guide.search")}
        </Text>
      </Item>
      <View x={ITEM_X + 12} y={LIST_Y - 22} width={ITEM_WIDTH - 24} height={1} color={colors.line} />

      <For each={SLOTS}>
        {slot => (
          <Show when={props.items[props.top + slot]}>
            {item => {
              const focused = () => props.focused && props.cursor === props.top + slot;
              const current = () => props.current === props.top + slot;
              return (
                <Item y={slotY(slot)} focused={focused()} current={current()}>
                  <Text
                    x={20}
                    width={ITEM_WIDTH - 20 - COUNT_WIDTH}
                    height={ITEM_HEIGHT}
                    lineHeight={ITEM_HEIGHT}
                    maxLines={1}
                    contain="width"
                    fontSize={24}
                    fontFamily={focused() || current() ? BOLD : undefined}
                    color={inkFor(focused(), current())}
                  >
                    {item().label}
                  </Text>
                  <Text
                    x={ITEM_WIDTH - 18}
                    mountX={1}
                    height={ITEM_HEIGHT}
                    lineHeight={ITEM_HEIGHT}
                    fontSize={20}
                    color={focused() ? colors.accentText : colors.textFaint}
                  >
                    {String(item().count)}
                  </Text>
                </Item>
              );
            }}
          </Show>
        )}
      </For>
    </View>
  );
};
