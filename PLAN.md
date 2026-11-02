# IPTV player plan: Tizen and webOS with SolidTV

**The UI and most TiviMate features are achievable, but full parity isn't likely in a TV web app.** Recording, multi-view and pause-live depend on platform limits, so test those on real TVs before building the UI around them.

Rough estimate: 4–5 months for one full-time developer.

**Samsung comes first.** LG webOS support is the last phase, because no LG TV is available yet. Until then, LG items in this plan are kept for reference only.

## Feature parity

TiviMate's site returned only its title, so this list comes from third-party guides and prior knowledge. Check it against the real app before treating it as final.

| Feature                                                       | Outlook              | Limit or approach                                                                                                            |
| ------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| M3U, Xtream and Stalker sources                               | Yes                  | Samsung doesn't enforce CORS for the packaged app (tested); LG is unconfirmed                                                |
| TV guide, XMLTV, channel/group management, favourites, search | Yes                  | Performance on the TV is the main challenge                                                                                  |
| Movies, series, resume, catch-up                              | Yes                  | Catch-up depends on the provider                                                                                             |
| Parental PIN, themes, backup/restore                          | Yes                  | Restore via QR code or a file on a URL                                                                                       |
| Audio and subtitle track selection                            | Mostly               | Samsung has an API for this; webOS needs testing                                                                             |
| Reminders                                                     | Partial              | Only while the app is open                                                                                                   |
| Pause and rewind live TV                                      | Partial              | Limited to the provider's DVR window or catch-up; no Samsung time-shift API turned up                                        |
| Fast-forward and rewind speeds                                | Partial              | LG lists speeds other than 1.0 as not supported                                                                              |
| Multi-view                                                    | 2 streams on Samsung | Tested: a main stream plus one picture-in-picture via `IN_APP_MULTIVIEW`; a third stops the second. LG is unknown            |
| Local recording                                               | Samsung only, maybe  | Samsung has USB write APIs, but large-file behaviour is unconfirmed; LG says web apps can't access files a service downloads |
| Recording with the app closed                                 | No, without a server | Needs a small self-hosted recorder                                                                                           |
| Auto frame rate, autostart, system-wide picture-in-picture    | Probably not         | Not checked against vendor docs; confirm during Phase 0                                                                      |

## Key decisions

- **Target TVs:** support 2020 and newer (Tizen 5.5+, then webOS 5+ in the LG phase), subject to Phase 0 results. That means dropping the starter's `Chrome >= 49` target.
- **Playback:** put one `PlaybackEngine` interface over three backends. Only AVPlay is built before the LG phase, but keep the interface general enough for the LG ones:
  - **Samsung live and VOD:** AVPlay
  - **LG:** native `<video>` for HLS and HTTP
  - **LG raw MPEG-TS:** `mpegts.js` as the fallback, because LG doesn't list TS over HTTP as a supported protocol
- **Shaka:** keep it only for DASH or VOD that the native players can't handle, as it isn't the right main engine for raw TS live streams.
- **Data:** parse playlists and XMLTV in a Web Worker, and store them in IndexedDB rather than in memory.
- **TV guide:** build a custom time-based grid, because programme cells vary in width. `VirtualGrid` is still useful as a reference.
- **Recording:** leave it out of v1, then add an optional self-hosted recorder so both platforms behave the same.
- **Distribution:** sideload first. The app ships with no channels or content, and uses its own name and design rather than TiviMate's. "TiviPlayer" is close to that name, so choose another before any store submission.

## Fix these starter problems first

All but the git repo are fixed and tested on the Samsung TV.

- **Device builds:** fixed. `vite.config.js` points the `#device` import at `devices/<TARGET_DEVICE>`, and `src/device.ts` loads it and starts the device setup.
- **Asset paths:** fixed. `devices/deviceConfigPlugin.ts` now uses `./` instead of an absolute base such as `/tizen/`.
- **Packaging:** Tizen is done: `devices/tizen/config.xml` and `scripts/deploy-tizen.sh <tv-ip>`, which builds, signs, installs and starts the app. It worked on the Samsung TV on 2026-11-02. The webOS `appinfo.json` comes in the LG phase.
- **Number keys:** fixed on Tizen, which maps them to 48–57 and registers the media and number keys at startup. Back leaves the app from the home page. LG still has `-1`, to fix in Phase 9.
- **Player:** fixed in `devices/common/player.ts`. The `<video>` element sits behind the UI's canvas, `seek()` jumps to a position and a new `skip()` moves relative to it, and `stop()` reuses the Shaka player instead of leaking it.
- **Repo setup:** it isn't a git repo yet. The npm lockfile is gone, so pnpm is the only package manager.
- **Tooling:** done. Oxc does formatting (`oxfmt`, replacing Prettier) and linting (`oxlint` with type-aware rules). `pnpm check` runs format, lint, type check and tests, and `.forgejo/workflows/ci.yml` runs it plus a Samsung build on Forgejo.
- **App shell:** done. A side menu (`src/components/SideMenu.tsx`) opens placeholder pages for Live TV, TV Guide, Movies, Series and Settings.

## Phases

| #   | Phase                | Main work                                                                                                                                    | Done when                                                    | Time    |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------- |
| 0   | Device tests         | Test the risks listed below on Samsung                                                                                                       | Parity table is final for Samsung                            | 1 wk    |
| 1   | Foundation           | Starter fixes, Tizen packaging, CI, deploy to TV, app shell, key mapping                                                                     | The Samsung TV installs the app and responds to the remote   | 1 wk    |
| 2   | Sources and data     | M3U, Xtream and Stalker parsers, XMLTV worker, storage, scheduled refresh                                                                    | 10k channels and 7 days of guide data import without a crash | 2–3 wks |
| 3   | Live player          | Playback engines, zapping, info banner, tracks, reconnect, error handling                                                                    | Hours of playback and repeated zapping stay stable           | 2–3 wks |
| 4   | TV guide and main UI | Guide grid, channel list, mini-preview, search, number entry                                                                                 | Smooth scrolling at the 10k channel load                     | 2–3 wks |
| 5   | Library management   | Favourites, custom groups, sorting, hiding, multiple playlists, parental PIN, settings, backup                                               | Settings survive a restart and a restore                     | 2 wks   |
| 6   | Catch-up and VOD     | Catch-up URL formats, movies, series, resume, reminders                                                                                      | Works with at least 3 different providers                    | 2 wks   |
| 7   | Advanced             | Multi-view and pause-live, depending on Phase 0; optional recorder                                                                           | Each feature ships or gets a documented limit                | 3–4 wks |
| 8   | Hardening            | Memory soak tests, older-TV tuning, translations, accessibility, store packaging                                                             | 24-hour run on the oldest supported Samsung TV               | 2–3 wks |
| 9   | LG webOS             | Run the Phase 0 tests on LG, webOS packaging (`appinfo.json`), key mapping, `<video>` and `mpegts.js` engines, LG limits in the parity table | Phases 1–8 "done when" checks pass on an LG TV               | 3–4 wks |

## Phase 0 tests

Run these on real TVs, ideally the oldest and newest you plan to support. Simulators won't settle playback or decoder limits. Run them on Samsung now, and again on LG at the start of Phase 9.

1. **Raw TS and HLS:** live playback with common codecs, including HEVC, AC-3 and MP2 audio.
2. **Video behind the UI:** whether the WebGL UI stays smooth over video, using the `holePunch` shader. Samsung's AVPlay window also needs to stay aligned with it.
3. **CORS:** fetch playlists and guide data from real providers. If this is blocked, the app needs a helper service or proxy.
4. **Custom headers:** Samsung's documented options cover only `COOKIE` and `USER_AGENT`, so streams that need a referrer may fail natively.
5. **Multi-view:** how many streams can play at once on each TV.
6. **Large guide files:** gzip decoding, parsing time and memory use on a 100 MB+ XMLTV file.
7. **Recording:** sustained USB writes on Samsung, and how long a background service stays alive on LG.

### Samsung results so far

Tested on 2026-11-02 on a QN50Q60D (2024, Tizen 9.0), from inside the packaged app. To repeat a test, run the test stream server (`pnpm test-streams`) and a probe (`scripts/tv-probe/run.sh`), both inside the `tv-dev` box.

- **Formats (test 1):** every test stream from `scripts/test-streams/` plays through AVPlay, as both raw MPEG-TS over HTTP and HLS: H.264 1080p and 1080i, HEVC 8-bit and Main10, MPEG-2 1080i, with AAC, MP2, AC-3 5.1 and E-AC-3 5.1 audio. Of 30 channels sampled from a public playlist, the 11 that were online all played; the other 19 also failed a plain `fetch` from the TV, so none was a player problem.
- **Start time (Phase 3):** with AVPlay's default buffering, the first picture takes about 10 s for raw TS and 2–7.5 s for HLS. Setting `setBufferingParam` to 1–3 s cuts this to about 3.4 s for TS and 0.7 s for HLS. AVPlay reports a stream as prepared before it can show a picture, so measure start time at `onbufferingcomplete`.
- **CORS (test 3):** not enforced. `fetch` and XHR both read responses from servers without CORS headers, over HTTP and HTTPS, so Samsung needs no proxy.
- **Custom headers (test 4):** AVPlay sends a custom User-Agent (`setStreamingProperty("USER_AGENT", ...)`). There's no way to send a Referer: AVPlay has no option for it, and the app's `fetch` and XHR silently drop custom Referer and User-Agent headers. Streams that need a Referer will need a proxy.
- **Large guide file (test 6, partly):** the app downloaded a 64 MB XMLTV file in 3.7 s and held it as text without a crash. Parsing time and memory are still to test.
- **Video behind the UI (test 2):** works. The app's background cuts a hole where the video plays (`src/videoWindow.ts`), and the UI holds the TV's full 50 fps while scrolling a list over H.264 or HEVC video, in a preview window or full screen, where the app hides its menu. Checked on the TV: the video lines up with its window in both. Two lessons for the UI: a page-sized node with a `border` cost a third of the frame rate, because its shader runs on every pixel, so draw large outlines as thin bars; and any DOM element in the page layout (such as AVPlay's `<object>`) can make the page scroll with the arrow keys, so `index.html` turns page scrolling off. To see it, open `#/dev/video?url=<stream>` (`src/pages/dev/VideoTest.tsx`) or run the `video-ui` probe.
- **Multi-view (test 5):** two streams at once: a main one, and one using the sub video scaler (`setStreamingProperty("IN_APP_MULTIVIEW", "VIDEO_VIEW_RESOURCE_SUB")`, with its audio off). A third player takes the sub scaler and stops the second. Any mix of H.264 and HEVC works; with two HEVC streams, the main one pauses briefly while the second starts. Without `IN_APP_MULTIVIEW`, a second player stops the first.
- **Still to test:** guide parsing and USB recording.

## What you need before starting

- **TVs:** at least one Samsung in developer mode now, and an LG in developer mode by Phase 9. The oldest models you own set the realistic support floor.
- **Tools:** the Tizen CLI and Samsung certificates, both set up in the `tv-dev` distrobox (`scripts/setup-dev.sh`). The script also installs the webOS `ares` CLI, ready for Phase 9.
- **Test sources:** several real playlists from different providers, including one with catch-up and one with 10k+ channels.

`solidtv.dev/solid/`, the docs link in the README, returned a 404, so use the docs in `node_modules/@solidtv/solid/docs` and the demo app instead.

## Sources

- **Samsung:** [AVPlay API](https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/avplay-api.html), [AVPlay guide](https://developer.samsung.com/smarttv/develop/guides/multimedia/media-playback/using-avplay.html), [media specs](https://developer.samsung.com/smarttv/develop/specifications/media-specifications.html), [USB storage](https://developer.samsung.com/smarttv/develop/guides/data-handling/handling-usb-storages.html)
- **LG:** [streaming protocols and DRM](https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm), [video and audio formats](https://webostv.developer.lge.com/develop/specifications/video-audio-250), [JS services](https://webostv.developer.lge.com/develop/guides/js-service-basics)
- **SolidTV:** [demo app](https://github.com/solid-tv/solid-demo-app)
- **TiviMate (third-party, and they disagree on details such as multi-view limits):** [setup guide](https://iptvbros.pages.dev/blog/tivimate-setup-guide), [comparison](https://iptv.us.com/blog/tivimate-vs-iptv-smarters-comparison), [user guide on Scribd](https://www.scribd.com/document/725020649/TiViMate-Users-Guide)
