// Pins a group at the top of Live's groups and of Movies' (PLAN.md,
// "Pinned groups"), reports where each shows, then unpins them, leaving the
// TV as it was. About 5 s.
//
// Input, all optional:
//   "group": the Live group's key to pin (default: the second group shown)
//   "keep": true    leave them pinned, to look at on the TV

async function probe(input) {
  const { keep = false } = input;
  const app = window.velio;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const result = {};

  // Live.
  location.hash = "#/";
  await sleep(1500);
  const live = () => app.guidePage.filters().map(f => f.label);
  const groups = app.liveView().groups.map(group => group.name);
  const key = input.group ?? groups[1] ?? groups[0];
  const wasPinned = app.edits.isGroupPinned(key);
  result.live = { key, before: live().slice(0, 4) };
  app.edits.setGroupPinned(key, true);
  await sleep(300);
  result.live.pinned = live().slice(0, 4);
  result.live.pinnedFlag = app.guidePage.filters()[0]?.pinned === true;
  if (!keep && !wasPinned) app.edits.setGroupPinned(key, false);
  await sleep(300);
  result.live.after = live().slice(0, 4);

  // Movies.
  location.hash = "#/movies";
  await sleep(2000);
  const page = app.vodLayout.modern() ? "movies" : "classic-movies";
  const grid = () => app.moviesGrid?.rows() ?? [];
  const pinnable = grid().filter(row => !["search", "continue", "all"].includes(row.id));
  const target = pinnable[1] ?? pinnable[0];
  result.movies = {
    page,
    before: grid()
      .slice(0, 4)
      .map(row => row.label),
  };
  if (target) {
    const was = app.vodPins.isPinned(page, target.id);
    app.vodPins.set(page, target.id, true);
    await sleep(300);
    result.movies.target = target.label;
    result.movies.pinned = grid()
      .slice(0, 4)
      .map(row => `${row.label}${row.pinned ? " (pinned)" : ""}`);
    if (!keep && !was) app.vodPins.set(page, target.id, false);
    await sleep(300);
    result.movies.after = grid()
      .slice(0, 4)
      .map(row => row.label);
  }
  return result;
}
