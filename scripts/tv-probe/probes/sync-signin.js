// The account on the TV (SYNC-PLAN.md), against the test server's made-up
// account on a fake Nuvio server (scripts/test-streams/syncServer.mjs):
// `pnpm test-streams` on the dev machine. Each step is a few seconds.
//
//   "signin"   signs out if signed in, points the app at `base`, asks for a
//              code, approves it as the phone would, then signs in and
//              pulls. Says how long each took, and the frames during the pull.
//   "addlist"  adds a list on the "web" for `profiles`, pulls (the TV pulls
//              by itself every 5 minutes), and times how long the TV takes
//              to have it as a source.
//   "pin"      sets `pin` on the profile `profile` ("" removes it), pulls,
//              and checks the PIN with the server.
//   "remove"   signs the TV out on the account; the next pull signs it out.
//   "signout"  signs out from the TV, then points it at `site` if given
//              (such as "https://velio.tv", to undo "signin"'s `base`).
//   "status"   what the TV has.
//
// Input:
//   "step": "signin" | "addlist" | "pin" | "remove" | "signout" | "status"
//   "base": "http://<dev machine>:8090"
//   "profiles": "Living room,Kids"      for addlist
//   "profile": "Kids", "pin": "1234"     for pin

async function probe(input) {
  const app = window.velio;
  if (!app?.sync) return { error: "window.velio.sync is missing: deploy the app first" };
  const { sync, profiles, library } = app;
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
    profiles: profiles.list().map(p => `${p.name}${p.locked ? " (PIN)" : ""}`),
    current: profiles.current()?.name,
    needsPick: profiles.needsPick(),
    sources: library
      .sources()
      .map(s => `${s.name}${s.synced ? ` [synced: ${(s.profiles || []).length}]` : ""}`),
    shown: app.shownSources().map(s => s.name),
    lastPull: sync.status().last && {
      result: sync.status().last.result,
      problem: sync.status().last.problem,
    },
    notice: sync.signedOutNotice(),
  });

  if (input.step === "status") return status();
  if (input.step === "signout") {
    await sync.signOut();
    if (input.site && !sync.setSite(input.site)) return { error: `Couldn't point the app at ${input.site}` };
    return status();
  }

  if (input.step === "signin") {
    if (sync.signedIn()) await sync.signOut();
    sync.dismissNotice();
    if (!sync.setSite(base)) return { error: `Couldn't point the app at ${base}` };
    const startedAt = performance.now();
    const pairing = await app.pairing.startPairing(base, app.pairing.tvName(), (a, b) => fetch(a, b));
    const run = app.pairing.waitForOwner(pairing, (a, b) => fetch(a, b));
    const approved = await owner("approve", { code: pairing.userCode || pairing.url });
    const step = await run.done;
    if (!step || step.status !== "done") return { error: "Sign-in didn't finish", step, approved };
    const signedInMs = Math.round(performance.now() - startedAt);

    // Frames while the pull is read and the view built.
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
    const outcome = await sync.signIn(step.server, step.session);
    const pullMs = Math.round(performance.now() - pullStarted);
    counting = false;
    return {
      name: approved.name,
      userCode: pairing.userCode,
      signedInMs,
      pull: {
        result: outcome.result,
        problem: outcome.problem,
        ms: pullMs,
        frames,
        worstFrameMs: Math.round(worst),
      },
      ...status(),
    };
  }

  if (input.step === "addlist") {
    const before = library.sources().length;
    const name = `Added ${Date.now() % 100000}`;
    const started = Date.now();
    await owner("add-list", { name, channels: 10, profiles: input.profiles || "" });
    const pulled = await sync.pull();
    const ms = await until(() => library.sources().some(s => s.name === name), 20000);
    const importing = await until(() => {
      const source = library.sources().find(s => s.name === name);
      return source && (library.statusOf(source.id).importing || library.statusOf(source.id).state);
    }, 20000);
    return {
      name,
      before,
      pulled: pulled.result,
      sourceAfterMs: ms,
      importStartedAfterMs: importing,
      totalMs: Date.now() - started,
      ...status(),
    };
  }

  if (input.step === "pin") {
    await owner("pin", { profile: input.profile || "", pin: input.pin || "" });
    const pulled = await sync.pull();
    const ms = await until(
      () => profiles.list().some(p => p.name === input.profile && Boolean(p.locked) === Boolean(input.pin)),
      20000,
    );
    const profile = profiles.list().find(p => p.name === input.profile);
    const checked = input.pin && profile ? await sync.checkPin(profile.id, input.pin) : undefined;
    return { pulled: pulled.result, ms, checked, ...status() };
  }

  if (input.step === "remove") {
    await owner("remove-device");
    const pulled = await sync.pull();
    const ms = await until(() => !sync.signedIn(), 20000);
    return { pulled: pulled.result, signedOutAfterMs: ms, ...status() };
  }

  return { error: `No step ${input.step}` };
}
