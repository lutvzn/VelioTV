import { createSignal } from "solid-js";
import { FIELD_WIDTH, FormButton } from "../../components/Form";
import { edits, settings } from "../../library";
import { askNewPin, askPin } from "../../pin";
import { $t, $tn } from "../../translate";
import { SubPage } from "./SubPage";

/**
 * The parental PIN (PLAN.md, Phase 5, step 5): setting it, changing it and
 * removing it, which ask for the PIN in use first, and locking again
 * without closing the app.
 */
const locks = () => {
  const all = edits.all();
  return $t("pin.locks", {
    channels: $tn("count.channels", all.lockedChannels.length),
    groups: $tn("count.groups", all.lockedGroups.length),
  });
};

const intro = () => (settings.hasPin() ? `${$t("pin.isSet")}  ${locks()}` : $t("pin.notSet"));

export const PinPage = (props: { onClose: () => void }) => {
  const [message, setMessage] = createSignal("");

  const change = async () => {
    if (settings.hasPin() && !(await askPin(true))) return;
    const pin = await askNewPin();
    if (pin === undefined) return;
    settings.setPin(pin);
    setMessage($t("pin.saved"));
  };
  const remove = async () => {
    if (!settings.hasPin()) {
      setMessage($t("pin.notSet"));
      return;
    }
    if (!(await askPin(true))) return;
    settings.setPin(undefined);
    setMessage($t("pin.removed"));
  };

  return (
    <SubPage title={$t("pin.title")} intro={intro()} message={message()} onClose={props.onClose}>
      <FormButton
        width={FIELD_WIDTH}
        label={settings.hasPin() ? $t("pin.change") : $t("pin.set")}
        onEnter={() => void change()}
      />
      <FormButton width={FIELD_WIDTH} label={$t("pin.remove")} danger onEnter={() => void remove()} />
      <FormButton
        width={FIELD_WIDTH}
        label={$t("pin.lockNow")}
        onEnter={() => {
          settings.lock();
          setMessage(settings.hasPin() ? $t("pin.lockedNow") : $t("pin.notSet"));
        }}
      />
    </SubPage>
  );
};
