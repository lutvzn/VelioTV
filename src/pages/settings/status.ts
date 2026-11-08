// How a source's import is described in Settings and the side menu.

import { DAY } from "../../data/db";
import type { ImportProgress } from "../../data/importer";
import type { SourceStatus } from "../../data/sourceManager";
import { $t, $tn, formatCount, locale } from "../../translate";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const timeAgo = (time: number, now: number) => {
  const since = Math.max(0, now - time);
  if (since < MINUTE) return $t("time.justNow");
  if (since < HOUR) return $t("time.minutes", { count: Math.floor(since / MINUTE) });
  if (since < DAY) return $t("time.hours", { count: Math.floor(since / HOUR) });
  return $tn("time.days", Math.floor(since / DAY));
};

const shortDate = (time: number) =>
  new Date(time).toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short" });

/**
 * A failed import's error in the app's language, where it is one the app
 * knows; otherwise as the importer wrote it, which names the file.
 */
export const errorText = (error: string) => {
  const http = /HTTP (\d{3})/.exec(error);
  if (http) return $t("source.error.http", { status: http[1] });
  if (/Failed to fetch|NetworkError|Load failed/i.test(error)) return $t("source.error.network");
  if (error.includes("Xtream login failed")) return $t("source.error.login");
  const account = /Xtream account is (.+)$/.exec(error);
  if (account) return $t("source.error.account", { status: account[1] });
  if (error.includes("something other than JSON")) return $t("source.error.notJson");
  if (/empty response/.test(error)) return $t("source.error.empty");
  if (error.includes("no channel list")) return $t("source.error.noChannels");
  if (/QuotaExceeded|quota/i.test(error)) return $t("source.error.storage");
  return error;
};

/** How far an import has got, in a few words. */
export const progressSummary = (progress: ImportProgress | undefined) => {
  if (!progress) return $t("source.status.starting");
  const parts =
    progress.stage === "channels"
      ? [$t("source.status.channels", { channels: formatCount(progress.channels) })]
      : [$t("source.status.guide", { programmes: $tn("count.programmes", progress.programmes) })];
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
            channels: $tn("count.channels", state.channels),
            guideEnd: shortDate(state.guideLastDay * DAY),
          })
        : $t("source.status.noGuide", { channels: $tn("count.channels", state.channels) });
    if (state.guideTrimmed) holds += ` ${$t("source.status.trimmed")}`;
  }

  if (status.importing) return [progressSummary(status.progress), holds || updated];
  if (status.queued) return [$t("source.status.queued"), holds];
  if (!state) return [$t("source.status.never"), ""];

  let second = updated;
  if (state.status === "failed") second = $t("source.status.failed", { error: errorText(state.error ?? "") });
  else if (state.status === "importing") second = $t("source.status.interrupted");
  else if (state.account?.expiresAt) {
    second = [updated, $t("source.status.expires", { date: shortDate(state.account.expiresAt) })].join(", ");
  }
  return [holds || $t("source.status.never"), second];
};
