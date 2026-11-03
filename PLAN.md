# IPTV player plan: Tizen and webOS with SolidTV

**The UI and most TiviMate features are achievable, but full parity isn't likely in a TV web app.** Recording, multi-view and pause-live depend on platform limits, so test those on real TVs before building the UI around them.

Rough estimate: 4–5 months for one full-time developer.

**Samsung comes first.** LG webOS support is the last phase, because no LG TV is available yet. Until then, LG items in this plan are kept for reference only.

## Feature parity

TiviMate's site returned only its title, so this list comes from third-party guides and prior knowledge. Check it against the real app before treating it as final.

| Feature                                                       | Outlook              | Limit or approach                                                                                                                 |
| ------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| M3U, Xtream and Stalker sources                               | Yes                  | Samsung doesn't enforce CORS for the packaged app (tested); LG is unconfirmed. Stalker needs a cookie the app can't send (tested) |
| TV guide, XMLTV, channel/group management, favourites, search | Yes                  | Parsing is fast on the TV (tested); how quickly IndexedDB can store a large guide is the main challenge                           |
| Movies, series, resume, catch-up                              | Yes                  | Catch-up depends on the provider                                                                                                  |
| Parental PIN, themes, backup/restore                          | Yes                  | Restore via QR code or a file on a URL                                                                                            |
| Audio and subtitle track selection                            | Mostly               | Samsung has an API for this; webOS needs testing                                                                                  |
| Reminders                                                     | Partial              | Only while the app is open                                                                                                        |
| Pause and rewind live TV                                      | Partial              | Limited to the provider's DVR window or catch-up; no Samsung time-shift API turned up                                             |
| Fast-forward and rewind speeds                                | Partial              | LG lists speeds other than 1.0 as not supported                                                                                   |
| Multi-view                                                    | 2 streams on Samsung | Tested: a main stream plus one picture-in-picture via `IN_APP_MULTIVIEW`; a third stops the second. LG is unknown                 |
| Local recording                                               | Samsung only, maybe  | Samsung has USB write APIs, but large-file behaviour is unconfirmed; LG says web apps can't access files a service downloads      |
| Recording with the app closed                                 | No, without a server | Needs a small self-hosted recorder                                                                                                |
| Auto frame rate, autostart, system-wide picture-in-picture    | Probably not         | Not checked against vendor docs; confirm during Phase 0                                                                           |

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

All are fixed and tested on the Samsung TV.

- **Device builds:** fixed. `vite.config.js` points the `#device` import at `devices/<TARGET_DEVICE>`, and `src/device.ts` loads it and starts the device setup.
- **Asset paths:** fixed. `devices/deviceConfigPlugin.ts` now uses `./` instead of an absolute base such as `/tizen/`.
- **Packaging:** Tizen is done: `devices/tizen/config.xml` and `scripts/deploy-tizen.sh <tv-ip>`, which builds, signs, installs and starts the app. It worked on the Samsung TV on 2026-11-02. The webOS `appinfo.json` comes in the LG phase.
- **Number keys:** fixed on Tizen, which maps them to 48–57 and registers the media and number keys at startup. Back leaves the app from the home page. LG still has `-1`, to fix in Phase 9.
- **Player:** fixed in `devices/common/player.ts`. The `<video>` element sits behind the UI's canvas, `seek()` jumps to a position and a new `skip()` moves relative to it, and `stop()` reuses the Shaka player instead of leaking it.
- **Repo setup:** done. The repo is on Forgejo (branch `master`), and the npm lockfile is gone, so pnpm is the only package manager.
- **Tooling:** done. Oxc does formatting (`oxfmt`, replacing Prettier) and linting (`oxlint` with type-aware rules). `pnpm check` runs format, lint, type check and tests, and `.forgejo/workflows/ci.yml` runs it plus a Samsung build on Forgejo.
- **App shell:** done. A side menu (`src/components/SideMenu.tsx`) opens placeholder pages for Live TV, TV Guide, Movies, Series and Settings.

## Phases

| #   | Phase                | Main work                                                                                                                                    | Done when                                                           | Time    |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------- |
| 0   | Device tests         | Test the risks listed below on Samsung                                                                                                       | Parity table is final for Samsung                                   | 1 wk    |
| 1   | Foundation           | Starter fixes, Tizen packaging, CI, deploy to TV, app shell, key mapping                                                                     | The Samsung TV installs the app and responds to the remote          | 1 wk    |
| 2   | Sources and data     | M3U, Xtream and Stalker parsers, XMLTV worker, storage, scheduled refresh                                                                    | 10k channels import without a crash, with as many guide days as fit | 2–3 wks |
| 3   | Live player          | Playback engines, zapping, info banner, tracks, reconnect, error handling                                                                    | Hours of playback and repeated zapping stay stable                  | 2–3 wks |
| 4   | TV guide and main UI | Guide grid, channel list, mini-preview, search, number entry                                                                                 | Smooth scrolling at the 10k channel load                            | 2–3 wks |
| 5   | Library management   | Favourites, custom groups, sorting, hiding, multiple playlists, parental PIN, settings, backup                                               | Settings survive a restart and a restore                            | 2 wks   |
| 6   | Catch-up and VOD     | Catch-up URL formats, movies, series, resume, reminders                                                                                      | Works with at least 3 different providers                           | 2 wks   |
| 7   | Advanced             | Multi-view and pause-live, depending on Phase 0; optional recorder                                                                           | Each feature ships or gets a documented limit                       | 3–4 wks |
| 8   | Hardening            | Memory soak tests, older-TV tuning, translations, accessibility, store packaging                                                             | 24-hour run on the oldest supported Samsung TV                      | 2–3 wks |
| 9   | LG webOS             | Run the Phase 0 tests on LG, webOS packaging (`appinfo.json`), key mapping, `<video>` and `mpegts.js` engines, LG limits in the parity table | Phases 1–8 "done when" checks pass on an LG TV                      | 3–4 wks |

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
- **Large guide file (test 6):** parsing is fast, but storing is slow. A Web Worker streams the file through `DecompressionStream("gzip")` and `TextDecoderStream` (the TV supports both) and scans it as text, without building an XML document. Two public guides together (112 MB of XML: 5,908 channels and 220,059 programmes) parsed in 15.3 s, including the download, while the UI kept 60 fps (lowest 57). Kept in memory, the programmes used about 230 MB of the TV's 379 MB free, which is too much. Saved to IndexedDB, one record per programme, the same import (downloaded gzipped, 15 MB) took 217 s, 200 s of it writing: about 1,100 programmes a second. Free memory stayed above 337 MB, and the UI kept 60 fps (lowest 53). At that rate, 7 days for 10k channels would take far too long, so Phase 2 starts by finding a faster storage layout. To repeat the test, run the `guide` probe.
- **Video behind the UI (test 2):** works. The app's background cuts a hole where the video plays (`src/videoWindow.ts`), and the UI holds the TV's full 50 fps while scrolling a list over H.264 or HEVC video, in a preview window or full screen, where the app hides its menu. Checked on the TV: the video lines up with its window in both. Two lessons for the UI: a page-sized node with a `border` cost a third of the frame rate, because its shader runs on every pixel, so draw large outlines as thin bars; and any DOM element in the page layout (such as AVPlay's `<object>`) can make the page scroll with the arrow keys, so `index.html` turns page scrolling off. To see it, open `#/dev/video?url=<stream>` (`src/pages/dev/VideoTest.tsx`) or run the `video-ui` probe.
- **Multi-view (test 5):** two streams at once: a main one, and one using the sub video scaler (`setStreamingProperty("IN_APP_MULTIVIEW", "VIDEO_VIEW_RESOURCE_SUB")`, with its audio off). A third player takes the sub scaler and stops the second. Any mix of H.264 and HEVC works; with two HEVC streams, the main one pauses briefly while the second starts. Without `IN_APP_MULTIVIEW`, a second player stops the first.
- **Not tested yet:** USB recording (test 7). Recording is out of v1, so it moves to Phase 7, where the optional recorder is decided.

## Phase 2 plan: sources and data

Phase 1 is done: the starter fixes, Tizen packaging, CI, deploy, app shell and key mapping above all work on the Samsung TV.

1. **Storage layout:** done. The `storage` probe wrote the same synthetic guide (200 channels, 7 days, 24 programmes a day, with 30-word descriptions) to IndexedDB on the TV in several layouts:

   | Layout                                              | Programmes stored a second | Read a channel's week | Read a guide screen (10 channels × 3 h) |
   | --------------------------------------------------- | -------------------------- | --------------------- | --------------------------------------- |
   | One record per programme, indexed                   | 1,270                      | 24 ms                 | 19 ms                                   |
   | One record per programme, keyed by channel and time | 1,470                      | 16 ms                 | 16 ms                                   |
   | One record per channel per day                      | 11,650                     | 8 ms                  | 14 ms                                   |
   | The same, with relaxed durability                   | 27,740                     | 7 ms                  | 12 ms                                   |

   The cost is per record, not per byte: leaving descriptions out barely helped. **The guide is stored as one record per channel per day, written with `durability: "relaxed"`.** At 2,000 channels (336,000 programmes) it still stored 23,000–27,000 programmes a second, so 7 days for 10k channels should take about a minute, and the UI kept 60 fps throughout. Relaxed writes can lose the last few transactions if the TV loses power, which is fine for guide data, as long as an import counts as finished only once its last write completes.

2. **Test data:** done. The test stream server (`pnpm test-streams`, see `scripts/test-streams/server.mjs`) now also serves made-up sources whose channels play the test streams: an M3U playlist, an XMLTV guide (plain, or gzipped and cached), channel logos, a mock Xtream API (`test`/`test`) and a mock Stalker portal (MAC `00:1A:79:00:00:01`). All four describe the same channels, generated from fixed seeds in `catalog.mjs`. They include the awkward cases real sources have: channels with no guide, two channels sharing one guide, missing logos, names with commas, quotes and accents, channels that need a Referer or User-Agent, catch-up channels, and guides in four time zones. Stalker stream links need `create_link`, as on real portals.

   The default source has 10,000 channels in 120 groups, with guides for 9,305 of them. Its guide covers 7 days from yesterday: 1.7 million programmes, 649 MB of XML, or 94 MB gzipped. The server writes the gzipped file in about 30 s the first time it is asked for. This is heavier than most real guides (the 220,000-programme public guide in Phase 0 was 112 MB), so it is a worst case. `?channels=` and `?days=` give smaller sources, and the `small`/`small` account and MAC `00:1A:79:00:00:02` have 50 channels.

3. **Parsers:** done. M3U and XMLTV parsers in `src/data/`, as plain TypeScript tested with Vitest, run in a Web Worker that streams and stores as it parses (`importer.ts`, started by `importSource()` in `importClient.ts`). The tests run against the test sources. On a desktop the XMLTV parser reads about 170,000 programmes a second. `src/devHooks.ts` exposes the importer to on-TV probes as `window.tiviplayer`.

   On the TV (the `import` probe), a 2,000-channel source (340,471 programmes, 7 days) imported in 41.6 s at 60 fps (lowest 59), with free memory staying above 332 MB. Reading a guide screen back took 17 ms. Writing one batch while parsing the next raised the guide stage from about 10,000 to 12,000 programmes a second.

   **Storage is capped at 80 MB per app.** The `quota` probe stores only 70 MB of incompressible data before `QuotaExceededError`, with or without the `unlimitedstorage` privilege. `navigator.storage.estimate()` also reports an 80 MB quota. Stored as plain records, the guide takes about 240 bytes a programme, so a 4,000-channel import failed after about 600,000 programmes. Deleted records keep their space until the database compacts, and only uninstalling the app reliably frees it. The Tizen filesystem API is no way round this (the `files` probe): it doesn't exist in workers, and on the main thread it wrote 1.3 MB a second at 1 fps.

   Real guides compress well. On the Plex and PlutoTV guides (249,172 programmes), a programme takes 284 bytes as JSON, 66 bytes deflated per channel per day, and 49–54 bytes deflated per channel for the whole guide. Even compressed, 10k channels × 7 days (about 1.7 million programmes) would need about 100 MB, so the guide needs a size budget.

   **Decision: compress, refresh in place, and keep the guide within a budget.**
   - **Compression:** each channel-day record is packed as JSON field arrays and deflated with fflate (`guideCodec.ts`). fflate is synchronous, which keeps merges simple, and works on TVs without `CompressionStream`. Its streaming gunzip also covers TVs without `DecompressionStream`.
   - **Refresh in place:** records are keyed by source, and a refresh overwrites them, then deletes what it didn't write. If a refresh fails partway, the source keeps a mix of old and new data, and its import state says "failed".
   - **Budget:** the guide gets 50 MB of the 80 MB, keeping yesterday plus 7 days by default. When a source is too big, the farthest days go first. The writer predicts the guide's size from the first few hundred records, so it rarely packs days it would later drop. The import state records the days kept and whether the guide was trimmed.

   With that, on the TV:

   | Test                                       | Result                                                                  |
   | ------------------------------------------ | ----------------------------------------------------------------------- |
   | 2,000 channels, 8 days                     | 338,656 programmes in 22.7 MB (67 bytes each), 55 s, 60 fps (lowest 59) |
   | The same source imported twice more, kept  | Storage use 28 MB, then 36 MB: refreshing doesn't double it             |
   | 2,000 channels with a 10 MB budget         | Kept 3 days (145,363 programmes, 9.7 MB) in 31 s, 60 fps (lowest 59)    |
   | Reading a guide screen (10 channels × 3 h) | 62 ms, up from 17 ms uncompressed                                       |

   Open points:
   - **Import speed:** packing is now the slowest part, at about 6,400 programmes a second, so a full 50 MB guide would take about 2 minutes to store. A second worker for packing could help, if it matters.
   - **Guide reads:** 62 ms on the main thread is too long while scrolling. The guide screen (Phase 3) should keep unpacked days in memory, or unpack them in a worker.
   - **Older TVs:** the worker isn't run through the legacy build, and uses syntax such as `??` that needs Chromium 80. Tizen 5.5 (Chromium 69) would need a lower build target for workers. Only the Tizen 9 TV has been tested.
   - The one programme per channel that started before the first kept day (on air at midnight yesterday) is left out.

4. **Xtream and Stalker clients:** Xtream is done; Stalker is on hold.
   - **Xtream** (`src/data/xtream.ts`): an import with `kind: "xtream"` logs in through `player_api.php`, loads the live categories and channels, and imports the guide from `xmltv.php` through the same parser, storage and budget as M3U. Fields that servers send as either numbers or strings are read loosely. Channels keep their `stream_id` (`providerId`), and archive channels are marked for catch-up (`type: "xtream"`). The account's status, expiry and connection limit are saved with the import. On the TV, a 2,000-channel account imported in 52.9 s: 1.2 s for the channel list, then 50 s for the 124 MB guide, at 60 fps (lowest 58). The tests run against the test server's mock API.
   - **Stalker is on hold on Samsung.** Portals identify the box by a `Cookie: mac=...` header, and the app can't send one: the `request-headers` probe found `fetch` and XHR silently drop `Cookie`, `Referer` and `User-Agent` (they do send `Authorization` and custom headers such as `X-User-Agent`). Tizen's `websetting` API can change the whole app's User-Agent (`setUserAgentString()`, tested), but nothing can set a cookie for another host. Stalker needs either a way to send that cookie or a small relay on the user's network, which streams that need a Referer would also use. The test server's mock portal stays for when that is decided.
5. **Sources and refresh:** built; the on-screen check is still to do. Settings lists the sources, each with its channel count, how far its guide goes, when it was last updated and, while importing, its progress. OK on a source opens its form; "Add a source" opens an empty one. The form takes an M3U URL or an Xtream login, an optional name and guide URL, and how often to update (6, 12, 24 or 48 hours, or weekly), with "Update now" and "Remove". While an import runs, the side menu says so on every page.
   - **Typing:** a text field opens the TV's own keyboard by putting a real `<input>` over the field (`src/textEntry.ts`), as a canvas can't take text. Its key events stop at the input, so the app's focus manager doesn't act on them, and Enter, Back, or the keyboard's Done or Cancel ends the edit.
   - **Where sources live:** the source list is kept in `localStorage`, apart from the imported data in IndexedDB (`src/data/sources.ts`). The data can always be imported again, but the list can't, and a full database shouldn't stop the list being saved.
   - **Refresh:** `src/data/sourceManager.ts` imports one source at a time: when it is added, when an edit changes its address or login, when asked, and when its data is older than its refresh time. It checks at startup, every 15 minutes, and when the app comes back into view. An import cut short by the app closing runs again at the next start; a failed one is retried after an hour. A failed refresh keeps the earlier data, and its import state keeps that data's counts and time, so Settings can show both.
   - **Several sources** share the guide's 50 MB: each import gets an equal share, or less if the others hold more than theirs until their next refresh. At startup, the app deletes stored data whose source is no longer in the list.
   - On the TV (the `sources` probe), a 300-channel M3U and the 50-channel Xtream account imported one after the other in 11.6 s, at 60 fps (lowest 59): 50,858 and 8,571 programmes.
   - **Fonts:** the app's MSDF Roboto has only 98 characters, ASCII and a few more, so names with accents (the test source's channel 991) or symbols such as "•" can't show yet. The UI's own text keeps to ASCII. Phase 3 needs a fuller font for channel and programme names.
6. **Done check:** import the 10k-channel test source with 7 days of guide data on the TV, without a crash, keeping as many guide days as fit in the budget, and record the time, memory and days kept here.

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
