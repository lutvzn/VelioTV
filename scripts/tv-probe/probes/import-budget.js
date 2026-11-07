// Phase 8, step 3: imports a source's playlist and guide again under a
// probe's own source id, with the guide budget and days given, and reports
// the progress every 5 s and how it ended; then deletes what it stored. The
// source itself is turned off first, so its own import doesn't run beside
// this one ("enable": true turns it on again, and does nothing else).
// About 2 minutes for the 10,000-channel test source.
//
// Input:
//   "source": "Test 10k"   the source's name
//   "budgetMb": 10         the guide budget
//   "days": 2              guide days from today
//   "enable": true         only turn the source on again

async function probe(input) {
  const app = window.tiviplayer;
  const { library, importSource, db: data } = app;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (label, value) => console.log("[probe]", label, JSON.stringify(value));
  const source = library.sources().find(one => one.name === (input.source ?? "Test 10k"));
  if (!source) return { error: "No such source", sources: library.sources().map(one => one.name) };
  if (input.enable) {
    library.setDisabled(source.id, false);
    return { enabled: source.name };
  }
  library.setDisabled(source.id, true);
  await library.whenIdle();

  const id = "probe-budget";
  const request = {
    source: id,
    kind: "m3u",
    playlistUrl: source.url,
    guideDays: input.days ?? 2,
    guideBudgetBytes: (input.budgetMb ?? 10) * 1_048_576,
  };
  let last;
  const started = performance.now();
  const seconds = () => Math.round((performance.now() - started) / 1000);
  const timer = setInterval(() => log(`${seconds()} s`, last), 2000);
  let result;
  try {
    let stopped;
    let lastDay;
    let write;
    result = await importSource(request, progress => {
      const { guide } = progress;
      last = {
        stage: progress.stage,
        programmes: progress.programmes,
        mb: Math.round(progress.bytes / 1e5) / 10,
        guideMb: guide && Math.round(guide.bytes / 1e5) / 10,
        lastDay: guide?.lastDay,
        stopped: guide?.stopped,
        write: guide?.write,
      };
      // Each change of the days kept, or a stop, as it comes.
      if (guide && (guide.stopped !== stopped || guide.lastDay !== lastDay || guide.write !== write)) {
        stopped = guide.stopped;
        lastDay = guide.lastDay;
        write = guide.write;
        log(`${seconds()} s: writer`, last);
      }
    });
  } catch (caught) {
    result = { error: String(caught) };
  } finally {
    clearInterval(timer);
  }
  log(`${seconds()} s: import ended`, { status: result.status, error: result.error });
  await sleep(2000);
  const db = await data.openDb();
  const measured = await data.measureGuide(db, id);
  log(`${seconds()} s: guide measured`, measured);
  await data.deleteSource(db, id);
  db.close();
  log(`${seconds()} s: deleted`, true);
  const { status, error, programmes, programmesRead, guideBytes, guideFirstDay, guideLastDay, guideTrimmed } =
    result;
  return {
    seconds: seconds(),
    status,
    error,
    programmes,
    programmesRead,
    guideMb: guideBytes && Math.round(guideBytes / 1e5) / 10,
    guideFirstDay,
    guideLastDay,
    guideTrimmed,
    measured,
  };
}
