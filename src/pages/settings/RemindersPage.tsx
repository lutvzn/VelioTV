import { For, Show } from "solid-js";
import { Text } from "@solidtv/solid";
import { FIELD_WIDTH, ToggleField } from "../../components/Form";
import { exposeToProbes } from "../../devHooks";
import { reminders } from "../../library";
import { dayLabel, timeRange } from "../../live/format";
import { $t } from "../../translate";
import { SubPage } from "./SubPage";

const words = () => ({
  today: $t("guide.today"),
  tomorrow: $t("guide.tomorrow"),
  yesterday: $t("guide.yesterday"),
});

/**
 * The reminders set (PLAN.md, Phase 6, step 6), soonest first. OK cancels
 * one; the list keeps the ones there when the page opened, so nothing moves
 * under the cursor, and OK again sets it back.
 */
export const RemindersPage = (props: { onClose: () => void }) => {
  const list = reminders.all().slice();
  exposeToProbes("remindersPage", { list });

  return (
    <SubPage title={$t("settings.reminders")} intro="" onClose={props.onClose}>
      <For each={list}>
        {reminder => {
          const set = () => reminders.has(reminder.channelId, reminder.start);
          return (
            <ToggleField
              label={`${dayLabel(reminder.start, Date.now(), words())}  ${timeRange(reminder.start, reminder.stop)}  ·  ${reminder.channelName}`}
              value={
                set() ? reminder.title : `${reminder.title}  (${$t("options.noReminder").toLowerCase()})`
              }
              hint={set() ? $t("reminders.hint") : $t("options.remind")}
              onEnter={() => reminders.toggle(reminder)}
            />
          );
        }}
      </For>
      <Show when={list.length === 0}>
        <Text width={FIELD_WIDTH} contain="width" fontSize={30} color="#ffffffb3" skipFocus>
          {$t("reminders.none")}
        </Text>
      </Show>
    </SubPage>
  );
};
