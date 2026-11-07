import { ChoiceField } from "../../components/Form";
import type { ClockFormat, StartOn } from "../../data/appSettings";
import { settings } from "../../library";
import { $t } from "../../translate";
import { SubPage } from "./SubPage";

/** What the app opens on, and how times show (PLAN.md, Phase 5, step 6). */
export const AppPage = (props: { onClose: () => void }) => {
  const starts: { value: StartOn; label: string }[] = [
    { value: "last", label: $t("app.startOn.last") },
    { value: "guide", label: $t("app.startOn.guide") },
  ];
  const clocks: { value: ClockFormat; label: string }[] = [
    { value: "24h", label: $t("app.clock.24h") },
    { value: "12h", label: $t("app.clock.12h") },
  ];
  return (
    <SubPage title={$t("app.title")} onClose={props.onClose}>
      <ChoiceField
        label={$t("app.startOn")}
        choices={starts}
        value={settings.startOn()}
        onChange={settings.setStartOn}
        hint={$t("source.change")}
      />
      <ChoiceField
        label={$t("app.clock")}
        choices={clocks}
        value={settings.clock()}
        onChange={settings.setClock}
        hint={$t("source.change")}
      />
    </SubPage>
  );
};
