import { Text } from "@solidtv/solid";
import { createSignal, onCleanup } from "solid-js";
import { FIELD_WIDTH, FormButton } from "../../components/Form";
import { library, profiles, sync } from "../../library";
import { colors } from "../../theme";
import { $t } from "../../translate";
import { SubPage } from "./SubPage";
import { statusLines } from "./status";

/** A line of the page, which the focus skips. */
const line = (text: string, color: string = colors.textDim) => (
  <Text width={FIELD_WIDTH} contain="width" maxLines={2} fontSize={26} color={color} skipFocus>
    {text}
  </Text>
);

/**
 * A list from the Velio account (SYNC-PLAN.md, step 4), read-only: it's
 * edited at velio.tv, and the TV only imports it. Update imports it now.
 */
export const SyncedSourcePage = (props: { id: string; onClose: () => void }) => {
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(clock));
  const source = () => library.sources().find(item => item.id === props.id);
  const status = () => statusLines(library.statusOf(props.id), now());
  const address = () => {
    const shown = source();
    if (!shown) return "";
    return shown.kind === "xtream" ? (shown.server ?? "") : (shown.url ?? "");
  };
  const usedBy = () =>
    profiles
      .list()
      .filter(profile => source()?.profiles?.includes(profile.id))
      .map(profile => profile.name)
      .join(", ");
  return (
    <SubPage
      title={source()?.name ?? ""}
      intro={$t("source.synced.intro", { page: sync.site().replace(/^https?:\/\//i, "") })}
      onClose={props.onClose}
    >
      {line(source()?.kind === "xtream" ? $t("source.kind.xtream") : $t("source.kind.m3u"), colors.text)}
      {line(address())}
      {line(usedBy() ? $t("source.synced.profiles", { names: usedBy() }) : "")}
      {line(status()[0])}
      {line(status()[1], colors.textFaint)}
      <FormButton label={$t("source.refreshNow")} onEnter={() => library.refresh(props.id)} />
    </SubPage>
  );
};
