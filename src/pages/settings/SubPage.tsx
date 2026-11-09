import { Text, View } from "@solidtv/solid";
import { Column } from "@solidtv/solid/primitives";
import type { JSX } from "solid-js";
import { FIELD_WIDTH } from "../../components/Form";
import { BOLD, colors } from "../../theme";

/**
 * A Settings page in place of the list: a title, a column of fields that
 * takes the focus, and a line for messages. Back closes it.
 */
export const SubPage = (props: {
  title: string;
  /** Under the title, such as what the page does. */
  intro?: string;
  message?: string;
  /** Messages about something that went wrong show in red. */
  problem?: boolean;
  onClose: () => void;
  children: JSX.Element;
}) => (
  <View
    onBack={() => {
      props.onClose();
      return true;
    }}
    forwardFocus={0}
  >
    <View x={80} y={190} width={FIELD_WIDTH} height={800} clipping forwardFocus={0}>
      <Column width={FIELD_WIDTH} gap={12} scroll="edge" autofocus>
        {props.children}
      </Column>
    </View>
    <Text x={80} y={56} fontSize={52} fontFamily={BOLD}>
      {props.title}
    </Text>
    <Text x={80} y={128} width={1400} contain="width" maxLines={1} fontSize={26} color={colors.textDim}>
      {props.intro ?? ""}
    </Text>
    <Text
      x={80}
      y={1010}
      width={1500}
      contain="width"
      maxLines={1}
      fontSize={28}
      color={props.problem ? colors.danger : colors.accentText}
    >
      {props.message ?? ""}
    </Text>
  </View>
);
