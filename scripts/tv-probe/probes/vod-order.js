// Movies' order (PLAN.md, "Ordering and sorting out titles"): opens Movies
// on All, reports its order and whether its first titles are the newest
// added, then, with the Tools key, opens the order menu, picks By name and
// checks the titles are by name, and picks the order it had again. It also
// reports the years of a few films whose names hold a number, the genres in
// the column, and whether matching is running. About half a minute.
//
// Input, all optional:
//   "names": ["2049", "2001"]   words to look for in the titles' names

async function probe(input) {
  const app = window.velio;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async (test, ms = 20_000) => {
    const start = performance.now();
    while (!test()) {
      if (performance.now() - start > ms) return false;
      await sleep(50);
    }
    return true;
  };
  const press = keyCode => {
    document.dispatchEvent(new KeyboardEvent("keydown", { keyCode, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { keyCode, bubbles: true }));
  };
  const KEY = { down: 40, up: 38, enter: 13, tools: 10135 };
  const SORTS = ["added", "name", "year", "rating", "listed"];

  location.hash = "#/movies";
  if (!(await waitFor(() => app.moviesGrid?.items().length > 0)))
    return { error: "Movies has no titles", hash: location.hash };
  const grid = app.moviesGrid;
  grid.setFilterId("all");
  await sleep(500);
  const first = count =>
    grid
      .items()
      .slice(0, count)
      .map(one => ({ name: one.name, added: one.added, year: one.year, rating: one.rating }));
  const before = grid.sortOf();
  const startTitles = first(5);
  // From the menu into the page. If the posters had the keys already, Right
  // moved the cursor instead, and Left puts it back.
  const KEYS_IN = { right: 39, left: 37 };
  const at = grid.cursor();
  press(KEYS_IN.right);
  await sleep(300);
  if (grid.cursor() !== at) press(KEYS_IN.left);
  await sleep(200);
  const area = grid.area();

  // Tools on the posters opens the order; Down moves to the choice, OK picks it.
  const pick = async sort => {
    press(KEY.tools);
    if (!(await waitFor(() => grid.sorting() !== undefined, 3000))) return { opened: false };
    // The menu takes the keys once it's drawn.
    await waitFor(() => app.channelOptions !== undefined, 3000);
    await sleep(400);
    const options = app.channelOptions?.options() ?? [];
    for (let i = app.channelOptions?.cursor() ?? 0; i < SORTS.indexOf(sort); i++) {
      press(KEY.down);
      await sleep(80);
    }
    press(KEY.enter);
    const closed = await waitFor(() => grid.sorting() === undefined, 3000);
    await sleep(300);
    return { opened: true, options, closed, sort: grid.sortOf(), cursor: grid.cursor() };
  };
  const byName = await pick("name");
  const nameTitles = first(8).map(one => one.name);
  const restored = await pick(before ?? "added");

  const { titles } = app.moviesPage.titles();
  const words = input.names ?? ["2049", "2001", "1917", "300"];
  const numbered = titles
    .filter(one => words.some(word => one.name.includes(word)))
    .slice(0, 12)
    .map(one => ({ name: one.name, year: one.year, matched: Boolean(one.imdb), links: one.links.length }));

  return {
    done: {
      sortBefore: before,
      area,
      startTitles,
      addedDescending: startTitles.every(
        (one, i) => i === 0 || (one.added ?? 0) <= (startTitles[i - 1].added ?? Infinity),
      ),
      byName,
      nameTitles,
      restored,
      titles: titles.length,
      rated: titles.filter(one => one.rating !== undefined).length,
      groups: grid.rows().map(one => `${one.label} (${one.items.length})`),
      matching: app.titleMatcher?.progress?.(),
      numbered,
    },
  };
}
