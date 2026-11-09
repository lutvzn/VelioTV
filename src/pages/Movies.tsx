import { useNavigate } from "@solidjs/router";
import type { ElementNode } from "@solidtv/solid";
import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js";
import type { FilmEntry } from "../data/vodLibrary";
import { exposeToProbes } from "../devHooks";
import { vod, watched } from "../library";
import { watchVod } from "../play/start";
import { filmPlay } from "../play/vodPlay";
import { duration } from "../live/format";
import { $t } from "../translate";
import { FilmPanel } from "./vod/FilmPanel";
import { type HubPlace, VodHub } from "./vod/VodHub";

// Movies (PLAN.md, Phase 6, step 4): every source's films in rows of
// posters, by category, with Continue watching first (src/pages/vod/VodHub.tsx). OK opens a film's page, and Play
// there watches it full screen (src/pages/Play.tsx); Back from the film
// comes back to its page here.

// Where the page was, and the film open, for coming back from watching.
let place: HubPlace | undefined;
let reopen: string | undefined;

export default () => {
  const navigate = useNavigate();
  let grid: ElementNode | undefined;
  const [open, setOpen] = createSignal<FilmEntry>();
  const back = reopen !== undefined;

  const progress = createMemo(() => {
    const found = new Map<string, number>();
    for (const entry of watched.unfinishedFilms()) {
      if (entry.durationMs > 0) found.set(entry.key, Math.min(1, entry.positionMs / entry.durationMs));
    }
    return found;
  });
  const items = createMemo(() =>
    vod.films().map(film => {
      const part = progress().get(film.key);
      return part === undefined ? film : { ...film, progress: part };
    }),
  );
  const continueItems = createMemo(() =>
    watched
      .unfinishedFilms()
      .map(entry => items().find(film => film.key === entry.key))
      .filter((film): film is FilmEntry => film !== undefined),
  );

  // Back from watching: the film's page again, once its source is read.
  createEffect(() => {
    if (reopen === undefined) return;
    const film = vod.findFilm(reopen);
    if (film) {
      setOpen(film);
      reopen = undefined;
    } else if (!vod.loading() && vod.films().length > 0) reopen = undefined;
  });
  onMount(() => {
    if (back) grid?.setFocus();
  });

  const close = () => {
    setOpen(undefined);
    grid?.setFocus();
  };
  const play = (film: FilmEntry, startMs?: number) => {
    reopen = film.key;
    watchVod(navigate, filmPlay(film, startMs || undefined));
  };
  exposeToProbes("moviesPage", { open, items, continueItems, play });

  return (
    <>
      <VodHub
        ref={element => (grid = element)}
        probeName="moviesGrid"
        title={$t("menu.movies")}
        allLabel={$t("vod.allFilms")}
        items={items()}
        continueItems={continueItems()}
        categories={vod.filmCategories()}
        loading={vod.loading()}
        emptyText={$t("vod.noFilms")}
        place={place}
        onPlace={next => (place = next)}
        covered={open() !== undefined}
        onOpen={film => setOpen(film)}
        details={film =>
          vod.filmDetails(film).then(info => ({
            backdrop: info.backdrop,
            plot: info.plot,
            facts: [
              info.genre ?? film.category,
              info.durationMs ? duration(info.durationMs) : undefined,
            ].filter((fact): fact is string => Boolean(fact)),
          }))
        }
      />
      <Show when={open()}>
        {film => <FilmPanel film={film()} onClose={close} onPlay={startMs => play(film(), startMs)} />}
      </Show>
    </>
  );
};
