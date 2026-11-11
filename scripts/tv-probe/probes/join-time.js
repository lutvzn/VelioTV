// Times the modern Movies page's join of every film into titles
// (src/data/titles.ts) and its genre and category rows, three times each,
// on the TV (PLAN.md, "Movies and Series by title"). About 30 s.
//
// Input: none.
async function probe(input) {
  const app = window.velio;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  location.hash = "#/movies";
  for (let i = 0; i < 100 && !(app.vod.films().length > 0 && !app.vod.loading()); i++) await sleep(200);
  await sleep(4000);
  const films = app.vod.films();
  const out = { films: films.length, merge: [], loopOnly: [], genres: [] };
  for (let i = 0; i < 3; i++) {
    let t = performance.now();
    const merged = app.mergeFilms(films, app.titleMatcher.matchOf, []);
    out.merge.push(Math.round(performance.now() - t));
    t = performance.now();
    let n = 0;
    for (const f of films) if (app.titleMatcher.matchOf(f)) n++;
    out.loopOnly.push(Math.round(performance.now() - t));
    t = performance.now();
    const byGenre = new Map();
    for (const title of merged.titles)
      for (const g of title.genres) {
        let l = byGenre.get(g);
        if (!l) byGenre.set(g, (l = []));
        l.push(title);
      }
    const byCat = new Map();
    for (const title of merged.titles) {
      if (title.imdb || !title.category) continue;
      let l = byCat.get(title.category);
      if (!l) byCat.set(title.category, (l = []));
      l.push(title);
    }
    out.genres.push(Math.round(performance.now() - t));
    out.titles = merged.titles.length;
  }
  return out;
}
