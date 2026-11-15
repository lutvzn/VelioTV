import { Text, View } from "@solidtv/solid";
import { Column } from "@solidtv/solid/primitives";
import { createContext, type JSX, untrack, useContext } from "solid-js";
import { FIELD_WIDTH } from "../../components/Form";
import { BOLD, colors } from "../../theme";

/** The left edge of a page in Settings' panel, right of the categories. */
export const PAGE_X = 64;
/** Room round the fields for the focused one's glow, which clipping would cut. */
const GLOW_ROOM = 24;
const FIELDS_Y = 190;

/**
 * Settings' panel, beside the categories (src/pages/Settings.tsx): how wide
 * it is, and whether it has the keys, so a page that opens in it takes them
 * only then. A page opened from the categories just shows; one opened from
 * inside the panel (or redrawn there) takes the focus.
 */
export const SettingsPane = createContext<{ width: () => number; hasKeys: () => boolean }>();

/** Whether a page opening now takes the focus: always outside the panel. */
export const useAutofocus = () => {
  const pane = useContext(SettingsPane);
  return pane ? untrack(pane.hasKeys) : true;
};

/** How wide a line of text can be on a page: the panel's width, less the margins. */
export const usePageWidth = () => {
  const pane = useContext(SettingsPane);
  return () => (pane ? pane.width() - 2 * PAGE_X : 1500);
};

/**
 * A Settings page, in the panel: a title, a column of fields that takes the
 * focus, and a line for messages. Back closes it.
 */
export const SubPage = (props: {
  title: string;
  /** Under the title, such as what the page does. */
  intro?: string;
  message?: string;
  /** Messages about something that went wrong show in red. */
  problem?: boolean;
  /** The field to put the cursor on, such as the one a page opened from. */
  selected?: number;
  onClose: () => void;
  children: JSX.Element;
}) => {
  const autofocus = useAutofocus();
  const width = usePageWidth();
  return (
    <View
      onBack={() => {
        props.onClose();
        return true;
      }}
      forwardFocus={0}
    >
      <View
        x={PAGE_X - GLOW_ROOM}
        y={FIELDS_Y - GLOW_ROOM}
        width={FIELD_WIDTH + 2 * GLOW_ROOM}
        // Down to 990, above the message line.
        height={800 + GLOW_ROOM}
        clipping
        forwardFocus={0}
      >
        <Column
          x={GLOW_ROOM}
          y={GLOW_ROOM}
          width={FIELD_WIDTH}
          gap={12}
          scroll="edge"
          selected={props.selected ?? 0}
          autofocus={autofocus}
        >
          {props.children}
        </Column>
      </View>
      <Text x={PAGE_X} y={56} fontSize={52} fontFamily={BOLD}>
        {props.title}
      </Text>
      <Text
        x={PAGE_X}
        y={128}
        width={width()}
        contain="width"
        maxLines={1}
        fontSize={26}
        color={colors.textDim}
      >
        {props.intro ?? ""}
      </Text>
      <Text
        x={PAGE_X}
        y={1010}
        width={width()}
        contain="width"
        maxLines={1}
        fontSize={28}
        color={props.problem ? colors.danger : colors.accentText}
      >
        {props.message ?? ""}
      </Text>
    </View>
  );
};
