import { type ElementNode, Text, View } from "@solidtv/solid";
import { Column, type KeyHandler } from "@solidtv/solid/primitives";
import { createSignal, For } from "solid-js";
import type { Section } from "../sections";
import { $t, type TextKey } from "../translate";

export const MENU_WIDTH = 360;
const ITEM_WIDTH = MENU_WIDTH - 48;
const ITEM_HEIGHT = 72;

const MenuItem = (props: { label: TextKey; current: boolean }) => {
  const [focused, setFocused] = createSignal(false);
  const color = () => {
    if (focused()) return "#2e6bd6ff";
    return props.current ? "#ffffff1f" : "#00000000";
  };

  return (
    <View
      width={ITEM_WIDTH}
      height={ITEM_HEIGHT}
      borderRadius={12}
      color={color()}
      onFocusChanged={setFocused}
    >
      <Text
        x={24}
        height={ITEM_HEIGHT}
        lineHeight={ITEM_HEIGHT}
        fontSize={34}
        color={focused() || props.current ? "#ffffffff" : "#ffffffb3"}
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

// The menu on the left. Moving up and down opens each section straight away.
export const SideMenu = (props: SideMenuProps) => {
  // Follows the page, which can also change from the pages themselves.
  const currentIndex = () =>
    Math.max(
      0,
      props.sections.findIndex(section => section.path === props.currentPath),
    );

  return (
    <View width={MENU_WIDTH} height={1080} color="#0b1d33ff" alpha={props.hidden ? 0 : 1}>
      <Text x={40} y={56} fontSize={44}>
        Velio
      </Text>
      <Column
        ref={props.ref}
        autofocus={props.autofocus}
        x={24}
        y={170}
        width={ITEM_WIDTH}
        height={1080 - 200}
        gap={12}
        scroll="none"
        selected={currentIndex()}
        // Column also reports the selection each time the menu takes focus;
        // only an actual move opens a section.
        onSelectedChanged={(index, _menu, _item, lastIndex) => {
          if (index !== lastIndex) props.onSelect(props.sections[index].path);
        }}
        onRight={props.onRight}
        onBack={props.onBack}
      >
        <For each={props.sections}>
          {section => <MenuItem label={section.label} current={section.path === props.currentPath} />}
        </For>
      </Column>
      <Text
        x={40}
        y={1080 - 110}
        width={MENU_WIDTH - 64}
        contain="width"
        maxLines={2}
        fontSize={22}
        color="#ffffffb3"
      >
        {props.status ?? ""}
      </Text>
    </View>
  );
};
