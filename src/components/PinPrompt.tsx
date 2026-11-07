import { activeElement, type ElementNode, Text, View } from "@solidtv/solid";
import { createSignal, For, Show } from "solid-js";
import { exposeToProbes } from "../devHooks";
import { OVERLAY_Z } from "../pages/live/ChannelOptions";
import { PIN_LENGTH, pinRequest, type PinRequest } from "../pin";
import { $t } from "../translate";

const WIDTH = 720;
const HEIGHT = 360;
const DOT = 40;
const DOT_GAP = 36;

/**
 * The parental PIN prompt, over everything: number keys type, Left takes
 * the last digit back, Back cancels. Four digits are checked at once; a
 * wrong PIN clears them and says so.
 */
const Prompt = (props: { request: PinRequest }) => {
  // Where the focus goes back to.
  const before: ElementNode | undefined = activeElement();
  const [digits, setDigits] = createSignal("");
  const [wrong, setWrong] = createSignal(false);
  const finish = (pin: string | undefined) => {
    props.request.done(pin);
    before?.setFocus();
  };
  const digit = (value: number) => () => {
    const next = digits() + String(value);
    if (next.length < PIN_LENGTH) {
      setDigits(next);
      setWrong(false);
    } else if (props.request.check(next)) {
      finish(next);
    } else {
      setDigits("");
      setWrong(true);
    }
    return true;
  };
  exposeToProbes("pinPrompt", { title: () => props.request.title, digits, wrong });

  const dotsWidth = PIN_LENGTH * DOT + (PIN_LENGTH - 1) * DOT_GAP;
  return (
    <View
      autofocus
      zIndex={OVERLAY_Z + 1}
      x={(1920 - WIDTH) / 2}
      y={(1080 - HEIGHT) / 2}
      width={WIDTH}
      height={HEIGHT}
      borderRadius={20}
      color="#071423fa"
      onLeft={() => {
        setDigits(digits().slice(0, -1));
        return true;
      }}
      onBack={() => {
        finish(undefined);
        return true;
      }}
      onKey0={digit(0)}
      onKey1={digit(1)}
      onKey2={digit(2)}
      onKey3={digit(3)}
      onKey4={digit(4)}
      onKey5={digit(5)}
      onKey6={digit(6)}
      onKey7={digit(7)}
      onKey8={digit(8)}
      onKey9={digit(9)}
      // Every other key stops here.
      onKeyPress={() => true}
    >
      <Text y={48} width={WIDTH} contain="width" textAlign="center" fontSize={38}>
        {props.request.title}
      </Text>
      <For each={Array.from({ length: PIN_LENGTH }, (_, at) => at)}>
        {at => (
          <View
            x={(WIDTH - dotsWidth) / 2 + at * (DOT + DOT_GAP)}
            y={140}
            width={DOT}
            height={DOT}
            borderRadius={DOT / 2}
            color={at < digits().length ? "#ffffffff" : "#ffffff33"}
          />
        )}
      </For>
      <Text
        y={230}
        width={WIDTH}
        contain="width"
        textAlign="center"
        fontSize={28}
        color={wrong() ? "#ff8a80ff" : "#ffffffb3"}
      >
        {wrong() ? $t("pin.wrong") : $t("pin.hint")}
      </Text>
    </View>
  );
};

export const PinPrompt = () => (
  <Show when={pinRequest()} keyed>
    {request => <Prompt request={request} />}
  </Show>
);
