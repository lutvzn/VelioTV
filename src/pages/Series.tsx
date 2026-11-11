import { useNavigate } from "@solidjs/router";
import type { ElementNode } from "@solidtv/solid";
import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js";
import { ModernSeries } from "./vod/ModernSeries";
import type { SeriesEntry } from "../data/vodLibrary";
import { exposeToProbes } from "../devHooks";
import { vod, vodLayout, watched } from "../library";
import { watchVod } from "../play/start";
import { addonEpisodePlay } from "../play/addonPlay";
import { episodeLabel, episodePlay } from "../play/vodPlay";
import type { Episode, SeriesDetails } from "../data/vod";
import { addonSeries, keptSeries } from "../stremio/vodEntries";
import { $t, $tn } from "../translate";
import { type HubPlace, VodHub } from "./vod/VodHub";
import { useAddonGroups } from "./vod/addonGroups";
import { SeriesPanel } from "./vod/SeriesPanel";
import { StreamPicker } from "./vod/StreamPicker";

// Series (PLAN.md, Phase 6, step 4): every source's series by category, in
// a column of groups beside a grid of posters, with the ones being watched first
// (src/pages/vod/VodHub.tsx). OK opens a series' page, on the episode to
// carry on with; OK there plays it, and the episodes after it follow on.
//
// Add-ons' catalogs follow the categories (PLAN.md, "Stremio add-ons",
// step 4), and an episode of theirs first asks which stream.

let place: HubPlace | undefined;
let reopen: string | undefined;
/** An add-on's series to open again, which the sources can't find by its key. */
let reopenAddon: SeriesEntry | undefined;

interface Picking {
  show: SeriesEntry;
  details: SeriesDetails;
  episode: Episode;
  startMs?: number;
}

const Classic = () => {
  const navigate = useNavigate();
  let grid: ElementNode | undefined;
  const [open, setOpen] = createSignal<SeriesEntry>();
  const back = reopen !== undefined || reopenAddon !== undefined;
  const fromAddons = useAddonGroups("series", addonSeries);
  const [picking, setPicking] = createSignal<Picking>();

  const continueItems = createMemo(() =>
    watched
      .latestEpisodes()
      .map(entry => (entry.series ? (vod.findSeries(entry.series) ?? keptSeries(entry)) : undefined))
      .filter((show): show is SeriesEntry => show !== undefined),
  );

  createEffect(() => {
    if (reopenAddon) {
      setOpen(reopenAddon);
      reopenAddon = undefined;
      return;
    }
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
  exposeToProbes("seriesPage", { open, continueItems, picking });

  return (
    <>
      <VodHub
        ref={element => (grid = element)}
        probeName="seriesGrid"
        title={$t("menu.series")}
        allLabel={$t("vod.allSeries")}
        items={vod.series()}
        continueItems={continueItems()}
        categories={vod.seriesCategories()}
        loading={vod.loading()}
        emptyText={$t("vod.noSeries")}
        searchLabel={$t("vod.searchSeries")}
        extraGroups={fromAddons.extraGroups()}
        onNearEnd={fromAddons.onNearEnd}
        searchItems={fromAddons.searchItems()}
        searching={fromAddons.searching()}
        onQuery={fromAddons.onQuery}
        place={place}
        startInGrid={back}
        onPlace={next => (place = next)}
        covered={open() !== undefined}
        onOpen={show => setOpen(show)}
        details={show =>
          vod.seriesDetails(show).then(info => ({
            backdrop: info.backdrop,
            plot: info.plot ?? show.plot,
            facts: [
              info.genre ?? show.category,
              info.seasons.length ? $tn("vod.seasons", info.seasons.length) : undefined,
            ].filter((fact): fact is string => Boolean(fact)),
          }))
        }
      />
      <Show when={open()}>
        {show => (
          <SeriesPanel
            show={show()}
            onClose={close}
            onPlay={(details, episode, startMs) => {
              if (episode.stremio) {
                setPicking({ show: show(), details, episode, startMs });
                return;
              }
              reopen = show().key;
              watchVod(navigate, episodePlay(show(), details, episode, startMs));
            }}
          />
        )}
      </Show>
      <Show when={picking()} keyed>
        {asked => (
          <StreamPicker
            title={`${asked.show.name}  ${episodeLabel(asked.episode)}`}
            type="series"
            id={asked.episode.stremio ?? ""}
            onClose={() => setPicking(undefined)}
            onPick={choice => {
              if (choice.kind !== "addon") return;
              const { chosen } = choice;
              setPicking(undefined);
              reopenAddon = asked.show;
              watchVod(
                navigate,
                addonEpisodePlay(asked.show, asked.details, asked.episode, chosen, asked.startMs),
              );
            }}
          />
        )}
      </Show>
    </>
  );
};

/** The modern layout, unless the profile chose the classic one (src/data/vodLayout.ts). */
export default () => (
  <Show when={vodLayout.modern()} fallback={<Classic />}>
    <ModernSeries />
  </Show>
);
