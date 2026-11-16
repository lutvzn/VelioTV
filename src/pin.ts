// Asking for the parental PIN (PLAN.md, Phase 5, step 5). Pages call these
// and wait; the prompt itself (src/components/PinPrompt.tsx) shows over
// everything and gives the focus back where it was when it closes.

import { createSignal } from "solid-js";
import { PIN_LENGTH } from "./data/appSettings";
import type { DeviceProfile } from "./data/accountView";
import { settings, sync } from "./library";
import { $t, $tn } from "./translate";

/**
 * What checking a PIN came to: true closes the prompt; false says it's
 * wrong and asks again, as does text, which says that instead (such as
 * "Try again in 5 minutes").
 */
export type PinCheck = boolean | string;

export interface PinRequest {
  title: string;
  /** Takes the digits typed; a profile's PIN is checked by the server, so it may take a moment. */
  check: (pin: string) => PinCheck | Promise<PinCheck>;
  /** Called with the PIN when it's taken, or undefined when Back cancels. */
  done: (pin: string | undefined) => void;
}

const [request, setRequest] = createSignal<PinRequest>();
export { request as pinRequest };

/** Shows the prompt; resolves with the PIN taken, or undefined if cancelled. */
const prompt = (title: string, check: PinRequest["check"]) =>
  new Promise<string | undefined>(resolve => {
    // After the key that asked has finished with the focus, such as an
    // options panel giving it back to its page.
    setTimeout(() =>
      setRequest({
        title,
        check,
        done: pin => {
          setRequest(undefined);
          resolve(pin);
        },
      }),
    );
  });

/**
 * Resolves true once locked channels may show: at once if the PIN was
 * entered this session (or none is set), or else when it's entered now.
 * `always` asks even then, as changing the PIN does.
 */
export const askPin = async (always = false) => {
  if (!always && settings.unlocked()) return true;
  if (!settings.hasPin()) return true;
  const pin = await prompt($t("pin.enter"), typed => settings.checkPin(typed));
  return pin !== undefined;
};

/** Asks for a new PIN, twice; resolves with it, or undefined if cancelled. */
export const askNewPin = async () => {
  const first = await prompt($t("pin.new"), () => true);
  if (first === undefined) return undefined;
  const again = await prompt($t("pin.confirm"), typed => typed === first);
  return again;
};

export { PIN_LENGTH };

/** "Try again in 5 minutes", or in seconds under a minute. */
const tryAgainIn = (seconds: number) =>
  seconds >= 60
    ? $tn("pin.tryInMinutes", Math.ceil(seconds / 60))
    : $tn("pin.tryInSeconds", Math.ceil(seconds));

/**
 * Asks for a profile's PIN, set on the web or in a Nuvio app; resolves true
 * at once when it has none. The server checks it (and after a few wrong
 * ones, waits a while before it checks another).
 */
export const askProfilePin = async (profile: DeviceProfile) => {
  if (!profile.locked) return true;
  const pin = await prompt($t("profiles.pin", { name: profile.name }), async typed => {
    const outcome = await sync.checkPin(profile.id, typed);
    if (outcome.result === "unlocked") return true;
    if (outcome.result === "wrong") return false;
    if (outcome.result === "locked") return tryAgainIn(outcome.seconds);
    return $t("pin.notChecked");
  });
  return pin !== undefined;
};
