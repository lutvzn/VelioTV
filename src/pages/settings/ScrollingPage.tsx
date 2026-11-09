import { For } from "solid-js";
import { ChoiceField } from "../../components/Form";
import { HOLD_LISTS, HOLD_SPEEDS, type HoldList } from "../../data/appSettings";
import { settings } from "../../library";
import { $t, type TextKey } from "../../translate";
import { SubPage } from "./SubPage";

const LABELS: Record<HoldList, TextKey> = {
  groups: "scrolling.groups",
  guide: "scrolling.guide",
  posters: "scrolling.posters",
};

// A function, so the labels follow the language.
const speeds = () =>
  HOLD_SPEEDS.map(speed => ({ value: speed as number, label: $t("scrolling.speed", { count: speed }) }));

/**
 * How fast a held Up or Down goes at most in each list: it speeds up to it
 * (src/heldKey.ts; PLAN.md, Phase 8, step 7).
 */
export const ScrollingPage = (props: { onClose: () => void }) => (
  <SubPage title={$t("scrolling.title")} intro={$t("scrolling.intro")} onClose={props.onClose}>
    <For each={HOLD_LISTS}>
      {list => (
        <ChoiceField
          label={$t(LABELS[list])}
          choices={speeds()}
          value={settings.holdSpeed(list)}
          onChange={speed => settings.setHoldSpeed(list, speed)}
          hint={$t("source.change")}
        />
      )}
    </For>
  </SubPage>
);
