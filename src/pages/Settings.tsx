import { type ElementNode, Text, View } from "@solidtv/solid";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { FIELD_WIDTH, FormButton } from "../components/Form";
import { Glow } from "../components/Glow";
import { MENU_OPEN_WIDTH, MENU_WIDTH, menuOpen } from "../components/SideMenu";
import { sourcesFor, type Source } from "../data/sources";
import { exposeToProbes } from "../devHooks";
import { library, profiles } from "../library";
import { createRestingCursor } from "../restingCursor";
import { BOLD, colors, radius, RING } from "../theme";
import { $t, type TextKey } from "../translate";
import { sayWhileFocused } from "../voiceGuide";
import { useWholeScreen } from "../wholeScreen";
import { GroupColumn, GROUPS_WIDTH } from "./guide/GroupColumn";
import { AboutPage } from "./settings/AboutPage";
import { AccountPage } from "./settings/AccountPage";
import { AddonsPage } from "./settings/AddonsPage";
import { BackupPage } from "./settings/BackupPage";
import { type SettingsCategory, setSettingsCategory, settingsCategory } from "./settings/category";
import { GeneralPage, VodPage } from "./settings/GeneralPage";
import { LivePage } from "./settings/LivePage";
import { PinPage } from "./settings/PinPage";
import { PlayingPage } from "./settings/PlayingPage";
import { ScrollingPage } from "./settings/ScrollingPage";
import { SourceForm } from "./settings/SourceForm";
import { SettingsPane, SubPage } from "./settings/SubPage";
import { SyncedSourcePage } from "./settings/SyncedSourcePage";
import { progressFraction, statusLines } from "./settings/status";

// Settings, laid out as Live and Movies and Series are: the menu, a column
// of categories, and the category the cursor rests on in a panel right of
// them. Up and Down in the column change the category shown; Right or OK
// goes into the panel, and Left or Back comes back to the column (Back from
// a page opened inside the panel closes that page first). Left or Back in
// the column goes on to the menu.
//
// The categories: the sources, in the order the lineup takes them (the
// current profile's: the TV's own, then its account's lists, read-only),
// the Velio account (SYNC-PLAN.md) and its Stremio add-ons, the app's own
// settings, Live's hidden channels and reminders (PLAN.md, Phases 5 and 6),
// Movies and Series, how they play, scrolling, the parental PIN, backup and restore, and
// About.

const CATEGORIES: { id: SettingsCategory; label: TextKey }[] = [
  { id: "sources", label: "settings.sources" },
  { id: "account", label: "settings.account" },
  { id: "addons", label: "settings.addons" },
  { id: "general", label: "settings.general" },
  { id: "live", label: "menu.live" },
  { id: "vod", label: "settings.vod" },
  { id: "playing", label: "settings.playing" },
  { id: "scrolling", label: "settings.scrolling" },
  { id: "pin", label: "settings.pin" },
  { id: "backup", label: "settings.backup" },
  { id: "about", label: "settings.about" },
];

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
      width={FIELD_WIDTH}
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
      <Glow width={FIELD_WIDTH} height={ROW_HEIGHT} borderRadius={radius.large} shown={focused()} />
      <View
        x={inset()}
        y={inset()}
        width={FIELD_WIDTH - 2 * inset()}
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
        width={FIELD_WIDTH - TEXT_X - 200}
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
        x={FIELD_WIDTH - 28}
        y={24}
        mountX={1}
        height={36}
        display="flex"
        flexBoundary="contain"
        padding={[0, 16]}
        borderRadius={18}
        color={props.source.disabled && !props.source.synced ? colors.surfaceRaised : colors.accentWash}
      >
        <Text
          height={36}
          lineHeight={36}
          fontSize={20}
          fontFamily={BOLD}
          letterSpacing={2}
          color={props.source.disabled && !props.source.synced ? colors.textDim : colors.accentText}
        >
          {(props.source.synced
            ? $t("source.syncedBadge")
            : props.source.disabled
              ? $t("source.off")
              : $t("source.on")
          ).toUpperCase()}
        </Text>
      </View>
      <Text
        x={TEXT_X}
        y={68}
        width={FIELD_WIDTH - TEXT_X - 28}
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
        width={FIELD_WIDTH - TEXT_X - 28}
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
          width={FIELD_WIDTH - TEXT_X - 28}
          height={4}
          borderRadius={2}
          color={colors.track}
        />
        <View
          x={TEXT_X}
          y={ROW_HEIGHT - 12}
          width={(FIELD_WIDTH - TEXT_X - 28) * (fraction() ?? 0)}
          height={4}
          borderRadius={2}
          color={colors.accent}
        />
      </Show>
    </View>
  );
};

/** The sources the current profile sees, in order. */
const shownList = () => sourcesFor(library.sources(), profiles.currentId());

/**
 * Settings → Sources: a card for each source, then Add a source. A source
 * opens its form (or, for one from the account, what it holds) in the
 * list's place, and Back comes back to its card.
 */
const SourcesPage = (props: { onClose: () => void }) => {
  // undefined for the list, null to add a source, or the id of the one open.
  const [editing, setEditing] = createSignal<string | null | undefined>();
  const [selected, setSelected] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(clock));
  const open = (index: number, id?: string) => {
    batch(() => {
      setSelected(index);
      setEditing(id ?? null);
    });
  };
  const back = () => setEditing(undefined);
  const synced = () => library.sources().find(source => source.id === editing())?.synced;
  exposeToProbes("settingsSources", { editing, selected });
  return (
    <Switch
      fallback={
        <SubPage
          title={$t("settings.sources")}
          intro={$t("settings.sourcesIntro")}
          selected={selected()}
          onClose={props.onClose}
        >
          <For each={shownList()}>
            {(source, index) => (
              <SourceRow source={source} now={now()} onEnter={() => open(index(), source.id)} />
            )}
          </For>
          <FormButton
            label={$t("settings.addSource")}
            width={FIELD_WIDTH}
            onEnter={() => open(shownList().length)}
          />
          <Show when={shownList().length === 0}>
            <Text width={FIELD_WIDTH} contain="width" fontSize={28} color={colors.textDim} skipFocus>
              {$t("settings.noSources")}
            </Text>
          </Show>
        </SubPage>
      }
    >
      <Match when={editing() !== undefined && synced()}>
        <SyncedSourcePage id={editing() ?? ""} onClose={back} />
      </Match>
      <Match when={editing() !== undefined}>
        <SourceForm id={editing() ?? undefined} onClose={back} />
      </Match>
    </Switch>
  );
};

const groupsX = () => (menuOpen() ? MENU_OPEN_WIDTH : MENU_WIDTH);

export default () => {
  let root: ElementNode | undefined;
  let pane: ElementNode | undefined;
  const [focused, setFocused] = createSignal(false);
  // Whether the panel has the keys, rather than the column.
  const [inPane, setInPane] = createSignal(false);
  // The column's cursor: the panel shows the category it's on once it rests
  // there, or at once on Right or OK.
  const cursor = createRestingCursor(settingsCategory, id => {
    const category = CATEGORIES.find(one => one.id === id);
    if (category) setSettingsCategory(category.id);
  });
  const cursorIndex = createMemo(() =>
    Math.max(
      0,
      CATEGORIES.findIndex(one => one.id === cursor.at()),
    ),
  );
  const shownIndex = () =>
    Math.max(
      0,
      CATEGORIES.findIndex(one => one.id === settingsCategory()),
    );
  const move = (step: number) => {
    const index = Math.max(0, Math.min(CATEGORIES.length - 1, cursorIndex() + step));
    cursor.move(CATEGORIES[index].id);
    return true;
  };
  const toPane = () => {
    cursor.settle();
    setInPane(true);
    pane?.setFocus();
    return true;
  };
  const toColumn = () => {
    setInPane(false);
    root?.setFocus();
    return true;
  };
  // Leaving the column, such as for the menu, shows the category the cursor is on.
  createEffect(
    on(
      () => focused() && !inPane(),
      inColumn => {
        if (!inColumn) cursor.settle();
      },
      { defer: true },
    ),
  );
  useWholeScreen(() => false);
  const paneX = () => groupsX() + GROUPS_WIDTH;
  exposeToProbes("settingsPage", { category: settingsCategory, cursor: cursor.at, inPane });

  // What the voice guide reads in the column: the category under the cursor.
  sayWhileFocused(
    () => focused() && !inPane(),
    () => $t(CATEGORIES[cursorIndex()].label),
  );

  return (
    <View
      ref={element => (root = element)}
      width={1920}
      height={1080}
      // Read by sayWhileFocused above, not as the page's whole text.
      announce=""
      onFocusChanged={setFocused}
      onUp={() => (inPane() ? true : move(-1))}
      onDown={() => (inPane() ? true : move(1))}
      onRight={() => (inPane() ? true : toPane())}
      onEnter={() => (inPane() ? true : toPane())}
      // From the column, on to the menu; from the panel, back to the column.
      onLeft={() => (inPane() ? toColumn() : false)}
      onBack={() => (inPane() ? toColumn() : false)}
    >
      <View
        ref={element => (pane = element)}
        x={paneX()}
        width={1920 - paneX()}
        height={1080}
        forwardFocus={0}
      >
        <SettingsPane.Provider value={{ width: () => 1920 - paneX(), hasKeys: inPane }}>
          <Switch>
            <Match when={settingsCategory() === "sources"}>
              <SourcesPage onClose={toColumn} />
            </Match>
            <Match when={settingsCategory() === "account"}>
              <AccountPage onClose={toColumn} />
            </Match>
            <Match when={settingsCategory() === "addons"}>
              <AddonsPage onClose={toColumn} />
            </Match>
            <Match when={settingsCategory() === "general"}>
              <GeneralPage onClose={toColumn} />
            </Match>
            <Match when={settingsCategory() === "live"}>
              <LivePage onClose={toColumn} />
            </Match>
            <Match when={settingsCategory() === "vod"}>
              <VodPage onClose={toColumn} />
            </Match>
            <Match when={settingsCategory() === "playing"}>
              <PlayingPage onClose={toColumn} />
            </Match>
            <Match when={settingsCategory() === "scrolling"}>
              <ScrollingPage onClose={toColumn} />
            </Match>
            <Match when={settingsCategory() === "pin"}>
              <PinPage onClose={toColumn} />
            </Match>
            <Match when={settingsCategory() === "backup"}>
              <BackupPage onClose={toColumn} />
            </Match>
            <Match when={settingsCategory() === "about"}>
              <AboutPage onClose={toColumn} />
            </Match>
          </Switch>
        </SettingsPane.Provider>
      </View>
      <GroupColumn
        x={groupsX()}
        shown
        heading={$t("menu.settings")}
        items={CATEGORIES.map(one => ({ label: $t(one.label) }))}
        top={0}
        cursor={cursorIndex()}
        current={shownIndex()}
        focused={focused() && !inPane()}
      />
    </View>
  );
};
