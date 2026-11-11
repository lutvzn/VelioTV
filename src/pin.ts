// Asking for the parental PIN (PLAN.md, Phase 5, step 5). Pages call these
// and wait; the prompt itself (src/components/PinPrompt.tsx) shows over
// everything and gives the focus back where it was when it closes.

import { createSignal } from "solid-js";
import { PIN_LENGTH } from "./data/appSettings";
import { settings } from "./library";
import type { DeviceProfile } from "./sync-core/device";
import { profilePinMatches } from "./sync-core/records";
import { $t } from "./translate";

export interface PinRequest {
  title: string;
  /** Takes the digits typed: true closes the prompt, false says they're wrong and asks again. */
  check: (pin: string) => boolean;
  /** Called with the PIN when it's taken, or undefined when Back cancels. */
  done: (pin: string | undefined) => void;
}

const [request, setRequest] = createSignal<PinRequest>();
export { request as pinRequest };

/** Shows the prompt; resolves with the PIN taken, or undefined if cancelled. */
const prompt = (title: string, check: (pin: string) => boolean) =>
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

/** Asks for a profile's PIN, set at velio.tv; resolves true at once when it has none. */
export const askProfilePin = async (profile: DeviceProfile) => {
  if (!profile.pin) return true;
  const pin = await prompt($t("profiles.pin", { name: profile.name }), typed =>
    profilePinMatches(profile, typed),
  );
  return pin !== undefined;
};
