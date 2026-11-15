import { useNavigate } from "@solidjs/router";
import type { ElementNode } from "@solidtv/solid";
import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js";
import { createFilmMerger, mergeFilms, type TitleFilm } from "../../data/titles";
import type { FilmEntry } from "../../data/vodLibrary";
import { exposeToProbes } from "../../devHooks";
import { addons, vod, watched } from "../../library";
import { duration } from "../../live/format";
import { watchVod } from "../../play/start";
import { titleFilmPlay, type TitleChoice } from "../../play/titlePlay";
import { filmKey, keptFilm } from "../../stremio/vodEntries";
import { $t, $tn, language } from "../../translate";
import { FilmPanel } from "./FilmPanel";
import { orderLinks } from "./linkOrder";
import { linkRow, useModernTitles } from "./modernTitles";
import { StreamPicker } from "./StreamPicker";
import { type HubPlace, VodHub } from "./VodHub";

// Movies, modern (PLAN.md, "Movies and Series by title"): each film once,
// however many sources and add-ons have it, by Cinemeta's genres
// (src/pages/vod/modernTitles.ts). Play on a film with one link plays it;
// with more, the picker lists the sources' copies, then the add-ons'
// streams.

let place: HubPlace | undefined;
/** The film open when it was played, to open again on coming back. */
let reopen: TitleFilm | undefined;

const asTitle = (film: FilmEntry): TitleFilm => ({ ...film, links: [], genres: [] });

export const ModernMovies = () => {
  const navigate = useNavigate();
  let grid: ElementNode | undefined;
  const [open, setOpen] = createSignal<TitleFilm>();
  const back = reopen !== undefined;
  const [picking, setPicking] = createSignal<{ title: TitleFilm; id?: string; startMs?: number }>();

  const progress = createMemo(() => {
    const found = new Map<string, number>();
    for (const entry of watched.unfinishedFilms()) {
      if (entry.durationMs > 0) found.set(entry.key, Math.min(1, entry.positionMs / entry.durationMs));
    }
    return found;
  });
  const modern = useModernTitles<FilmEntry, TitleFilm>({
    type: "movie",
    entries: vod.films,
    categories: vod.filmCategories,
    merge: mergeFilms,
    createMerger: createFilmMerger,
    keyOf: filmKey,
    progress,
  });
  const items = () => modern.titles().titles;
  const continueItems = createMemo(() => {
    const { byKey } = modern.titles();
    const seen = new Set<TitleFilm>();
    for (const entry of watched.unfinishedFilms()) {
      const found = byKey.get(entry.key);
      const kept = found ? undefined : keptFilm(entry);
      const title = found ?? (kept && asTitle(kept));
      if (title) seen.add(title);
    }
    return [...seen];
  });

  createEffect(() => {
    if (!reopen) return;
    setOpen(reopen);
    reopen = undefined;
  });
  onMount(() => {
    if (back) grid?.setFocus();
  });

  const close = () => {
    setOpen(undefined);
    grid?.setFocus();
  };
  const watch = (title: TitleFilm, choice: TitleChoice<FilmEntry>, startMs?: number) => {
    setPicking(undefined);
    reopen = title;
    watchVod(navigate, titleFilmPlay(title, choice, startMs));
  };
  const play = (title: TitleFilm, startMs?: number) => {
    const id = title.stremio?.id;
    const streams = id !== undefined && addons.answers("stream", "movie", id);
    const [only] = title.links;
    if (title.links.length === 1 && only && !streams) {
      watch(title, { kind: "source", link: only }, startMs);
      return;
    }
    setPicking({ title, id: streams ? id : undefined, startMs: startMs || undefined });
  };
  exposeToProbes("moviesPage", { open, items, continueItems, play, picking, titles: modern.titles });

  return (
    <>
      <VodHub
        ref={element => (grid = element)}
        probeName="moviesGrid"
        sortPage="movies"
        defaultSort="added"
        alsoNamed={title => title.links.map(link => link.name)}
        currentKey={key => modern.titles().byKey.get(key)?.key}
        title={$t("menu.movies")}
        allLabel={$t("vod.allFilms")}
        items={items()}
        continueItems={continueItems()}
        categories={[]}
        loading={vod.loading()}
        emptyText={$t("vod.noFilms")}
        searchLabel={$t("vod.searchFilms")}
        extraGroups={modern.groups()}
        onNearEnd={modern.onNearEnd}
        searchItems={modern.searchItems()}
        searching={modern.searching()}
        onQuery={modern.onQuery}
        place={place}
        startInGrid={back}
        onPlace={next => (place = next)}
        covered={open() !== undefined}
        onOpen={title => setOpen(title)}
        details={title =>
          vod.filmDetails(title).then(info => ({
            backdrop: info.backdrop,
            plot: info.plot,
            facts: [
              title.genres.length ? title.genres.slice(0, 3).join(", ") : (info.genre ?? title.category),
              info.durationMs ? duration(info.durationMs) : undefined,
              title.links.length > 1 ? $tn("vod.sources", title.links.length) : undefined,
            ].filter((fact): fact is string => Boolean(fact)),
          }))
        }
      />
      <Show when={open()}>
        {title => <FilmPanel film={title()} onClose={close} onPlay={startMs => play(title(), startMs)} />}
      </Show>
      <Show when={picking()} keyed>
        {asked => (
          <StreamPicker<FilmEntry>
            title={asked.title.name}
            type="movie"
            id={asked.id}
            links={orderLinks(asked.title.links, link => link, language()).map(link =>
              linkRow(link, link.source, link.name, link.url, link.category),
            )}
            onClose={() => setPicking(undefined)}
            onPick={choice => watch(asked.title, choice, asked.startMs)}
          />
        )}
      </Show>
    </>
  );
};
