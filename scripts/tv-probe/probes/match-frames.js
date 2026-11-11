// The long frames on Movies while matches come in (PLAN.md, "Movies and
// Series by title", "Next: the long frames while matching"). Opens Movies on
// All films, then shows `count` matches again (titleMatcher.reshow(): the
// same matches as copies, so every step after the join runs as when new
// matches are shown, and nothing kept changes) `rounds` times, a few seconds
// apart. Reports how long each took on the thread before returning, and the
// longest gap between frames after it. Then it saves the matches shown
// again, as the matcher does every 30 s while it matches (spread over the
// sources, so every block is written), and reports how long the save took
// and the longest gap between frames meanwhile. Last, it checks that new
// matches wait while keys are pressed, and show once they stop. About 50 s. With PROBE_PROFILE set, the rounds
// are saved as page-match-frames.cpuprofile and the writes as
// page-match-save.cpuprofile.
//
// Input, all optional:
//   "count": 300     matches shown again each round
//   "rounds": 5
//   "group": "all"   the group shown, such as "genre:Drama"

async function probe(input) {
  const app = window.velio;
  const count = input.count ?? 300;
  const rounds = input.rounds ?? 5;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async (test, ms = 30_000) => {
    const start = performance.now();
    while (!test()) {
      if (performance.now() - start > ms) return false;
      await sleep(50);
    }
    return true;
  };
  location.hash = "#/movies";
  if (!(await waitFor(() => app.moviesGrid?.items().length > 0)))
    return { error: "Movies has no titles", hash: location.hash };
  const grid = app.moviesGrid;
  grid.setFilterId(input.group ?? "all");
  await sleep(3000);

  // Frame gaps, from requestAnimationFrame.
  let last = performance.now();
  let worst = 0;
  let running = true;
  const frame = now => {
    worst = Math.max(worst, now - last);
    last = now;
    if (running) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  await sleep(1000);
  const idleWorst = Math.round(worst);

  const out = {
    titles: app.moviesPage.titles().titles.length,
    shown: grid.items().length,
    group: grid.rowId(),
    sort: grid.sortOf(),
    matching: app.titleMatcher.progress().running,
    idleWorst,
    rounds: [],
  };
  console.profile("match-frames");
  for (let round = 0; round < rounds; round++) {
    await sleep(500);
    worst = 0;
    const t = performance.now();
    const reshown = app.titleMatcher.reshow(count);
    const sync = performance.now() - t;
    await sleep(2500);
    out.rounds.push({ reshown, syncMs: Math.round(sync), worstFrameMs: Math.round(worst) });
  }
  console.profileEnd("match-frames");

  // The matcher's save of the blocks those rounds changed (flush() in src/data/titleMatches.ts).
  out.saves = [];
  console.profile("match-save");
  for (let round = 0; round < 2; round++) {
    app.titleMatcher.reshow(count);
    await sleep(2500);
    worst = 0;
    const t = performance.now();
    await app.titleMatcher.flush();
    const writeMs = performance.now() - t;
    await sleep(500);
    out.saves.push({ writeMs: Math.round(writeMs), worstFrameMs: Math.round(worst) });
  }
  console.profileEnd("match-save");

  // Held while keys are pressed (QUIET_MS in src/pages/vod/modernTitles.ts).
  const titlesBefore = app.moviesPage.titles();
  const keyAt = () => document.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 0, bubbles: true }));
  keyAt();
  app.titleMatcher.reshow(10);
  let changedWhilePressing = false;
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    keyAt();
    if (app.moviesPage.titles() !== titlesBefore) changedWhilePressing = true;
  }
  const stoppedAt = performance.now();
  await waitFor(() => app.moviesPage.titles() !== titlesBefore, 5000);
  out.quiet = { changedWhilePressing, shownAfterMs: Math.round(performance.now() - stoppedAt) };
  running = false;
  out.cursorStill = grid.cursor();
  return out;
}
