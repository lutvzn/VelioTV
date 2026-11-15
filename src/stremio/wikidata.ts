// TMDB ids as IMDb ids, from Wikidata (PLAN.md, "Movies and Series by
// title"): Playlist providers give a title's TMDB id, which Cinemeta doesn't
// search by, and Wikidata keeps both for most films and series. Ids asked
// for within a moment go in one query, one query at a time.

export const WIKIDATA_URL = "https://query.wikidata.org/sparql";

export type WikidataType = "movie" | "series";

/** TMDB's film id and TMDB's TV id, on Wikidata. */
const PROPERTY: Record<WikidataType, string> = { movie: "P4947", series: "P4983" };
const IMDB = "P345";

export interface WikidataOptions {
  /** The SPARQL endpoint's address. */
  url?: () => string;
  fetch?: typeof fetch;
  /** How long to gather ids before asking. */
  waitMs?: number;
  /** Ids in one query. */
  most?: number;
}

interface Waiting {
  resolve: (imdb: string | undefined) => void;
  reject: (error: unknown) => void;
}

export const wikidataQuery = (type: WikidataType, ids: readonly number[]) =>
  `SELECT ?tmdb ?imdb WHERE { VALUES ?tmdb { ${ids.map(id => `"${id}"`).join(" ")} } ` +
  `?item wdt:${PROPERTY[type]} ?tmdb; wdt:${IMDB} ?imdb. }`;

/** The IMDb id for each TMDB id in a SPARQL answer; the first, if Wikidata has several. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
/** A SPARQL binding's value. */
const valueOf = (row: Record<string, unknown>, name: string) => {
  const cell = row[name];
  return isObject(cell) ? cell.value : undefined;
};

export const readWikidata = (value: unknown) => {
  const found = new Map<number, string>();
  const results = isObject(value) ? value.results : undefined;
  const bindings: unknown = isObject(results) ? results.bindings : undefined;
  if (!Array.isArray(bindings)) return found;
  for (const row of bindings as unknown[]) {
    if (!isObject(row)) continue;
    const tmdb = Number(valueOf(row, "tmdb"));
    const imdb = valueOf(row, "imdb");
    if (typeof imdb !== "string" || !/^tt\d+$/.test(imdb) || !Number.isInteger(tmdb)) continue;
    if (!found.has(tmdb)) found.set(tmdb, imdb);
  }
  return found;
};

export const createWikidata = (options: WikidataOptions = {}) => {
  const url = options.url ?? (() => WIKIDATA_URL);
  const fetcher = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const waitMs = options.waitMs ?? 1000;
  const most = options.most ?? 200;
  const known = new Map<string, Promise<string | undefined>>();
  const waiting: Record<WikidataType, Map<number, Waiting>> = { movie: new Map(), series: new Map() };
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The query being asked; the next waits for it. */
  let asking: Promise<void> = Promise.resolve();

  const ask = async (type: WikidataType, ids: Map<number, Waiting>) => {
    try {
      // `format`, not an Accept header, so the browser needs no preflight.
      const query = encodeURIComponent(wikidataQuery(type, [...ids.keys()]));
      const response = await fetcher(`${url()}?format=json&query=${query}`);
      if (!response.ok) throw new Error(`Wikidata answered HTTP ${response.status}`);
      const found = readWikidata(await response.json());
      for (const [id, one] of ids) one.resolve(found.get(id));
    } catch (error) {
      for (const one of ids.values()) one.reject(error);
    }
  };
  const send = (type: WikidataType) => {
    const all = waiting[type];
    while (all.size > 0) {
      const ids = new Map<number, Waiting>();
      for (const [id, one] of all) {
        if (ids.size >= most) break;
        ids.set(id, one);
      }
      for (const id of ids.keys()) all.delete(id);
      asking = asking.then(() => ask(type, ids));
    }
  };
  const sendAll = () => {
    timer = undefined;
    send("movie");
    send("series");
  };

  return {
    /** The IMDb id for a TMDB id, or undefined when Wikidata has none. Rejects when it can't be asked. */
    imdbOf: (type: WikidataType, tmdb: number): Promise<string | undefined> => {
      const key = `${url()}\u0000${type}:${tmdb}`;
      let found = known.get(key);
      if (found) return found;
      found = new Promise<string | undefined>((resolve, reject) => {
        waiting[type].set(tmdb, { resolve, reject });
      });
      known.set(key, found);
      // Asked again next time.
      found.catch(() => known.delete(key));
      if (waiting[type].size >= most) send(type);
      else timer ??= setTimeout(sendAll, waitMs);
      return found;
    },
  };
};

export type Wikidata = ReturnType<typeof createWikidata>;
