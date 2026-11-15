import { createSignal, Match, Switch } from "solid-js";
import { FIELD_WIDTH, FormButton } from "../../components/Form";
import { edits, reminders } from "../../library";
import { $t, $tn } from "../../translate";
import { HiddenPage } from "./HiddenPage";
import { RemindersPage } from "./RemindersPage";
import { SubPage } from "./SubPage";

type Opened = "hidden" | "reminders";

const hiddenCount = () => edits.all().hiddenGroups.length + edits.all().hiddenChannels.length;

/**
 * Settings → Live: the channels and groups hidden from Live, and the
 * reminders set. Each opens in the panel's place, and Back comes back to
 * the button it was opened from.
 */
export const LivePage = (props: { onClose: () => void }) => {
  const [opened, setOpened] = createSignal<Opened>();
  const [selected, setSelected] = createSignal(0);
  const open = (page: Opened, at: number) => {
    setSelected(at);
    setOpened(page);
  };
  const back = () => setOpened(undefined);

  return (
    <Switch
      fallback={
        <SubPage
          title={$t("menu.live")}
          intro={$t("live.settingsIntro")}
          selected={selected()}
          onClose={props.onClose}
        >
          <FormButton
            label={$t("settings.hidden")}
            detail={$tn("count.hidden", hiddenCount())}
            width={FIELD_WIDTH}
            opens
            onEnter={() => open("hidden", 0)}
          />
          <FormButton
            label={$t("settings.reminders")}
            detail={$tn("count.reminders", reminders.all().length)}
            width={FIELD_WIDTH}
            opens
            onEnter={() => open("reminders", 1)}
          />
        </SubPage>
      }
    >
      <Match when={opened() === "hidden"}>
        <HiddenPage onClose={back} />
      </Match>
      <Match when={opened() === "reminders"}>
        <RemindersPage onClose={back} />
      </Match>
    </Switch>
  );
};
