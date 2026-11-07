// The app's text atlases, built from Noto Sans by scripts/fonts/build.mjs.
// Bold text asks for "<family>700".
export default [
  {
    type: "msdf",
    fontFamily: "NotoSans",
    atlasDataUrl: "fonts/NotoSans-Regular.msdf.json",
    atlasUrl: "fonts/NotoSans-Regular.msdf.png",
  } as const,
  {
    type: "msdf",
    fontFamily: "NotoSans700",
    atlasDataUrl: "fonts/NotoSans-Bold.msdf.json",
    atlasUrl: "fonts/NotoSans-Bold.msdf.png",
  } as const,
];
