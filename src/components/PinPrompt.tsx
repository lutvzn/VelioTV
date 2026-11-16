import { activeElement, type ElementNode, Text, View } from "@solidtv/solid";
import { createSignal, For, Show } from "solid-js";
import { exposeToProbes } from "../devHooks";
import { OVERLAY_Z } from "../pages/live/ChannelOptions";
import { PIN_LENGTH, pinRequest, type PinCheck, type PinRequest } from "../pin";
import { BOLD, colors, dialogShadow, radius } from "../theme";
import { $t } from "../translate";

const WIDTH = 720;
const HEIGHT = 360;
const DOT = 40;
const DOT_GAP = 36;

/**
 * The parental PIN prompt, over everything: number keys type, Left takes
 * the last digit back, Back cancels. Four digits are checked at once (or,
 * for a profile's PIN, once the server answers); a wrong PIN clears them
 * and says so.
 */
const Prompt = (props: { request: PinRequest }) => {
  // Where the focus goes back to.
  const before: ElementNode | undefined = activeElement();
  const [digits, setDigits] = createSignal("");
  /** False, or why the last PIN didn't open: true for wrong, or the server's text. */
  const [wrong, setWrong] = createSignal<boolean | string>(false);
  const [checking, setChecking] = createSignal(false);
  const finish = (pin: string | undefined) => {
    props.request.done(pin);
    before?.setFocus();
  };
  let closed = false;
  const answered = (pin: string, check: PinCheck) => {
    if (closed) return;
    setChecking(false);
    if (check === true) {
      closed = true;
      finish(pin);
    } else {
      setDigits("");
      setWrong(check === false ? true : check);
    }
  };
  const digit = (value: number) => () => {
    // The keys wait while the server checks.
    if (checking()) return true;
    const next = digits() + String(value);
    if (next.length < PIN_LENGTH) {
      setDigits(next);
      setWrong(false);
      return true;
    }
    setDigits(next);
    const check = props.request.check(next);
    if (typeof check === "boolean" || typeof check === "string") answered(next, check);
    else {
      setChecking(true);
      void (async () => {
        let answer: boolean | string;
        try {
          answer = await check;
        } catch {
          answer = $t("pin.notChecked");
        }
        answered(next, answer);
      })();
    }
    return true;
  };
  const hint = () => {
    const problem = wrong();
    if (checking()) return $t("pin.checking");
    if (typeof problem === "string") return problem;
    return problem ? $t("pin.wrong") : $t("pin.hint");
  };
  exposeToProbes("pinPrompt", { title: () => props.request.title, digits, wrong, checking });

  const dotsWidth = PIN_LENGTH * DOT + (PIN_LENGTH - 1) * DOT_GAP;
  return (
    <View
      autofocus
      zIndex={OVERLAY_Z + 1}
      x={(1920 - WIDTH) / 2}
      y={(1080 - HEIGHT) / 2}
      width={WIDTH}
      height={HEIGHT}
      borderRadius={radius.xlarge}
      color={colors.dialog}
      border={{ width: 1, color: colors.line }}
      shadow={dialogShadow}
      onLeft={() => {
        if (!checking()) setDigits(digits().slice(0, -1));
        return true;
      }}
      onBack={() => {
        closed = true;
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
      <Text y={48} width={WIDTH} contain="width" textAlign="center" fontSize={38} fontFamily={BOLD}>
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
            color={at < digits().length ? colors.accent : colors.track}
          />
        )}
      </For>
      <Text
        y={230}
        width={WIDTH}
        contain="width"
        textAlign="center"
        fontSize={28}
        color={wrong() !== false && !checking() ? colors.danger : colors.textDim}
      >
        {hint()}
      </Text>
    </View>
  );
};

export const PinPrompt = () => (
  <Show when={pinRequest()} keyed>
    {request => <Prompt request={request} />}
  </Show>
);
