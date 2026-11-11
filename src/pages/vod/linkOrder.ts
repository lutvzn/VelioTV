// The order a title's IPTV copies are offered in to play (PLAN.md, "Movies
// and Series by title", step 5): those in the app's language first, by the
// provider's tag ("PT - ", "|BR|") on the name or its category, then those
// with no tag, then the rest; and within those the best quality first, as
// the name or category says ("4K", "FHD", "SD"). Copies alike keep their
// sources' order.

import { tagLanguage } from "../../stremio/cinemeta";

export interface LinkText {
  name: string;
  category?: string;
}

const UHD = /(?:^|[^a-z0-9])(?:4k|uhd|2160p)(?:[^a-z0-9]|$)/i;
const FHD = /(?:^|[^a-z0-9])(?:fhd|1080p)(?:[^a-z0-9]|$)/i;
const SD = /(?:^|[^a-z0-9])(?:sd|480p|360p)(?:[^a-z0-9]|$)/i;

/** 0 for 4K, 1 for full HD, 2 for HD or not said, 3 for SD. */
export const qualityRank = (text: string) => {
  if (UHD.test(text)) return 0;
  if (FHD.test(text)) return 1;
  return SD.test(text) ? 3 : 2;
};

const base = (language: string) => language.split("-")[0].toLowerCase();

/** 0 in the app's language, 1 with no language tag, 2 in another. */
export const languageRank = (link: LinkText, language: string) => {
  const tagged = tagLanguage(link.name) ?? tagLanguage(link.category);
  if (tagged === undefined) return 1;
  return base(tagged) === base(language) ? 0 : 2;
};

/** The links, in a new list, in the order above. */
export const orderLinks = <L>(links: readonly L[], textOf: (link: L) => LinkText, language: string): L[] => {
  if (links.length < 2) return links.slice();
  const ranks = links.map(link => {
    const text = textOf(link);
    return languageRank(text, language) * 4 + qualityRank(`${text.name} ${text.category ?? ""}`);
  });
  const order = links.map((_, i) => i);
  // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array; older TVs lack toSorted()
  order.sort((a, b) => ranks[a] - ranks[b] || a - b);
  return order.map(i => links[i]);
};
