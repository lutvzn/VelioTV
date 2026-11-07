import { useNavigate } from "@solidjs/router";
import type { ElementNode } from "@solidtv/solid";
import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js";
import type { SeriesEntry } from "../data/vodLibrary";
import { exposeToProbes } from "../devHooks";
import { vod, watched } from "../library";
import { watchVod } from "../play/start";
import { episodePlay } from "../play/vodPlay";
import { $t } from "../translate";
import { type GridPlace, PosterGrid } from "./vod/PosterGrid";
import { SeriesPanel } from "./vod/SeriesPanel";

// Series (PLAN.md, Phase 6, step 4): every source's series as posters, by
// category, with the ones being watched first. OK opens a series' page, on
// the episode to carry on with; OK there plays it, and the episodes after
// it follow on.

let place: GridPlace | undefined;
let reopen: string | undefined;

export default () => {
  const navigate = useNavigate();
  let grid: ElementNode | undefined;
  const [open, setOpen] = createSignal<SeriesEntry>();
  const back = reopen !== undefined;

  const continueItems = createMemo(() =>
    watched
      .latestEpisodes()
      .map(entry => (entry.series ? vod.findSeries(entry.series) : undefined))
      .filter((show): show is SeriesEntry => show !== undefined),
  );

  createEffect(() => {
    if (reopen === undefined) return;
    const show = vod.findSeries(reopen);
    if (show) {
      setOpen(show);
      reopen = undefined;
    } else if (!vod.loading() && vod.series().length > 0) reopen = undefined;
  });
  onMount(() => {
    if (back) grid?.setFocus();
  });

  const close = () => {
    setOpen(undefined);
    grid?.setFocus();
  };
  exposeToProbes("seriesPage", { open, continueItems });

  return (
    <>
      <PosterGrid
        ref={element => (grid = element)}
        probeName="seriesGrid"
        title={$t("menu.series")}
        allLabel={$t("vod.allSeries")}
        items={vod.series()}
        continueItems={continueItems()}
        categories={vod.seriesCategories()}
        loading={vod.loading()}
        emptyText={$t("vod.noSeries")}
        place={place}
        onPlace={next => (place = next)}
        covered={open() !== undefined}
        onOpen={show => setOpen(show)}
      />
      <Show when={open()}>
        {show => (
          <SeriesPanel
            show={show()}
            onClose={close}
            onPlay={(details, episode, startMs) => {
              reopen = show().key;
              watchVod(navigate, episodePlay(show(), details, episode, startMs));
            }}
          />
        )}
      </Show>
    </>
  );
};
