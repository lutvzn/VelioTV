import { Text } from "@solidtv/solid";
import { BOLD, colors } from "../theme";

// Stands in for a section until its phase of PLAN.md builds it.
export const Placeholder = (props: { title?: string; note: string }) => (
  <>
    <Text x={80} y={80} fontSize={52} fontFamily={BOLD}>
      {props.title}
    </Text>
    <Text x={80} y={180} width={1300} contain="width" fontSize={32} color={colors.textDim}>
      {props.note}
    </Text>
  </>
);
