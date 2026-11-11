// Velio Sync on the TV (SYNC-PLAN.md, steps 2–7), against the test server's
// made-up account (scripts/test-streams/syncServer.mjs): `pnpm test-streams`
// on the dev machine. Each step is a few seconds.
//
//   "signin"   signs out if signed in, points the app at `base`, starts a
//              pairing, approves it as the phone would (with `profiles`),
//              then signs in and pulls. Says how long the open took in the
//              worker, the frames during it, and the socket's state.
//   "addlist"  adds a list on the "web" for `profiles`, and times how long
//              the TV takes to have it as a source (the socket's "rev N").
//   "pin"      sets `pin` on the profile `profile` ("" removes it).
//   "remove"   removes the TV from the account; the TV should sign out.
//   "signout"  signs out from the TV.
//   "status"   what the TV has.
//
// Input:
//   "step": "signin" | "addlist" | "pin" | "remove" | "signout" | "status"
//   "base": "http://<dev machine>:8090"
//   "profiles": "Living room,Kids"      for signin and addlist
//   "profile": "Kids", "pin": "1234"     for pin

async function probe(input) {
  const app = window.velio;
  if (!app?.sync) return { error: "window.velio.sync is missing: deploy the app first" };
  const { sync, profiles, events, library } = app;
  const base = (input.base || "").replace(/\/$/, "");
  const owner = async (action, query) => {
    const response = await fetch(`${base}/sync/${action}?${new URLSearchParams(query || {})}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.problem || `HTTP ${response.status}`);
    return body;
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, ms) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (check()) return Date.now() - started;
      await wait(50);
    }
    return undefined;
  };
  const status = () => ({
    signedIn: sync.signedIn(),
    site: sync.site(),
    rev: sync.view()?.rev,
    profiles: profiles.list().map(p => `${p.name}${p.pin ? " (PIN)" : ""}`),
    current: profiles.current()?.name,
    needsPick: profiles.needsPick(),
    sources: library
      .sources()
      .map(s => `${s.name}${s.synced ? ` [synced: ${(s.profiles || []).length}]` : ""}`),
    shown: app.shownSources().map(s => s.name),
    socket: events.state(),
    lastPull: sync.status().last && {
      result: sync.status().last.result,
      problem: sync.status().last.problem,
    },
    notice: sync.signedOutNotice(),
  });

  if (input.step === "status") return status();
  if (input.step === "signout") {
    await sync.signOut();
    return status();
  }

  if (input.step === "signin") {
    if (sync.signedIn()) await sync.signOut();
    sync.dismissNotice();
    if (!sync.setSite(base)) return { error: `Couldn't point the app at ${base}` };
    const startedAt = performance.now();
    const pairing = await app.pairing.startPairing(base, app.pairing.tvName(), (a, b) => fetch(a, b));
    const run = app.pairing.waitForOwner(pairing, (a, b) => fetch(a, b));
    const approved = await owner("approve", { code: pairing.code, profiles: input.profiles || "" });
    const step = await run.done;
    if (!step || step.status !== "done") return { error: "Sign-in didn't finish", step, approved };
    const signedInMs = Math.round(performance.now() - startedAt);

    // Frames while the pull is checked and opened in the worker.
    let frames = 0;
    let worst = 0;
    let last = performance.now();
    let counting = true;
    const tick = () => {
      const at = performance.now();
      worst = Math.max(worst, at - last);
      last = at;
      frames++;
      if (counting) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const pullStarted = performance.now();
    const outcome = await sync.signIn(step.trust, step.token);
    const pullMs = Math.round(performance.now() - pullStarted);
    counting = false;
    const socketMs = await until(() => events.state() === "open", 5000);
    return {
      device: approved.device,
      name: approved.name,
      signedInMs,
      pull: {
        result: outcome.result,
        ms: pullMs,
        open: { ...app.syncOpen },
        frames,
        worstFrameMs: Math.round(worst),
      },
      socketMs,
      ...status(),
    };
  }

  if (input.step === "addlist") {
    const before = library.sources().length;
    const name = `Added ${Date.now() % 100000}`;
    const started = Date.now();
    await owner("add-list", { name, channels: 10, profiles: input.profiles || "" });
    const ms = await until(() => library.sources().some(s => s.name === name), 20000);
    const importing = await until(() => {
      const source = library.sources().find(s => s.name === name);
      return source && (library.statusOf(source.id).importing || library.statusOf(source.id).state);
    }, 20000);
    return {
      name,
      before,
      sourceAfterMs: ms,
      importStartedAfterMs: importing,
      totalMs: Date.now() - started,
      ...status(),
    };
  }

  if (input.step === "pin") {
    await owner("pin", { profile: input.profile || "", pin: input.pin || "" });
    const ms = await until(
      () => profiles.list().some(p => p.name === input.profile && (input.pin ? p.pin === input.pin : !p.pin)),
      20000,
    );
    return { ms, ...status() };
  }

  if (input.step === "remove") {
    await owner("remove-device");
    const ms = await until(() => !sync.signedIn(), 20000);
    return { signedOutAfterMs: ms, ...status() };
  }

  return { error: `No step ${input.step}` };
}
