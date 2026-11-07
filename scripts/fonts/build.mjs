#!/usr/bin/env node
// Builds the app's text atlases from Noto Sans. The renderer draws only SDF
// text, from one atlas image per font, and a character missing from the
// atlas shows as a space; Roboto's atlas had only 98 characters (PLAN.md,
// Phase 2, step 5). Channel and programme names come in many languages, so
// these atlases hold every character Noto Sans has in the blocks below:
// Latin with its extensions, Greek and Cyrillic, the small capitals and
// superscripts some providers use ("ᴴᴰ", "⁴ᴷ"), punctuation and common
// symbols. Scripts written right to left or needing shaping (Arabic, Hebrew,
// Indic) and CJK, which would need thousands of glyphs, are left out.
//
//   cd scripts/fonts && pnpm install --ignore-workspace && pnpm build
//
// It has its own package.json, so its image tools stay out of the app's
// dependencies: they bring Node's types, which clash with the browser's.
// It writes public/fonts/NotoSans-<weight>.msdf.{json,png}: 1,630 characters
// each, on a 2048x1024 atlas (8 MB of texture memory). It takes about 30 s,
// inside the tv-dev box. The sources are Noto Sans 2.007, under the SIL Open
// Font License 1.1 (see NOTICE).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import generateBMFont from "msdf-bmfont-xml";
import { parse } from "opentype.js";

const here = import.meta.dirname;
const out = path.resolve(here, "../../public/fonts");
const FONTS = ["NotoSans-Regular", "NotoSans-Bold"];

// Unicode blocks, as [first, last] code points. Noto Sans has nothing in the
// symbol blocks (no stars, dots or ticks) beyond "•" in General Punctuation.
const BLOCKS = [
  [0x0020, 0x007e], // Basic Latin
  [0x00a0, 0x00ff], // Latin-1 Supplement
  [0x0100, 0x017f], // Latin Extended-A
  [0x0180, 0x024f], // Latin Extended-B
  [0x02b0, 0x02ff], // Spacing Modifier Letters
  [0x0370, 0x03ff], // Greek (modern; polytonic Greek is left out)
  [0x0400, 0x04ff], // Cyrillic
  [0x1d00, 0x1d6a], // Phonetic Extensions: small capitals and modifier letters
  [0x1e00, 0x1eff], // Latin Extended Additional (Vietnamese)
  [0x2000, 0x206f], // General Punctuation
  [0x2070, 0x209f], // Superscripts and Subscripts
  [0x20a0, 0x20c0], // Currency Symbols
  [0x2100, 0x214f], // Letterlike Symbols
  [0x2150, 0x218f], // Number Forms
];

// Kerning is kept between letters below this, Latin to Cyrillic: the pairs
// for every character made the description 1.4 MB.
const KERNING_BELOW = 0x0500;

const generate = (fontPath, options) =>
  new Promise((resolve, reject) =>
    generateBMFont(fontPath, options, (error, textures, font) =>
      error ? reject(error) : resolve({ textures, font }),
    ),
  );

for (const name of FONTS) {
  const source = path.join(here, `${name}.ttf`);
  const font = parse(readFileSync(source).buffer);
  const charset = [];
  for (const [first, last] of BLOCKS) {
    for (let code = first; code <= last; code++) {
      const char = String.fromCodePoint(code);
      // Only characters the font draws; spaces have no outline but do count.
      if (font.charToGlyphIndex(char) > 0) charset.push(char);
    }
  }

  const filename = `${name}.msdf`;
  const { textures, font: data } = await generate(source, {
    outputType: "json",
    filename: path.join(out, filename),
    fieldType: "msdf",
    fontSize: 42,
    distanceRange: 4,
    textureSize: [2048, 1024],
    smartSize: true,
    pot: true,
    charset,
  });
  if (textures.length !== 1) {
    throw new Error(`${name} needs ${textures.length} atlas pages of 2048x1024; the renderer reads one`);
  }

  // The renderer's line metrics, in font units, as Lightning's msdf-generator
  // writes them (Roboto's came from the same OS/2 fields).
  const os2 = font.tables.os2;
  const json = JSON.parse(data.data);
  json.lightningMetrics = {
    ascender: os2.sTypoAscender,
    descender: os2.sTypoDescender,
    lineGap: os2.sTypoLineGap,
    unitsPerEm: font.unitsPerEm,
  };
  // The charset is listed in the glyphs already.
  delete json.info.charset;
  json.kernings = json.kernings.filter(pair => pair.first < KERNING_BELOW && pair.second < KERNING_BELOW);
  writeFileSync(path.join(out, `${filename}.json`), JSON.stringify(json));
  writeFileSync(path.join(out, `${filename}.png`), textures[0].texture);
  console.log(
    `${name}: ${json.chars.length} characters, ${json.kernings.length} kerning pairs, ` +
      `atlas ${json.common.scaleW}x${json.common.scaleH}`,
  );
}
