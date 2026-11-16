// What an add-on's stream says about itself in its text (PLAN.md, "Stremio
// add-ons"): its picture's height, such as 2160 for 4K, and the file's size.
// Add-ons such as Torrentio put both in the name and description ("4k",
// "💾 1.81 GB") rather than in fields of their own.
//
// Adapted from NuvioTVSmart (https://github.com/NuvioMedia/NuvioTVSmart,
// GPL-3.0): js/core/debrid/streamResolution.js and
// js/core/debrid/streamTextSizeParser.js. Changed: rewritten in TypeScript,
// heights as numbers, and labels for the picker.

/** Each height with the words that mean it, highest first. */
const HEIGHTS: [number, RegExp][] = [
  [2160, /\b(2160p?|4k|uhd)\b/i],
  [1440, /\b(1440p?|2k)\b/i],
  [1080, /\b(1080p?|fhd)\b/i],
  [720, /\b(720p?|hd)\b/i],
  [576, /\b576p?\b/i],
  [480, /\b(480p?|sd)\b/i],
  [360, /\b360p?\b/i],
];

/** The picture's height a text names, if any. */
export const heightOfText = (text: string) => {
  for (const [height, words] of HEIGHTS) if (words.test(text)) return height;
  return undefined;
};

/**
 * The height from the first of `texts` that names one: the stream's name
 * before its description, so a 1080p file whose title mentions a 4K
 * remaster stays 1080p.
 */
export const heightOf = (texts: string[]) => {
  for (const text of texts) {
    const height = text ? heightOfText(text) : undefined;
    if (height !== undefined) return height;
  }
  return undefined;
};

const SIZE = /(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB)\b/i;
const UNITS: Record<string, number> = { TB: 1024 ** 4, GB: 1024 ** 3, MB: 1024 ** 2, KB: 1024 };

/** The size a text gives, in bytes, such as "1.81 GB". */
export const sizeOfText = (text: string) => {
  const match = SIZE.exec(text);
  if (!match) return undefined;
  const amount = Number((match[1] ?? "").replace(/,/g, "."));
  const unit = UNITS[(match[2] ?? "").toUpperCase()];
  if (!Number.isFinite(amount) || !unit) return undefined;
  const bytes = Math.floor(amount * unit);
  return bytes > 0 ? bytes : undefined;
};

/** The size from the first of `texts` that gives one: the description before the name. */
export const sizeOf = (texts: string[]) => {
  for (const text of texts) {
    const size = text ? sizeOfText(text) : undefined;
    if (size !== undefined) return size;
  }
  return undefined;
};

/** "4K", "1080p", or undefined for no height. */
export const heightLabel = (height: number | undefined) =>
  height === undefined ? undefined : height >= 2160 ? "4K" : `${height}p`;

/** "4K  ~2.1 GB": a source's file, whose size is worked out from its bitrate. */
export const qualityLabel = (quality: { height?: number; estimatedBytes?: number }, gap = "  ") =>
  [
    heightLabel(quality.height),
    quality.estimatedBytes === undefined ? undefined : `~${sizeLabel(quality.estimatedBytes)}`,
  ]
    .filter(Boolean)
    .join(gap);

/** "1.8 GB", "700 MB". */
export const sizeLabel = (bytes: number | undefined) => {
  if (bytes === undefined) return undefined;
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
};
