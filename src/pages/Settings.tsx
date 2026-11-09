import { Text, View } from "@solidtv/solid";
import { Column } from "@solidtv/solid/primitives";
import { createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { FormButton } from "../components/Form";
import type { Source } from "../data/sources";
import { exposeToProbes } from "../devHooks";
import { library } from "../library";
import { $t, type TextKey } from "../translate";
import { AppPage } from "./settings/AppPage";
import { BackupPage } from "./settings/BackupPage";
import { HiddenPage } from "./settings/HiddenPage";
import { PinPage } from "./settings/PinPage";
import { RemindersPage } from "./settings/RemindersPage";
import { SourceForm } from "./settings/SourceForm";
import { progressFraction, statusLines } from "./settings/status";
import { Glow } from "../components/Glow";
import { BOLD, colors, radius, RING } from "../theme";

// Settings: the sources, in the order the lineup takes them, then pages for
// hidden channels and groups, the parental PIN, the app's own settings,
// backup and restore (PLAN.md, Phase 5), and the reminders (Phase 6). Each opens in the list's place, and
// Back comes back to the row it was opened from.

type Page = "hidden" | "pin" | "app" | "reminders" | "backup";
const PAGES: { page: Page; label: TextKey }[] = [
  { page: "hidden", label: "settings.hidden" },
  { page: "pin", label: "settings.pin" },
  { page: "app", label: "settings.app" },
  { page: "reminders", label: "settings.reminders" },
  { page: "backup", label: "settings.backup" },
];

const LEFT = 64;
/** Room round the list for the focused row's glow, which clipping would cut. */
const GLOW_ROOM = 24;
const LIST_WIDTH = 1200;
const ROW_HEIGHT = 140;
const TILE = 76;
const TEXT_X = 28 + TILE + 24;

/**
 * A source as a card: an icon, its name and whether it's on, then what it
 * holds and when it was updated. The focus rings it in cyan and lights it,
 * rather than filling it, as its lines are in several colours.
 */
const SourceRow = (props: { source: Source; now: number; onEnter: () => void }) => {
  const [focused, setFocused] = createSignal(false);
  const status = () => library.statusOf(props.source.id);
  const lines = () => statusLines(status(), props.now);
  const fraction = () => (status().importing ? progressFraction(status().progress) : undefined);
  const failed = () => !status().importing && status().state?.status === "failed";
  const kind = () => (props.source.kind === "xtream" ? $t("source.kind.xtream") : $t("source.kind.m3u"));
  const inset = () => (focused() ? RING : 1);
  return (
    <View
      width={LIST_WIDTH}
      height={ROW_HEIGHT}
      borderRadius={radius.large}
      // Shows as the card's edge: a hairline, or the focus ring.
      color={focused() ? colors.focus : colors.line}
      alpha={props.source.disabled ? 0.6 : 1}
      onFocusChanged={setFocused}
      onEnter={() => {
        props.onEnter();
        return true;
      }}
    >
      <Glow width={LIST_WIDTH} height={ROW_HEIGHT} borderRadius={radius.large} shown={focused()} />
      <View
        x={inset()}
        y={inset()}
        width={LIST_WIDTH - 2 * inset()}
        height={ROW_HEIGHT - 2 * inset()}
        borderRadius={radius.large - inset()}
        color={focused() ? colors.highlight : colors.card}
      />
      <View
        x={28}
        y={(ROW_HEIGHT - TILE) / 2}
        width={TILE}
        height={TILE}
        borderRadius={radius.medium}
        color={colors.accentWash}
      >
        <View
          x={(TILE - 40) / 2}
          y={(TILE - 40) / 2}
          width={40}
          height={40}
          src="assets/icons/live.png"
          color={colors.accentText}
        />
      </View>
      <Text
        x={TEXT_X}
        y={22}
        width={LIST_WIDTH - TEXT_X - 200}
        maxLines={1}
        contain="width"
        fontSize={32}
        fontFamily={BOLD}
        color={focused() ? colors.accentText : colors.text}
      >
        {props.source.name}
      </Text>
      {/* Whether the source is on, as a badge on the right. */}
      <View
        x={LIST_WIDTH - 28}
        y={24}
        mountX={1}
        height={36}
        display="flex"
        flexBoundary="contain"
        padding={[0, 16]}
        borderRadius={18}
        color={props.source.disabled ? colors.surfaceRaised : colors.accentWash}
      >
        <Text
          height={36}
          lineHeight={36}
          fontSize={20}
          fontFamily={BOLD}
          letterSpacing={2}
          color={props.source.disabled ? colors.textDim : colors.accentText}
        >
          {(props.source.disabled ? $t("source.off") : $t("source.on")).toUpperCase()}
        </Text>
      </View>
      <Text
        x={TEXT_X}
        y={68}
        width={LIST_WIDTH - TEXT_X - 28}
        maxLines={1}
        contain="width"
        fontSize={24}
        color={colors.textDim}
      >
        {`${kind()}   ·   ${lines()[0]}`}
      </Text>
      <Text
        x={TEXT_X}
        y={100}
        width={LIST_WIDTH - TEXT_X - 28}
        maxLines={1}
        contain="width"
        fontSize={22}
        color={failed() ? colors.danger : colors.textFaint}
      >
        {lines()[1]}
      </Text>
      <Show when={fraction() !== undefined}>
        <View
          x={TEXT_X}
          y={ROW_HEIGHT - 12}
          width={LIST_WIDTH - TEXT_X - 28}
          height={4}
          borderRadius={2}
          color={colors.track}
        />
        <View
          x={TEXT_X}
          y={ROW_HEIGHT - 12}
          width={(LIST_WIDTH - TEXT_X - 28) * (fraction() ?? 0)}
          height={4}
          borderRadius={2}
          color={colors.accent}
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
      <View x={LEFT} y={210} width={LIST_WIDTH + 2 * GLOW_ROOM} height={840} clipping forwardFocus={0}>
        <Column
          x={GLOW_ROOM}
          y={GLOW_ROOM}
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
            <Text width={LIST_WIDTH} contain="width" fontSize={28} color={colors.textDim} skipFocus>
              {$t("settings.noSources")}
            </Text>
          </Show>
          <Text
            width={LIST_WIDTH}
            height={60}
            marginTop={24}
            lineHeight={60}
            fontSize={22}
            fontFamily={BOLD}
            letterSpacing={3}
            color={colors.accentText}
            skipFocus
          >
            {$t("settings.more").toUpperCase()}
          </Text>
          <For each={PAGES}>
            {(entry, at) => (
              <FormButton
                label={$t(entry.label)}
                width={LIST_WIDTH}
                opens
                onEnter={() => props.onPage(library.sources().length + 1 + at(), entry.page)}
              />
            )}
          </For>
        </Column>
      </View>
      <Text x={LEFT + GLOW_ROOM} y={52} fontSize={56} fontFamily={BOLD}>
        {$t("menu.settings")}
      </Text>
      <View x={LEFT + GLOW_ROOM} y={136} width={LIST_WIDTH} height={1} color={colors.line} />
      <Text
        x={LEFT + GLOW_ROOM}
        y={162}
        fontSize={22}
        fontFamily={BOLD}
        letterSpacing={3}
        color={colors.accentText}
      >
        {$t("settings.sources").toUpperCase()}
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
