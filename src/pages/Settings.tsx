import { Text, View } from "@solidtv/solid";
import { Column } from "@solidtv/solid/primitives";
import { createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { FormButton } from "../components/Form";
import type { Source } from "../data/sources";
import { exposeToProbes } from "../devHooks";
import { library } from "../library";
import { $t } from "../translate";
import { AppPage } from "./settings/AppPage";
import { BackupPage } from "./settings/BackupPage";
import { HiddenPage } from "./settings/HiddenPage";
import { PinPage } from "./settings/PinPage";
import { RemindersPage } from "./settings/RemindersPage";
import { SourceForm } from "./settings/SourceForm";
import { progressFraction, statusLines } from "./settings/status";

// Settings: the sources, in the order the lineup takes them, then pages for
// hidden channels and groups, the parental PIN, the app's own settings,
// backup and restore (PLAN.md, Phase 5), and the reminders (Phase 6). Each opens in the list's place, and
// Back comes back to the row it was opened from.

type Page = "hidden" | "pin" | "app" | "reminders" | "backup";
const PAGES: { page: Page; label: string }[] = [
  { page: "hidden", label: "settings.hidden" },
  { page: "pin", label: "settings.pin" },
  { page: "app", label: "settings.app" },
  { page: "reminders", label: "settings.reminders" },
  { page: "backup", label: "settings.backup" },
];

const LIST_WIDTH = 1200;
const ROW_HEIGHT = 124;

const SourceRow = (props: { source: Source; now: number; onEnter: () => void }) => {
  const [focused, setFocused] = createSignal(false);
  const status = () => library.statusOf(props.source.id);
  const lines = () => statusLines(status(), props.now);
  const fraction = () => (status().importing ? progressFraction(status().progress) : undefined);
  const failed = () => !status().importing && status().state?.status === "failed";
  return (
    <View
      width={LIST_WIDTH}
      height={ROW_HEIGHT}
      borderRadius={12}
      color={focused() ? "#2e6bd6ff" : "#ffffff14"}
      alpha={props.source.disabled ? 0.6 : 1}
      onFocusChanged={setFocused}
      onEnter={() => {
        props.onEnter();
        return true;
      }}
    >
      <Text x={28} y={16} width={800} maxLines={1} contain="width" fontSize={34}>
        {props.source.name}
      </Text>
      <Text x={LIST_WIDTH - 28} y={22} mountX={1} fontSize={24} color="#ffffffb3">
        {(props.source.kind === "xtream" ? $t("source.kind.xtream") : $t("source.kind.m3u")) +
          (props.source.disabled ? `  ·  ${$t("source.off")}` : "")}
      </Text>
      <Text
        x={28}
        y={62}
        width={LIST_WIDTH - 56}
        maxLines={1}
        contain="width"
        fontSize={24}
        color="#ffffffcc"
      >
        {lines()[0]}
      </Text>
      <Text
        x={28}
        y={90}
        width={LIST_WIDTH - 56}
        maxLines={1}
        contain="width"
        fontSize={22}
        color={failed() ? "#ff8a80ff" : "#ffffff99"}
      >
        {lines()[1]}
      </Text>
      <Show when={fraction() !== undefined}>
        <View x={12} y={ROW_HEIGHT - 8} width={LIST_WIDTH - 24} height={4} color="#ffffff26" />
        <View
          x={12}
          y={ROW_HEIGHT - 8}
          width={(LIST_WIDTH - 24) * (fraction() ?? 0)}
          height={4}
          color="#7fb2ffff"
        />
      </Show>
    </View>
  );
};

const SourceList = (props: {
  /** The row to select, for coming back from the form. */
  selected: number;
  autofocus: boolean;
  onOpen: (index: number, id?: string) => void;
  onPage: (index: number, page: Page) => void;
}) => {
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(clock));
  return (
    <>
      {/* First, so that the page's forwardFocus reaches the list. */}
      <View x={80} y={210} width={LIST_WIDTH} height={840} clipping forwardFocus={0}>
        <Column
          width={LIST_WIDTH}
          gap={16}
          scroll="edge"
          selected={props.selected}
          autofocus={props.autofocus}
        >
          <For each={library.sources()}>
            {(source, index) => (
              <SourceRow source={source} now={now()} onEnter={() => props.onOpen(index(), source.id)} />
            )}
          </For>
          <FormButton
            label={$t("settings.addSource")}
            width={LIST_WIDTH}
            onEnter={() => props.onOpen(library.sources().length)}
          />
          <Show when={library.sources().length === 0}>
            <Text width={LIST_WIDTH} contain="width" fontSize={28} color="#ffffffb3" skipFocus>
              {$t("settings.noSources")}
            </Text>
          </Show>
          <Text width={LIST_WIDTH} height={60} marginTop={24} fontSize={34} color="#ffffffb3" skipFocus>
            {$t("settings.more")}
          </Text>
          <For each={PAGES}>
            {(entry, at) => (
              <FormButton
                label={$t(entry.label)}
                width={LIST_WIDTH}
                onEnter={() => props.onPage(library.sources().length + 1 + at(), entry.page)}
              />
            )}
          </For>
        </Column>
      </View>
      <Text x={80} y={50} fontSize={56}>
        {$t("menu.settings")}
      </Text>
      <Text x={80} y={150} fontSize={34} color="#ffffffb3">
        {$t("settings.sources")}
      </Text>
    </>
  );
};

export default () => {
  // The form shows over the list's place: undefined for the list, null to
  // add a source, or the id of the source to edit.
  const [editing, setEditing] = createSignal<string | null | undefined>();
  const [page, setPage] = createSignal<Page>();
  const [selected, setSelected] = createSignal(0);
  const [returning, setReturning] = createSignal(false);
  const close = () => {
    setReturning(true);
    setEditing(undefined);
    setPage(undefined);
  };
  exposeToProbes("settingsPage", { editing, page, selected });

  return (
    // Right from the side menu focuses the page; this passes it on to the
    // list or the page open, whichever is showing.
    <View forwardFocus={0}>
      <Show
        when={editing() !== undefined || page() !== undefined}
        fallback={
          <SourceList
            selected={selected()}
            // Only coming back from a page; opening Settings from the menu
            // leaves focus in the menu.
            autofocus={returning()}
            onOpen={(index, id) => {
              setSelected(index);
              setEditing(id ?? null);
            }}
            onPage={(index, next) => {
              setSelected(index);
              setPage(next);
            }}
          />
        }
      >
        <Switch>
          <Match when={page() === "hidden"}>
            <HiddenPage onClose={close} />
          </Match>
          <Match when={page() === "pin"}>
            <PinPage onClose={close} />
          </Match>
          <Match when={page() === "app"}>
            <AppPage onClose={close} />
          </Match>
          <Match when={page() === "reminders"}>
            <RemindersPage onClose={close} />
          </Match>
          <Match when={page() === "backup"}>
            <BackupPage onClose={close} />
          </Match>
          <Match when={editing() !== undefined}>
            <SourceForm id={editing() ?? undefined} onClose={close} />
          </Match>
        </Switch>
      </Show>
    </View>
  );
};
