import { ChoiceField, TextField, ToggleField } from "../../components/Form";
import {
  type AutoPlay,
  FALLBACK_COUNTS,
  FALLBACK_START_MS,
  type NextCard,
  type StreamOrder,
} from "../../data/playChoices";
import { playChoices } from "../../library";
import { $t } from "../../translate";
import { SubPage } from "./SubPage";

// How films and episodes play, for the profile (PLAN.md, "Auto-play"):
// the add-ons' stream order, auto-play and its pattern, the other streams
// tried when one doesn't start, the next-episode card, and subtitles'
// sound descriptions. Functions, so the labels follow the language.

const orders = (): { value: StreamOrder; label: string }[] => [
  { value: "addon", label: $t("playing.order.addon") },
  { value: "quality", label: $t("playing.order.quality") },
];
const autoPlays = (): { value: AutoPlay; label: string }[] => [
  { value: "off", label: $t("playing.autoPlay.off") },
  { value: "first", label: $t("playing.autoPlay.first") },
  { value: "pattern", label: $t("playing.autoPlay.pattern") },
];
const fallbackCounts = () =>
  FALLBACK_COUNTS.map(count => ({
    value: count as number,
    label: count === 0 ? $t("playing.fallbacks.none") : String(count),
  }));
const startWaits = () =>
  FALLBACK_START_MS.map(ms => ({
    value: ms as number,
    label: $t("playing.seconds", { seconds: ms / 1000 }),
  }));
const nextCards = (): { value: NextCard; label: string }[] => [
  { value: "off", label: $t("playing.off") },
  { value: "97%", label: $t("playing.nextCard.share", { share: 97 }) },
  { value: "99%", label: $t("playing.nextCard.share", { share: 99 }) },
  { value: "60s", label: $t("playing.nextCard.before", { seconds: 60 }) },
  { value: "120s", label: $t("playing.nextCard.before", { seconds: 120 }) },
  { value: "180s", label: $t("playing.nextCard.before", { seconds: 180 }) },
];

export const PlayingPage = (props: { onClose: () => void }) => {
  const choices = playChoices.choices;
  return (
    <SubPage title={$t("settings.playing")} intro={$t("playing.intro")} onClose={props.onClose}>
      <ChoiceField
        label={$t("playing.order")}
        choices={orders()}
        value={choices().order}
        onChange={order => playChoices.set({ order })}
        hint={$t("source.change")}
      />
      <ChoiceField
        label={$t("playing.autoPlay")}
        choices={autoPlays()}
        value={choices().autoPlay}
        onChange={autoPlay => playChoices.set({ autoPlay })}
        hint={$t("source.change")}
      />
      <TextField
        label={$t("playing.pattern")}
        value={choices().pattern}
        placeholder={$t("playing.pattern.empty")}
        onChange={pattern => playChoices.set({ pattern })}
        hint={$t("source.edit.hint")}
      />
      <TextField
        label={$t("playing.exclude")}
        value={choices().exclude}
        placeholder={$t("playing.exclude.empty")}
        onChange={exclude => playChoices.set({ exclude })}
        hint={$t("source.edit.hint")}
      />
      <ToggleField
        label={$t("playing.reuseLast")}
        value={choices().reuseLast ? $t("playing.on") : $t("playing.off")}
        onEnter={() => playChoices.set({ reuseLast: !choices().reuseLast })}
        hint={$t("source.change")}
      />
      <ChoiceField
        label={$t("playing.fallbacks")}
        choices={fallbackCounts()}
        value={choices().fallbacks}
        onChange={fallbacks => playChoices.set({ fallbacks })}
        hint={$t("source.change")}
      />
      <ChoiceField
        label={$t("playing.fallbackStart")}
        choices={startWaits()}
        value={choices().fallbackStartMs}
        onChange={fallbackStartMs => playChoices.set({ fallbackStartMs })}
        hint={$t("source.change")}
      />
      <ChoiceField
        label={$t("playing.nextCard")}
        choices={nextCards()}
        value={choices().nextCard}
        onChange={nextCard => playChoices.set({ nextCard })}
        hint={$t("source.change")}
      />
      <ToggleField
        label={$t("playing.hideSoundText")}
        value={choices().hideSoundText ? $t("playing.soundText.hidden") : $t("playing.soundText.shown")}
        onEnter={() => playChoices.set({ hideSoundText: !choices().hideSoundText })}
        hint={$t("source.change")}
      />
    </SubPage>
  );
};
