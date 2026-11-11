import { useNavigate } from "@solidjs/router";
import type { ElementNode } from "@solidtv/solid";
import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js";
import { createSeriesMerger, mergeEpisodes, mergeSeries, type TitleSeries } from "../../data/titles";
import type { Episode, EpisodeLink, SeriesDetails } from "../../data/vod";
import type { SeriesEntry } from "../../data/vodLibrary";
import { exposeToProbes } from "../../devHooks";
import { addons, vod, watched } from "../../library";
import { watchVod } from "../../play/start";
import { titleEpisodePlay, type TitleChoice } from "../../play/titlePlay";
import { episodeLabel } from "../../play/vodPlay";
import { keptSeries, seriesKey } from "../../stremio/vodEntries";
import { $t, $tn, language } from "../../translate";
import { orderLinks } from "./linkOrder";
import { linkRow, useModernTitles } from "./modernTitles";
import { SeriesPanel } from "./SeriesPanel";
import { StreamPicker } from "./StreamPicker";
import { type HubPlace, VodHub } from "./VodHub";

// Series, modern (PLAN.md, "Movies and Series by title"): each series once,
// by Cinemeta's genres, with every source's episodes joined by season and
// number (mergeEpisodes). An episode with one link plays it; with more, the
// picker lists the sources' copies, then the add-ons' streams.

let place: HubPlace | undefined;
let reopen: TitleSeries | undefined;

interface Picking {
  title: TitleSeries;
  details: SeriesDetails;
  episode: Episode;
  id?: string;
  startMs?: number;
}

const asTitle = (show: SeriesEntry): TitleSeries => ({ ...show, links: [], genres: [] });

const none = (): SeriesDetails => ({ seasons: [] });

/** A title's episodes: Cinemeta's or an add-on's, with each source's copy joined. */
const detailsOf = async (title: TitleSeries): Promise<SeriesDetails> => {
  const [base, copies] = await Promise.all([
    title.stremio ? vod.seriesDetails(title).catch(() => undefined) : Promise.resolve(undefined),
    Promise.all(
      title.links.map(async show => ({ show, details: await vod.seriesDetails(show).catch(none) })),
    ),
  ]);
  return mergeEpisodes(base, copies);
};

export const ModernSeries = () => {
  const navigate = useNavigate();
  let grid: ElementNode | undefined;
  const [open, setOpen] = createSignal<TitleSeries>();
  const back = reopen !== undefined;
  const [picking, setPicking] = createSignal<Picking>();

  const modern = useModernTitles<SeriesEntry, TitleSeries>({
    type: "series",
    entries: vod.series,
    categories: vod.seriesCategories,
    merge: mergeSeries,
    createMerger: createSeriesMerger,
    keyOf: seriesKey,
  });
  const items = () => modern.titles().titles;
  const continueItems = createMemo(() => {
    const { byKey } = modern.titles();
    const seen = new Set<TitleSeries>();
    for (const entry of watched.latestEpisodes()) {
      if (!entry.series) continue;
      const found = byKey.get(entry.series);
      const kept = found ? undefined : keptSeries(entry);
      const title = found ?? (kept && asTitle(kept));
      if (title) seen.add(title);
    }
    return [...seen];
  });

  // Each title's joined episodes, while the page is open.
  const joined = new Map<string, Promise<SeriesDetails>>();
  const load = (show: SeriesEntry) => {
    const title = modern.titles().byKey.get(show.key) ?? asTitle(show);
    let found = joined.get(title.key);
    if (!found) {
      found = detailsOf(title);
      joined.set(title.key, found);
    }
    return found;
  };

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
  const watch = (asked: Picking, choice: TitleChoice<EpisodeLink>) => {
    setPicking(undefined);
    reopen = asked.title;
    watchVod(navigate, titleEpisodePlay(asked.title, asked.details, asked.episode, choice, asked.startMs));
  };
  const play = (title: TitleSeries, details: SeriesDetails, episode: Episode, startMs?: number) => {
    const id = episode.stremio;
    const streams = id !== undefined && addons.answers("stream", "series", id);
    const links = episode.links ?? [];
    const asked: Picking = {
      title,
      details,
      episode,
      id: streams ? id : undefined,
      startMs: startMs || undefined,
    };
    const [only] = links;
    if (links.length === 1 && only && !streams) {
      watch(asked, { kind: "iptv", link: only });
      return;
    }
    setPicking(asked);
  };
  exposeToProbes("seriesPage", { open, items, continueItems, picking, titles: modern.titles, load, play });

  return (
    <>
      <VodHub
        ref={element => (grid = element)}
        probeName="seriesGrid"
        sortPage="series"
        defaultSort="added"
        alsoNamed={title => title.links.map(link => link.name)}
        currentKey={key => modern.titles().byKey.get(key)?.key}
        title={$t("menu.series")}
        allLabel={$t("vod.allSeries")}
        items={items()}
        continueItems={continueItems()}
        categories={[]}
        loading={vod.loading()}
        emptyText={$t("vod.noSeries")}
        searchLabel={$t("vod.searchSeries")}
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
          load(title).then(info => ({
            backdrop: info.backdrop,
            plot: info.plot ?? title.plot,
            facts: [
              title.genres.length ? title.genres.slice(0, 3).join(", ") : (info.genre ?? title.category),
              info.seasons.length ? $tn("vod.seasons", info.seasons.length) : undefined,
              title.links.length > 1 ? $tn("vod.sources", title.links.length) : undefined,
            ].filter((fact): fact is string => Boolean(fact)),
          }))
        }
      />
      <Show when={open()}>
        {title => (
          <SeriesPanel
            show={title()}
            load={load}
            onClose={close}
            onPlay={(details, episode, startMs) => play(title(), details, episode, startMs)}
          />
        )}
      </Show>
      <Show when={picking()} keyed>
        {asked => (
          <StreamPicker<EpisodeLink>
            title={`${asked.title.name}  ${episodeLabel(asked.episode)}`}
            type="series"
            id={asked.id}
            links={orderLinks(asked.episode.links ?? [], link => link.show, language()).map(link =>
              linkRow(link, link.show.source, link.show.name, link.episode.url),
            )}
            onClose={() => setPicking(undefined)}
            onPick={choice => watch(asked, choice)}
          />
        )}
      </Show>
    </>
  );
};
