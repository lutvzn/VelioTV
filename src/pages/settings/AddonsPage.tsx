import { Text } from "@solidtv/solid";
import { createSignal, For, Show } from "solid-js";
import { FIELD_WIDTH, FormButton } from "../../components/Form";
import { exposeToProbes } from "../../devHooks";
import { addons, sync } from "../../library";
import type { AddonState } from "../../stremio/addons";
import { BOLD, colors } from "../../theme";
import { $t, $tn } from "../../translate";
import { SubPage } from "./SubPage";

/** The add-on's web address, without the path, which can hold its settings or a key. */
const hostOf = (url: string) => url.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] ?? url;

const stateText = (state: AddonState) => {
  if (state.loading && !state.manifest) return $t("addons.reading");
  if (!state.manifest) return $t("addons.failed", { problem: state.problem ?? "" });
  if (state.manifest.needsSetup) return $t("addons.needsSetup");
  const count = state.manifest.catalogs.filter(catalog => !catalog.searchOnly).length;
  const line = count ? $tn("addons.catalogs", count) : $t("addons.noCatalogs");
  return state.problem ? `${line}   ·   ${$t("addons.failed", { problem: state.problem })}` : line;
};

/**
 * The current profile's Stremio add-ons (PLAN.md, "Stremio add-ons",
 * step 3), read-only: they're added at velio.tv. Each shows its name, its
 * address and what it gave; Check again reads every manifest anew.
 */
export const AddonsPage = (props: { onClose: () => void }) => {
  const [checking, setChecking] = createSignal(false);
  const check = () => {
    setChecking(true);
    void addons.refresh().finally(() => setChecking(false));
  };
  exposeToProbes("addonsPage", { states: addons.states, check, checking });
  return (
    <SubPage
      title={$t("settings.addons")}
      intro={$t("addons.intro", { page: sync.site().replace(/^https?:\/\//i, "") })}
      message={checking() ? $t("addons.checking") : ""}
      onClose={props.onClose}
    >
      <Show
        when={addons.states().length > 0}
        fallback={
          <Text
            width={FIELD_WIDTH}
            contain="width"
            maxLines={3}
            fontSize={26}
            color={colors.textDim}
            skipFocus
          >
            {sync.signedIn() ? $t("addons.none") : $t("addons.signIn")}
          </Text>
        }
      >
        <For each={addons.states()}>
          {state => (
            <>
              <Text
                width={FIELD_WIDTH}
                contain="width"
                maxLines={1}
                marginTop={12}
                fontSize={30}
                fontFamily={BOLD}
                skipFocus
              >
                {state.manifest?.name ?? state.list.name}
              </Text>
              <Text
                width={FIELD_WIDTH}
                contain="width"
                maxLines={1}
                fontSize={24}
                color={colors.textDim}
                skipFocus
              >
                {hostOf(state.list.url)}
              </Text>
              <Text
                width={FIELD_WIDTH}
                contain="width"
                maxLines={2}
                fontSize={24}
                color={state.problem && !state.manifest ? colors.danger : colors.textFaint}
                skipFocus
              >
                {stateText(state)}
              </Text>
            </>
          )}
        </For>
      </Show>
      <FormButton label={$t("addons.check")} onEnter={check} />
    </SubPage>
  );
};
