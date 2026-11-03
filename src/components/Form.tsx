import { type ElementNode, Text, View } from "@solidtv/solid";
import { createSignal, type JSX } from "solid-js";
import { editText } from "../textEntry";

export const FIELD_WIDTH = 1100;
export const FIELD_HEIGHT = 92;
const LABEL_Y = 10;
const VALUE_Y = 42;
const VALUE_HEIGHT = 44;

const colors = {
  focused: "#2e6bd6ff",
  idle: "#ffffff14",
  label: "#ffffffb3",
  value: "#ffffffff",
  placeholder: "#ffffff66",
  hint: "#ffffffcc",
};

interface FieldProps {
  label: string;
  value: string;
  placeholder?: string;
  hint: string;
  ref?: (element: ElementNode) => void;
  onEnter: () => void;
}

// A labelled box showing a value, with a hint at the right while focused.
const Field = (props: FieldProps) => {
  const [focused, setFocused] = createSignal(false);
  return (
    <View
      ref={props.ref}
      width={FIELD_WIDTH}
      height={FIELD_HEIGHT}
      borderRadius={12}
      color={focused() ? colors.focused : colors.idle}
      onFocusChanged={setFocused}
      onEnter={() => {
        props.onEnter();
        return true;
      }}
    >
      <Text x={24} y={LABEL_Y} fontSize={24} color={colors.label}>
        {props.label}
      </Text>
      <Text
        x={24}
        y={VALUE_Y}
        width={FIELD_WIDTH - 300}
        height={VALUE_HEIGHT}
        lineHeight={VALUE_HEIGHT}
        maxLines={1}
        contain="width"
        fontSize={32}
        color={props.value ? colors.value : colors.placeholder}
      >
        {props.value || props.placeholder || " "}
      </Text>
      <Text
        x={FIELD_WIDTH - 24}
        mountX={1}
        height={FIELD_HEIGHT}
        lineHeight={FIELD_HEIGHT}
        fontSize={24}
        color={colors.hint}
        alpha={focused() ? 1 : 0}
      >
        {props.hint}
      </Text>
    </View>
  );
};

export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint: string;
  /** Shows stars instead of the value, except while editing. */
  secret?: boolean;
  inputMode?: "text" | "url";
}

/** A text field; OK opens the TV's keyboard over it. */
export const TextField = (props: TextFieldProps) => {
  let element: ElementNode | undefined;
  const edit = () => {
    if (!element) return;
    editText({
      rect: {
        x: (element.absX ?? 0) + 12,
        y: (element.absY ?? 0) + VALUE_Y - 4,
        width: FIELD_WIDTH - 24,
        height: VALUE_HEIGHT + 8,
      },
      value: props.value,
      inputMode: props.inputMode,
      fontSize: 32,
      onDone: value => {
        props.onChange(value.trim());
        // Back to the field the edit started from.
        element?.setFocus();
      },
    });
  };
  return (
    <Field
      ref={el => (element = el)}
      label={props.label}
      value={props.secret && props.value ? "*".repeat(props.value.length) : props.value}
      placeholder={props.placeholder}
      hint={props.hint}
      onEnter={edit}
    />
  );
};

export interface ChoiceFieldProps<T> {
  label: string;
  choices: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  hint: string;
}

/** A field with a few fixed values; OK moves to the next one. */
export const ChoiceField = <T,>(props: ChoiceFieldProps<T>) => {
  const index = () =>
    Math.max(
      0,
      props.choices.findIndex(choice => choice.value === props.value),
    );
  return (
    <Field
      label={props.label}
      value={props.choices[index()]?.label ?? ""}
      hint={props.hint}
      onEnter={() => props.onChange(props.choices[(index() + 1) % props.choices.length].value)}
    />
  );
};

export const BUTTON_HEIGHT = 72;

export interface ButtonProps {
  label: string;
  width?: number;
  onEnter: () => void;
  /** For actions that delete something. */
  danger?: boolean;
  children?: JSX.Element;
}

export const FormButton = (props: ButtonProps) => {
  const [focused, setFocused] = createSignal(false);
  const width = () => props.width ?? 300;
  const color = () => {
    if (!focused()) return colors.idle;
    return props.danger ? "#c0392bff" : colors.focused;
  };
  return (
    <View
      width={width()}
      height={BUTTON_HEIGHT}
      borderRadius={12}
      color={color()}
      onFocusChanged={setFocused}
      onEnter={() => {
        props.onEnter();
        return true;
      }}
    >
      <Text
        width={width()}
        height={BUTTON_HEIGHT}
        lineHeight={BUTTON_HEIGHT}
        contain="width"
        textAlign="center"
        fontSize={30}
      >
        {props.label}
      </Text>
    </View>
  );
};
