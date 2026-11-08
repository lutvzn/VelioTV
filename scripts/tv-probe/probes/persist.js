// Phase 5, step 8, the done check: the user's edits and settings last
// through a restart, and through a backup, a reinstall and a restore. Run it
// three times, as `run.sh` restarts the app each time:
//
//   1. {"phase": "set", "url": "http://<dev-ip>:8090/backup/probe.json"}
//      With the 10k test source imported, it adds a 50-channel source from
//      the same server, moves it first, turns it off and on, then changes
//      edits and settings (below), checks them in the view, and backs up.
//      About a minute.
//   2. {"phase": "check"}   after the restart: everything is as it was set,
//      the app opened on the guide, and the PIN is asked for again.
//      Under a minute.
//   3. Reinstall the app (tizen uninstall, then deploy), then
//      {"phase": "restore", "url": ...}: restores from the backup, waits
//      for both sources to import (about 3 minutes for 10,000 channels), and
//      checks again. Give the runner a long enough timeout.
//
// The edits: two favourites, a channel hidden, a group hidden, a group
// renamed and sorted by name, a custom group with a channel moved into it,
// the custom group first, and a channel locked behind PIN 2468. The
// settings: open on the guide, 12-hour clock.
//
// Each phase returns "hash", a checksum of the sources, edits and settings;
// it should be the same in all three.
//
// Input:
//   "phase": "set" | "check" | "restore"
//   "url": the backup's URL (set and restore)
//   "timeoutSeconds": 300   how long restore waits for the imports

async function probe(input) {
  const app = window.velio;
  if (!app?.restoreFrom) return { error: "this build has no backup: deploy the app first" };
  const { phase, url, timeoutSeconds = 300 } = input;
  const { library, lineup, edits, settings, liveView } = app;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (label, value) => console.log("[probe]", label, JSON.stringify(value));
  const waitFor = async (test, ms = 15_000) => {
    const start = performance.now();
    while (!test()) {
      if (performance.now() - start > ms) return undefined;
      await sleep(100);
    }
    return Math.round(performance.now() - start);
  };
  const idle = ms => waitFor(() => library.loaded() && !library.importing() && !lineup.loading(), ms);
  const SMALL_NAME = "Probe 50";
  const PIN = "2468";

  // What has to last, without what changes by itself (import times, ids made here).
  const fingerprint = () =>
    JSON.stringify({
      sources: library.sources().map(({ name, kind, url: address, refreshHours, disabled }) => ({
        name,
        kind,
        url: address,
        refreshHours,
        disabled: !!disabled,
      })),
      edits: edits.all(),
      settings: settings.all(),
    });
  const hash = text => {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return h.toString(16);
  };

  // What the view does with the edits, from the edits themselves.
  const viewChecks = () => {
    const view = liveView();
    const all = edits.all();
    const shownIds = new Set(view.channels.map(channel => channel.id));
    const groupKeys = view.groups.map(group => group.name);
    const custom = all.customGroups[0];
    const moved = Object.keys(all.movedChannels)[0];
    const locked = lineup.find(all.lockedChannels[0] ?? "");
    const renamed = Object.keys(all.groupNames).find(key => !key.startsWith("\u0001"));
    const renamedGroup = view.groups.find(group => group.name === renamed);
    const names = renamedGroup?.channels.map(channel => channel.name) ?? [];
    const small = library.sources().find(source => source.name === SMALL_NAME);
    return {
      channels: lineup.channels().length,
      shown: view.channels.length,
      favouritesFirst: groupKeys[0] === "\u0000favourites" && view.groups[0].channels.length === 2,
      customNext: groupKeys[1] === custom && view.groups[1].channels.some(channel => channel.id === moved),
      hiddenChannelOut: all.hiddenChannels.length === 1 && !shownIds.has(all.hiddenChannels[0]),
      hiddenGroupOut: all.hiddenGroups.length === 1 && !groupKeys.includes(all.hiddenGroups[0]),
      renamedSorted:
        !!renamedGroup &&
        names.every(
          (name, at) =>
            at === 0 ||
            names[at - 1].localeCompare(name, undefined, { sensitivity: "base", numeric: true }) <= 0,
        ),
      locked: !!locked && view.isLocked(locked),
      smallFirst:
        !!small && library.sources()[0]?.id === small.id && lineup.channels()[0]?.source === small.id,
      startOn: settings.startOn(),
      clock: settings.clock(),
      pinSet: settings.hasPin(),
    };
  };

  if (phase === "set") {
    if (!url) return { error: "set needs the backup's url" };
    await waitFor(() => lineup.channels().length > 0, 30_000);
    await idle(60_000);
    const big = library.sources()[0];
    if (!big) return { error: "no source: add the 10k test source first" };

    // A second source: first in the lineup, then off and on again.
    for (const source of library.sources().filter(other => other.name === SMALL_NAME))
      await library.remove(source.id);
    const playlist = new URL(big.url ?? `${big.server}/`);
    const small = library.add({
      name: SMALL_NAME,
      kind: "m3u",
      url: `${playlist.origin}/playlist.m3u?channels=50&days=2`,
      refreshHours: 24,
    });
    await idle(60_000);
    library.move(small.id, -1);
    await sleep(300);
    const order = {
      first: library.sources()[0]?.id === small.id,
      lineupFirst: lineup.channels()[0]?.source === small.id,
    };
    library.setDisabled(small.id, true);
    await sleep(500);
    const off = {
      outOfLineup: !lineup.channels().some(channel => channel.source === small.id),
      dataKept: library.statusOf(small.id).state?.status === "done",
      notImporting: !library.importing(),
    };
    library.setDisabled(small.id, false);
    await waitFor(() => lineup.channels().some(channel => channel.source === small.id), 10_000);
    const on = { back: lineup.channels()[0]?.source === small.id, noImport: !library.importing() };
    log("sources", { order, off, on });

    // The edits, on the big source's channels.
    const channels = lineup.channels().filter(channel => channel.source === big.id);
    const groups = [...new Set(channels.map(channel => channel.group ?? ""))];
    edits.replace({
      favourites: [],
      hiddenChannels: [],
      hiddenGroups: [],
      lockedChannels: [],
      lockedGroups: [],
      groupNames: {},
      customGroups: [],
      groupOrder: [],
      movedChannels: {},
      groupSort: {},
    });
    edits.setFavourite(channels[3].id, true);
    edits.setFavourite(channels[1].id, true);
    edits.setChannelHidden(channels[5].id, true);
    edits.setGroupHidden(groups[groups.length - 1], true);
    edits.renameGroup(groups[1], "Probe renamed");
    edits.setGroupSort(groups[1], "name");
    const custom = edits.createGroup("Probe custom");
    edits.moveChannel(channels[6].id, custom);
    edits.setGroupOrder([custom]);
    edits.setChannelLocked(channels[7].id, true);
    settings.setPin(PIN);
    settings.setStartOn("guide");
    settings.setClock("12h");
    await sleep(500);

    const checks = viewChecks();
    let backedUp;
    try {
      await app.backUpTo(url);
      backedUp = true;
    } catch (error) {
      backedUp = String(error);
    }
    const text = fingerprint();
    return {
      phase,
      sources: { order, off, on },
      checks,
      backedUp,
      hash: hash(text),
      fingerprint: JSON.parse(text),
    };
  }

  if (phase === "check") {
    await waitFor(() => lineup.channels().length > 0, 30_000);
    await idle(30_000);
    await sleep(500);
    return {
      phase,
      openedOn: location.hash,
      guideOpen: !!app.guidePage,
      pinAskedAgain: !settings.unlocked(),
      checks: viewChecks(),
      hash: hash(fingerprint()),
    };
  }

  if (phase === "restore") {
    if (!url) return { error: "restore needs the backup's url" };
    await waitFor(() => library.loaded(), 15_000);
    const before = { sources: library.sources().length, edits: JSON.stringify(edits.all()).length };
    const started = performance.now();
    let restored;
    try {
      const backup = await app.restoreFrom(url);
      restored = { sources: backup.sources.length, savedAt: backup.savedAt };
    } catch (error) {
      return { phase, error: String(error) };
    }
    await sleep(1000);
    const imported = await idle(timeoutSeconds * 1000);
    await sleep(1000);
    return {
      phase,
      before,
      restored,
      importSeconds: imported === undefined ? "timed out" : Math.round((performance.now() - started) / 1000),
      states: library.sources().map(source => [source.name, library.statusOf(source.id).state?.status]),
      pinAsked: !settings.unlocked(),
      checks: viewChecks(),
      hash: hash(fingerprint()),
    };
  }

  return { error: 'phase must be "set", "check" or "restore"' };
}
