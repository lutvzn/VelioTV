import { type ElementNode, Text, View } from "@solidtv/solid";
import { createSignal, type JSX, Show } from "solid-js";
import { editText } from "../textEntry";
import { BOLD, colors, motion, radius } from "../theme";
import { Glow } from "./Glow";

export const FIELD_WIDTH = 1100;
export const FIELD_HEIGHT = 92;
const LABEL_Y = 10;
const VALUE_Y = 42;
const VALUE_HEIGHT = 44;

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
      borderRadius={radius.large}
      color={focused() ? colors.focus : colors.surface}
      transition={{ color: motion.quick }}
      onFocusChanged={setFocused}
      onEnter={() => {
        props.onEnter();
        return true;
      }}
    >
      <Text
        x={24}
        y={LABEL_Y}
        fontSize={24}
        color={focused() ? colors.onFocus : colors.textFaint}
        alpha={focused() ? 0.6 : 1}
      >
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
        fontFamily={focused() ? BOLD : undefined}
        color={focused() ? colors.onFocus : props.value ? colors.text : colors.textFaint}
        alpha={focused() && !props.value ? 0.5 : 1}
      >
        {props.value || props.placeholder || " "}
      </Text>
      <Text
        x={FIELD_WIDTH - 24}
        mountX={1}
        height={FIELD_HEIGHT}
        lineHeight={FIELD_HEIGHT}
        fontSize={24}
        color={colors.onFocus}
        alpha={focused() ? 0.6 : 0}
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

export interface ToggleFieldProps {
  /** What it is, and its state, above it: "Group · Hidden". */
  label: string;
  value: string;
  hint: string;
  onEnter: () => void;
}

/** A row that switches something about an item on and off, such as hiding it. */
export const ToggleField = (props: ToggleFieldProps) => (
  <Field label={props.label} value={props.value} hint={props.hint} onEnter={props.onEnter} />
);

export const BUTTON_HEIGHT = 72;

export interface ButtonProps {
  label: string;
  width?: number;
  onEnter: () => void;
  /** For actions that delete something. */
  danger?: boolean;
  /** Fainter, for an action that does nothing now, such as moving the first item up. */
  dim?: boolean;
  /** Opens a page: the label on the left, and an arrow on the right. */
  opens?: boolean;
  /** Beside the arrow of a button that opens a page, such as how many it holds. */
  detail?: string;
  children?: JSX.Element;
}

export const FormButton = (props: ButtonProps) => {
  const [focused, setFocused] = createSignal(false);
  const width = () => props.width ?? 300;
  const color = () => {
    if (!focused()) return colors.surfaceRaised;
    return props.danger ? colors.dangerFill : colors.focus;
  };
  const ink = () => {
    if (focused()) return props.danger ? colors.text : colors.onFocus;
    return props.danger ? colors.danger : colors.text;
  };
  return (
    <View
      width={width()}
      height={BUTTON_HEIGHT}
      borderRadius={BUTTON_HEIGHT / 2}
      color={color()}
      transition={{ color: motion.quick }}
      alpha={props.dim ? 0.5 : 1}
      onFocusChanged={setFocused}
      onEnter={() => {
        props.onEnter();
        return true;
      }}
    >
      <Glow
        width={width()}
        height={BUTTON_HEIGHT}
        borderRadius={BUTTON_HEIGHT / 2}
        shown={focused() && !props.danger}
      />
      <Text
        x={props.opens ? 36 : 0}
        width={props.opens ? width() - 100 : width()}
        height={BUTTON_HEIGHT}
        lineHeight={BUTTON_HEIGHT}
        maxLines={1}
        contain="width"
        textAlign={props.opens ? "left" : "center"}
        fontSize={28}
        fontFamily={BOLD}
        color={ink()}
      >
        {props.label}
      </Text>
      <Show when={props.opens && props.detail}>
        <Text
          x={width() - 80}
          mountX={1}
          height={BUTTON_HEIGHT}
          lineHeight={BUTTON_HEIGHT}
          fontSize={24}
          color={focused() ? colors.onFocus : colors.textFaint}
          alpha={focused() ? 0.7 : 1}
        >
          {props.detail}
        </Text>
      </Show>
      <Show when={props.opens}>
        <Text
          x={width() - 36}
          mountX={1}
          height={BUTTON_HEIGHT}
          lineHeight={BUTTON_HEIGHT}
          fontSize={34}
          fontFamily={BOLD}
          color={focused() ? colors.onFocus : colors.textFaint}
        >
          ›
        </Text>
      </Show>
    </View>
  );
};
