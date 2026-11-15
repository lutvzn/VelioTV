// The menus of the options panel (src/pages/live/ChannelOptions.tsx) for a
// channel and for a group (PLAN.md, Phase 5, steps 1 to 5): favourites,
// hiding, locking, moving a channel to another group, and renaming,
// ordering and sorting groups. Each reads the edits as it shows, so it
// follows the changes it makes.

import { inArchive } from "../../data/catchup";
import { CUSTOM_GROUP, GROUP_SORTS, type GroupSort } from "../../data/channelEdits";
import type { StoredProgramme } from "../../data/guideCodec";
import type { Channel } from "../../data/lineup";
import { FAVOURITES } from "../../live/groups";
import { edits, groupTitle, liveView, reminders, settings } from "../../library";
import { askPin } from "../../pin";
import { editText } from "../../textEntry";
import { $t } from "../../translate";

export interface MenuOption {
  id: string;
  label: string;
  /** Shown fainter, for a line that only says something. */
  dim?: boolean;
  /** Does the option: a menu opens in the panel, "stay" keeps it open, and anything else closes it. */
  run: () => Menu | "stay" | void;
}

export interface Menu {
  title: string;
  options: () => MenuOption[];
}

// Where the TV's keyboard edits a name: over the panel's title.
const NAME_RECT = { x: 1920 - 640 + 24, y: 40, width: 640 - 48, height: 64 };

const askName = (value: string, onName: (name: string) => void) =>
  editText({
    rect: NAME_RECT,
    value,
    fontSize: 34,
    onDone: typed => {
      if (typed.trim()) onName(typed.trim());
    },
  });

/** A menu that only says something; OK closes it. */
const notice = (title: string, text: string): Menu => ({
  title,
  options: () => [{ id: "notice", label: text, dim: true, run: () => undefined }],
});

/** Lock, or unlock once the PIN is entered. Locking needs a PIN set first. */
const lockOption = (locked: boolean, set: (on: boolean) => void): MenuOption => ({
  id: locked ? "unlock" : "lock",
  label: locked ? $t("options.unlock") : $t("options.lock"),
  run: () => {
    if (locked) {
      void askPin().then(right => right && set(false));
      return undefined;
    }
    if (!settings.hasPin()) return notice($t("options.lock"), $t("options.needPin"));
    set(true);
    return undefined;
  },
});

/** The groups shown, not counting Favourites, in order. */
const shownGroups = () =>
  liveView()
    .groups.map(group => group.name)
    .filter(key => key !== FAVOURITES);

const moveToMenu = (channel: Channel): Menu => ({
  title: $t("options.moveTo"),
  options: () => {
    const own = channel.group ?? "";
    const current = liveView().groupOf(channel);
    const keys = [...new Set([...edits.customGroups(), ...shownGroups()])].filter(key => key !== current);
    return [
      {
        id: "newGroup",
        label: $t("options.newGroup"),
        run: () =>
          askName("", name => {
            const key = edits.createGroup(name);
            edits.moveChannel(channel.id, key);
          }),
      },
      ...keys.map(key => ({
        id: `group:${key}`,
        label: groupTitle(key),
        run: () => edits.moveChannel(channel.id, key === own ? undefined : key),
      })),
    ];
  },
});

/**
 * A programme's options, for a channel's menu (PLAN.md, Phase 6): watching
 * it from the start from the channel's catch-up, once it has begun, or a
 * reminder, before it starts.
 */
export const programmeOptions = (
  channel: Channel,
  programme: StoredProgramme | undefined,
  now: number,
  watchFromStart: (programme: StoredProgramme) => void,
): MenuOption[] => {
  if (!programme) return [];
  if (inArchive(channel, programme.start, now)) {
    return [
      {
        id: "fromStart",
        label: programme.stop > now ? $t("options.fromStart") : $t("options.playRecording"),
        run: () => watchFromStart(programme),
      },
    ];
  }
  if (programme.start <= now) return [];
  const reminder = {
    channelId: channel.id,
    channelName: channel.name,
    title: programme.title,
    start: programme.start,
    stop: programme.stop,
  };
  return [
    {
      id: "remind",
      label: reminders.has(channel.id, programme.start) ? $t("options.noReminder") : $t("options.remind"),
      run: () => reminders.toggle(reminder),
    },
  ];
};

/** A channel's options; `extra` are the page's own, after the first. */
export const channelMenu = (channel: Channel, extra: MenuOption[] = []): Menu => ({
  title: channel.name,
  options: () => {
    const id = channel.id;
    const moved = edits.movedTo(id) !== undefined;
    return [
      {
        id: "favourite",
        label: edits.isFavourite(id) ? $t("options.unfavourite") : $t("options.favourite"),
        run: () => edits.toggleFavourite(id),
      },
      ...extra,
      { id: "moveTo", label: $t("options.moveTo"), run: () => moveToMenu(channel) },
      ...(moved
        ? [
            {
              id: "moveBack",
              label: $t("options.moveBack", { group: groupTitle(channel.group ?? "") }),
              run: () => edits.moveChannel(id, undefined),
            },
          ]
        : []),
      { id: "hide", label: $t("options.hide"), run: () => edits.setChannelHidden(id, true) },
      lockOption(edits.isChannelLocked(id), on => edits.setChannelLocked(id, on)),
    ];
  },
});

const sortLabel = (sort: GroupSort) => $t(`options.sort.${sort}`);

const sortMenu = (key: string): Menu => ({
  title: $t("options.sortBy"),
  options: () =>
    GROUP_SORTS.map(sort => ({
      id: `sort:${sort}`,
      label: `${edits.sortOf(key) === sort ? "•  " : "    "}${sortLabel(sort)}`,
      run: () => edits.setGroupSort(key, sort),
    })),
});

/**
 * The groups a group moves among, as shown: the pinned ones at the top, or
 * the others.
 */
const neighbours = (key: string) => {
  const pinned = edits.isGroupPinned(key);
  return shownGroups().filter(other => edits.isGroupPinned(other) === pinned);
};

/** Moves a group `step` places among the groups shown, pinned or not as it is. */
export const moveGroup = (key: string, step: number) => {
  const keys = neighbours(key);
  const from = keys.indexOf(key);
  const to = Math.max(0, Math.min(keys.length - 1, from + step));
  if (from < 0 || from === to) return;
  keys.splice(from, 1);
  keys.splice(to, 0, key);
  // Groups hidden or empty now keep their place after the rest.
  const shown = new Set(keys);
  if (edits.isGroupPinned(key)) {
    edits.setPinnedOrder([...keys, ...edits.pinnedGroups().filter(other => !shown.has(other))]);
  } else {
    edits.setGroupOrder([...keys, ...edits.groupOrder().filter(other => !shown.has(other))]);
  }
};

// Moves the group and keeps the panel open, to move it again.
const shift = (key: string, step: number) => () => {
  moveGroup(key, step);
  return "stay" as const;
};

/** A group's options: Favourites, every channel and search results have none. */
export const groupMenu = (key: string): Menu => ({
  title: groupTitle(key),
  options: () => {
    const custom = key.startsWith(CUSTOM_GROUP);
    const keys = neighbours(key);
    const at = keys.indexOf(key);
    const pinned = edits.isGroupPinned(key);
    return [
      {
        id: pinned ? "unpin" : "pin",
        label: pinned ? $t("options.unpin") : $t("options.pin"),
        run: () => edits.setGroupPinned(key, !pinned),
      },
      {
        id: "rename",
        label: $t("options.rename"),
        run: () => askName(groupTitle(key), name => edits.renameGroup(key, name)),
      },
      ...(edits.groupNames()[key] !== undefined && !custom
        ? [
            {
              id: "ownName",
              label: $t("options.ownName", { name: key || $t("live.noGroup") }),
              run: () => edits.renameGroup(key, ""),
            },
          ]
        : []),
      ...(at > 0 ? [{ id: "moveUp", label: $t("options.moveUp"), run: shift(key, -1) }] : []),
      ...(at >= 0 && at < keys.length - 1
        ? [{ id: "moveDown", label: $t("options.moveDown"), run: shift(key, 1) }]
        : []),
      {
        id: "sort",
        label: $t("options.sort", { sort: sortLabel(edits.sortOf(key)) }),
        run: () => sortMenu(key),
      },
      { id: "hideGroup", label: $t("options.hideGroup"), run: () => edits.setGroupHidden(key, true) },
      lockOption(edits.isGroupLocked(key), on => edits.setGroupLocked(key, on)),
      ...(custom
        ? [{ id: "deleteGroup", label: $t("options.deleteGroup"), run: () => edits.deleteGroup(key) }]
        : []),
    ];
  },
});
