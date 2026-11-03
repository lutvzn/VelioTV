// How a source's import is described in Settings and the side menu.

import { DAY } from "../../data/db";
import type { ImportProgress } from "../../data/importer";
import type { SourceStatus } from "../../data/sourceManager";
import { $t, locale } from "../../translate";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const count = (n: number) => n.toLocaleString(locale());

export const timeAgo = (time: number, now: number) => {
  const since = Math.max(0, now - time);
  if (since < MINUTE) return $t("time.justNow");
  if (since < HOUR) return $t("time.minutes", { count: Math.floor(since / MINUTE) });
  if (since < DAY) return $t("time.hours", { count: Math.floor(since / HOUR) });
  return $t("time.days", { count: Math.floor(since / DAY) });
};

const shortDate = (time: number) =>
  new Date(time).toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short" });

/** How far an import has got, in a few words. */
export const progressSummary = (progress: ImportProgress | undefined) => {
  if (!progress) return $t("source.status.starting");
  const parts =
    progress.stage === "channels"
      ? [$t("source.status.channels", { channels: count(progress.channels) })]
      : [$t("source.status.guide", { programmes: count(progress.programmes) })];
  if (progress.totalBytes) {
    const percent = Math.min(99, Math.floor((progress.bytes / progress.totalBytes) * 100));
    parts.push($t("source.status.percent", { percent }));
  } else if (progress.bytes > 0) {
    parts.push($t("source.status.downloaded", { mb: (progress.bytes / 1_048_576).toFixed(1) }));
  }
  return parts.join(", ");
};

/** The share of the current download done, when the server says how big it is. */
export const progressFraction = (progress: ImportProgress | undefined) =>
  progress?.totalBytes ? Math.min(1, progress.bytes / progress.totalBytes) : undefined;

/** Two lines about a source: what it holds, then when it was updated. */
export const statusLines = (status: SourceStatus, now: number): [string, string] => {
  const { state } = status;
  const updated = state?.lastDoneAt
    ? $t("source.status.updated", { ago: timeAgo(state.lastDoneAt, now) })
    : "";

  let holds = "";
  if (state?.lastDoneAt) {
    holds =
      state.programmes > 0
        ? $t("source.status.done", {
            channels: count(state.channels),
            guideEnd: shortDate(state.guideLastDay * DAY),
          })
        : $t("source.status.noGuide", { channels: count(state.channels) });
    if (state.guideTrimmed) holds += ` ${$t("source.status.trimmed")}`;
  }

  if (status.importing) return [progressSummary(status.progress), holds || updated];
  if (status.queued) return [$t("source.status.queued"), holds];
  if (!state) return [$t("source.status.never"), ""];

  let second = updated;
  if (state.status === "failed") second = $t("source.status.failed", { error: state.error ?? "" });
  else if (state.status === "importing") second = $t("source.status.interrupted");
  else if (state.account?.expiresAt) {
    second = [updated, $t("source.status.expires", { date: shortDate(state.account.expiresAt) })].join(", ");
  }
  return [holds || $t("source.status.never"), second];
};
