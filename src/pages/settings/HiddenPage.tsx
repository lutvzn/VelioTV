import { For, Show } from "solid-js";
import { Text } from "@solidtv/solid";
import { FIELD_WIDTH, ToggleField } from "../../components/Form";
import { exposeToProbes } from "../../devHooks";
import { edits, groupTitle, lineup } from "../../library";
import { colors } from "../../theme";
import { $t } from "../../translate";
import { SubPage } from "./SubPage";

/**
 * The channels and groups hidden from Live TV (PLAN.md, Phase 5, step 3),
 * the only place they show. OK shows one again, or hides it again; the list
 * keeps what was hidden when the page opened, so nothing moves under the
 * cursor.
 */
const channelName = (id: string) => {
  const channel = lineup.find(id);
  // A channel its source no longer has: its key, after the source.
  return channel ? channel.name : id.slice(id.indexOf("/") + 1).replace(/^[a-z]:/, "");
};
const state = (hidden: boolean) => (hidden ? $t("hidden.hidden") : $t("hidden.shown"));
const hint = (hidden: boolean) => (hidden ? $t("hidden.show") : $t("hidden.hide"));

export const HiddenPage = (props: { onClose: () => void }) => {
  const groups = edits.all().hiddenGroups.slice();
  const channels = edits.all().hiddenChannels.slice();
  exposeToProbes("hiddenPage", { groups, channels });

  return (
    <SubPage title={$t("hidden.title")} intro={$t("hidden.intro")} onClose={props.onClose}>
      <For each={groups}>
        {key => {
          const hidden = () => edits.isGroupHidden(key);
          return (
            <ToggleField
              label={`${$t("hidden.group")} · ${state(hidden())}`}
              value={groupTitle(key)}
              hint={hint(hidden())}
              onEnter={() => edits.setGroupHidden(key, !hidden())}
            />
          );
        }}
      </For>
      <For each={channels}>
        {id => {
          const hidden = () => edits.isChannelHidden(id);
          const group = lineup.find(id)?.group;
          return (
            <ToggleField
              label={`${group ? groupTitle(group) : $t("hidden.channel")} · ${state(hidden())}`}
              value={channelName(id)}
              hint={hint(hidden())}
              onEnter={() => edits.setChannelHidden(id, !hidden())}
            />
          );
        }}
      </For>
      <Show when={groups.length + channels.length === 0}>
        <Text width={FIELD_WIDTH} contain="width" fontSize={30} color={colors.textDim} skipFocus>
          {$t("hidden.none")}
        </Text>
      </Show>
    </SubPage>
  );
};
