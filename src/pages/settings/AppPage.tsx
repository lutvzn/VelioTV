import { ChoiceField } from "../../components/Form";
import type { ClockFormat, StartOn } from "../../data/appSettings";
import {
  LANGUAGE_NAMES,
  LANGUAGES,
  matchLanguage,
  tvLanguages,
  type LanguageSetting,
} from "../../lang/languages";
import type { VodLayout } from "../../data/vodLayout";
import { settings, vodLayout } from "../../library";
import { $t } from "../../translate";
import { SubPage } from "./SubPage";

// Functions, so the labels follow the language.
// Each language in its own name; "auto" names the one the TV's language gets.
const languages = (): { value: LanguageSetting; label: string }[] => [
  { value: "auto", label: $t("app.language.auto", { name: LANGUAGE_NAMES[matchLanguage(tvLanguages())] }) },
  ...LANGUAGES.map(language => ({ value: language, label: LANGUAGE_NAMES[language] })),
];
const starts = (): { value: StartOn; label: string }[] => [
  { value: "last", label: $t("app.startOn.last") },
  { value: "guide", label: $t("app.startOn.guide") },
];
const clocks = (): { value: ClockFormat; label: string }[] => [
  { value: "24h", label: $t("app.clock.24h") },
  { value: "12h", label: $t("app.clock.12h") },
];

const layouts = (): { value: VodLayout; label: string }[] => [
  { value: "modern", label: $t("app.vodLayout.modern") },
  { value: "classic", label: $t("app.vodLayout.classic") },
];

/** The language, what the app opens on, and how times show (PLAN.md, Phase 5, step 6; Phase 8, step 5), and the Movies and Series layout ("Movies and Series by title", step 6). */
export const AppPage = (props: { onClose: () => void }) => {
  return (
    <SubPage title={$t("app.title")} onClose={props.onClose}>
      <ChoiceField
        label={$t("app.language")}
        choices={languages()}
        value={settings.language()}
        onChange={settings.setLanguage}
        hint={$t("source.change")}
      />
      <ChoiceField
        label={$t("app.startOn")}
        choices={starts()}
        value={settings.startOn()}
        onChange={settings.setStartOn}
        hint={$t("source.change")}
      />
      <ChoiceField
        label={$t("app.clock")}
        choices={clocks()}
        value={settings.clock()}
        onChange={settings.setClock}
        hint={$t("source.change")}
      />
      <ChoiceField
        label={$t("app.vodLayout")}
        choices={layouts()}
        value={vodLayout.layout()}
        onChange={vodLayout.set}
        hint={$t("app.vodLayout.hint")}
      />
    </SubPage>
  );
};
