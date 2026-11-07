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
5. **Sources and refresh:** done, and checked on the TV: the list, the form, typing with Samsung's keyboard, and progress while updating all work. Settings lists the sources, each with its channel count, how far its guide goes, when it was last updated and, while importing, its progress. OK on a source opens its form; "Add a source" opens an empty one. The form takes an M3U URL or an Xtream login, an optional name and guide URL, and how often to update (6, 12, 24 or 48 hours, or weekly), with "Update now" and "Remove". While an import runs, the side menu says so on every page.
   - **Typing:** a text field opens the TV's own keyboard by putting a real `<input>` over the field (`src/textEntry.ts`), as a canvas can't take text. Its key events stop at the input, so the app's focus manager doesn't act on them, and Enter, Back, or the keyboard's Done or Cancel ends the edit.
   - **Where sources live:** the source list is kept in `localStorage`, apart from the imported data in IndexedDB (`src/data/sources.ts`). The data can always be imported again, but the list can't, and a full database shouldn't stop the list being saved.
   - **Refresh:** `src/data/sourceManager.ts` imports one source at a time: when it is added, when an edit changes its address or login, when asked, and when its data is older than its refresh time. It checks at startup, every 15 minutes, and when the app comes back into view. An import cut short by the app closing runs again at the next start; a failed one is retried after an hour. A failed refresh keeps the earlier data, and its import state keeps that data's counts and time, so Settings can show both.
   - **Several sources** share the guide's 50 MB: each import gets an equal share, or less if the others hold more than theirs until their next refresh. At startup, the app deletes stored data whose source is no longer in the list.
   - On the TV (the `sources` probe), a 300-channel M3U and the 50-channel Xtream account imported one after the other in 11.6 s, at 60 fps (lowest 59): 50,858 and 8,571 programmes.
   - **Fonts:** the app's MSDF Roboto has only 98 characters, ASCII and a few more, so names with accents (the test source's channel 991) or symbols such as "•" can't show yet. The UI's own text keeps to ASCII. Phase 3 needs a fuller font for channel and programme names.
6. **Done check:** passed, so Phase 2 is done, with Stalker on hold (step 4). On a freshly installed app, the `import` probe imported the 10k-channel test source (the server's gzipped guide already built) in 146 s, without a crash:

   | Measure                          | Result                                                                                 |
   | -------------------------------- | -------------------------------------------------------------------------------------- |
   | Channels                         | 10,000 in 6 s                                                                          |
   | Guide                            | 1,698,559 programmes read (94 MB gzipped) in 137 s                                     |
   | Kept                             | 3 of 8 days (yesterday, today, tomorrow): 724,449 programmes in 48.4 MB, 67 bytes each |
   | Frame rate                       | 60 fps on average, lowest 48                                                           |
   | Free memory                      | 304 MB before, lowest 169 MB, 288 MB after                                             |
   | Reading back, on the main thread | All 10,000 channels in 961 ms; a guide screen (10 channels × 3 h) in 103 ms            |

   For Phase 3:
   - **Memory:** the import took up to 135 MB, while the 2,000-channel imports in step 3 kept free memory above 332 MB. The TV coped, but a lower peak would leave room for playback during a refresh. The guide writer's batches are the first place to look.
   - **Reads:** 961 ms for the channel list and 103 ms for a guide screen are too slow for the main thread. The channel list should load once and stay in memory, or load in pages. Guide days should be unpacked off the main thread or kept unpacked once read (step 3's open points).
   - **Days kept:** a source this big keeps only yesterday, today and tomorrow. If that's too little, leave yesterday out unless the source has catch-up, which would give one more day ahead.
   - `navigator.storage.estimate()` reported 125 MB used of an 80 MB quota after the probe deleted the import, so it counts space that deleted records still hold. Don't use it to judge free space.

## Phase 3 plan: live player

Done when hours of playback and repeated zapping stay stable on the Samsung TV.

1. **Player engine:** done. One `PlaybackEngine` interface (`devices/common/player.ts`) has AVPlay behind it on Samsung (`devices/tizen/player.ts`) and a `<video>` element with Shaka for the desktop browser, loaded only when used. The app's player (`src/player/`) sits on top: one stream at a time, its state as a signal (starting, playing, buffering, ended, failed, with the time to first picture), a 20 s limit for a stream to start, and the video window's hole in the background. A stream it has left can't change its state, so channels can change faster than they start. The developer video page uses it, and still holds 50 fps over video (`video-ui` probe).

   **Switching blocks the UI.** AVPlay's calls are synchronous, and closing a playing stream is the slow one: `stop()` then `close()` took 140–750 ms, and up to 1.9 s once when leaving an H.264 stream for HEVC over TS, while `close()` alone took 150–270 ms. Opening, the window and the buffer settings each take under 10 ms (the first `open()` after starting takes about 200 ms). So the engine only calls `close()`, and the player switches after the UI has drawn the new state: the screen changes first, then pauses for a frame or so. Requests that arrive before that replace each other, so only the last one opens.

   On the TV (the `zap` probe, all 8 test streams as raw TS and HLS, watched for 3 s each):

   | Measure                                       | Result                                                |
   | --------------------------------------------- | ----------------------------------------------------- |
   | Played                                        | 16 of 16                                              |
   | First picture                                 | HLS 0.46–0.73 s; raw TS 2.98–3.63 s                   |
   | Longest pause in the UI's drawing at a switch | 150–250 ms; 517 ms for the first stream               |
   | Frame rate                                    | 57 fps on average, lowest 31 (at a switch)            |
   | 12 switches 300 ms apart                      | The last stream asked for plays; longest pause 300 ms |
   | Free memory                                   | 323 MB before, lowest 285 MB, 322 MB after            |

   Raw TS spends about 3 s in AVPlay's prepare, against 0.4 s for HLS, so most of a TS start is AVPlay reading the stream before it plays. Real providers' streams may differ from the test server's, which starts an encoder per request.

2. **Channels in memory:** done, and checked on the TV.
   - **Storage:** a source's channel list is now one record holding a column per field (`src/data/channelList.ts`), written once at the end of the channel stage, instead of one record per channel. The database moved to version 3, which clears older data, so sources import again at the next start. A scratch probe compared layouts for 10,000 channels on the TV:

     | Layout                                     | Read       | Write  |
     | ------------------------------------------ | ---------- | ------ |
     | One record per channel (before)            | 730 ms     | 4.4 s  |
     | One record holding the channel objects     | 114–125 ms | 226 ms |
     | One record of JSON text, parsed after      | 96–121 ms  | 194 ms |
     | One record of columns (an array per field) | 43 ms      | 123 ms |

     With the test source's real fields, the 10,000-channel list reads in 108–125 ms: 78–108 ms from IndexedDB and about 30 ms to rebuild the channels. Rebuilding first took 115 ms more, because fields added one by one make slow objects in V8, so every channel is now built in one literal with the same fields. The channel stage of a 10,000-channel import takes 0.3 s.

   - **The lineup** (`src/data/lineup.ts`, `lineup` in `src/library.ts`) holds every source's channels in memory: all of them in source order, by group, and by id (`<source>/<index>`). It reads a source's list at startup and again when an import of it finishes, and keeps the old list while an import runs. On the TV, a 1,000-channel test source showed up with its 100 groups as soon as its import ended.
   - **Font:** the app now uses Noto Sans, regular and bold, instead of Roboto, whose atlas had 98 characters. Its atlases (`scripts/fonts/build.mjs`) hold 1,630 characters each: Latin with its extensions (Vietnamese included), modern Greek, Cyrillic, the small capitals and superscripts providers use in names ("ᴴᴰ"), punctuation such as "•", "–" and "…", currency, and "№". Each is 2048×1024, 8 MB of texture memory. Noto Sans has no "★", "●" or "✓". Left out: polytonic Greek; CJK, which would need thousands of glyphs; and Arabic, Hebrew and Indic scripts, which the renderer can't lay out (right to left, shaping). Missing characters show as spaces. Checked on the TV: a source named "Prüfung – Ελληνικά – Кино ᴴᴰ • №1 «€» …" shows in full in Settings, and text still sits right in the side menu, the source list and the form. The script has its own `package.json`, because its image tools bring Node's types, which clash with the browser's in the app's type check. UI text no longer has to keep to ASCII. The Roboto atlases (4.5 MB) are gone, and the Noto Sans TTFs moved out of `public/` to `scripts/fonts/`.
   - **Storage filled up again:** before this step's probes, the app had no sources, but IndexedDB counted 88 MB against the 80 MB quota, left by the step 6 import that was deleted. Reinstalling the app reset it. Users who remove a large source and add another could hit the same; Phase 8 should look at whether the database compacts over time.
3. **Live TV page:** done; the user's look at it on the TV is still to come. `src/pages/LiveTv.tsx` (since Phase 4, full screen only, in `src/pages/Watch.tsx`), with the zapper (`src/live/zapper.ts`), the guide cache (`src/data/guideCache.ts`), the banner and the channel list (`src/pages/live/`).
   - **Layout:** at app start the page goes full screen on the last channel watched (or the first). From the menu, the channel plays in a 1024×576 window with its name and now and next under it; Right watches it full screen. Back closes whatever is open (number entry, then the list, a zap not yet played, the banner) and then returns to the menu, with the channel still playing in the window.
   - **Zapping:** Up, Down and the channel keys zap, wrapping round at the ends, through the group the channel was picked from, or every channel. The banner changes at once on each press; the stream changes 400 ms after the last one, so a run of presses opens only the last channel. Number keys pick a channel by number (`tvg-chno`, or else the position from 1), on OK or 2 s after the last digit; a number with no channel says so. The last channel's id is kept in `localStorage`.
   - **Banner:** the number, name, group and a clock, the programme on now with its time and progress, and the next one. It shows for 5 s after each change; Info shows or hides it. The guide is read only for the banner's channel and the list's highlighted one, once it stays put for 250 or 400 ms, and days read are kept in memory (200 channel-days, cleared when the lineup reloads).
   - **Channel list:** OK or the channel-list key opens it over the left of the video, 12 rows drawn into fixed slots, so its size doesn't depend on how many channels there are. Left and Right change group ("All channels" first), the channel keys move a page, OK plays the highlighted channel.
   - **Referer streams** fail with a message saying the TV can't send the header the stream needs.
   - **On the TV** (`live` probe, 1,000-channel test source): the app started full screen and playing; 8 Up presses 150 ms apart opened one stream, 426 ms after the last press; scrolling the list 30 rows at 10 a second held 60 fps (longest frame 17 ms); picking from a group, number 12, Back to the menu (2 presses, playing on in the window) and Right back to full screen all worked. A zap takes 3.4–3.5 s from press to picture on these raw TS streams: the 400 ms pause, then about 3 s to start (Phase 0). The UI drops to 46–49 fps for about a second around each switch (frames of 200–220 ms, AVPlay's `close()`), and once froze for 2 s, as seen in step 1 when leaving H.264 for HEVC over TS.
   - Test channels share a few stream URLs, so the probe reads the channel from the page (`window.tiviplayer.live`, put there with `exposeToProbes()`), not from the stream.
4. **Reconnect and errors:** done, and checked with a probe on the TV; how the messages look is still to be seen.
   - **The player** (`src/player/player.ts`) reopens a live stream (`live: true`, which Live TV sets) that fails, ends, shows nothing within 20 s, or stalls. It waits 1, 2, 4, 8, 15 and then 30 s before each try, and gives up after the sixth. After 30 s of playing again, the count starts over. A stream has stalled when it has buffered for 15 s, or has stopped moving for 15 s once its position had moved. Errors that reopening can't fix (a Referer, a format the TV can't play) fail at once. While it waits, the status is `reconnecting`, with the error and which try it is. Live TV says what failed in words ("Couldn't reach the stream.", "The stream stopped.") and "Reconnecting (2 of 6)…".
   - **Test streams:** the test server serves raw TS that fails on purpose under `/fail/`: cut off after a time, stalled with the connection left open, answered with an HTTP status, or caught in an outage that a probe starts (`/fail/outage?seconds=n`, refused with 503, or with `&hang=1` left unanswered). In the test sources, channels 125, 375, 625 and 875 of every 1,000 cut off every 40 s, stall every 40 s, answer 404, and go down in an outage; their names say so. A source imported before has them only after it updates.
   - **On the TV** (`reconnect` probe), AVPlay deals with much of this itself, on raw TS:
     - Cut off: it asks for the stream again by itself, buffering for 0.4–2 s each time, with no error.
     - Stalled with the connection open: it asks again by itself about 11 s later. The player's stall limit is 15 s so as not to get in its way.
     - 404 and 503: `PLAYER_ERROR_CONNECTION_FAILED` about 3 s after opening, then the player's tries.
     - An 8 s outage (cut off, then 503): AVPlay's own retry fails, the player tries twice, and the channel plays again 4 s after the outage ends.
     - HLS through the same outage: AVPlay buffers for 0.5 s once and plays on, as it had segments buffered.
     - A server that stops sending and leaves new requests unanswered for 25 s: AVPlay buffers without an error. The player's stall check reopens the stream 15.5 s later, and it plays again once the server answers.
5. **Audio and subtitle tracks:** done, and checked with a probe on the TV; how the panel and subtitles look is still to be seen.
   - **Engines** list a stream's audio and subtitle tracks (`tracks()`) and pick one (`selectTrack()`, with no id for subtitles off). AVPlay lists them with `getTotalTrackInfo()`, picks them with `setSelectTrack()`, and hides subtitles with `setSilentSubtitle()`. It doesn't draw subtitles: it sends their text, with how long to show it, to `onsubtitlechange`, and the app draws it. On the desktop, Shaka picks the tracks and draws its own subtitles (not checked yet).
   - **The player** keeps the tracks and the subtitle text as signals, and remembers the languages chosen in `localStorage`. It picks them again on every stream that has them, so German audio carries over from one channel to the next. Two- and three-letter codes count as one language ("de", "deu", "ger"). Subtitles stay off unless a language was chosen.
   - **Live TV:** Right in full screen opens a panel down the right of the screen, with Audio and Subtitles (with Off); OK picks, and Back, Left or Right closes it. Subtitles show at the bottom of the screen, centred on a dark box.
   - **Test stream:** `h264-tracks` has English and German audio (one beep a second, or two higher ones). Over HLS it also has English and German WebVTT subtitles that say which second of the clip it is. Raw TS has the two audio tracks only.
   - **On the TV** (`tracks` probe):
     - AVPlay lists the tracks about 1.1 s after the first picture on HLS, and at once on raw TS. The player tries again at each 1 s check until they're listed.
     - Audio languages come as "eng" and "deu", and subtitle languages as "en" and "de". Raw TS lists the tracks out of order.
     - Changing audio blocks the UI for 110–135 ms (one frame of 117 ms). Changing subtitles takes 10–13 ms.
     - Each subtitle arrives on time, once a second, with its 800 ms duration. The text ends in a NUL character, which the engine drops.
     - Off stops them. The German audio chosen on HLS was picked by itself on the raw TS stream.
6. **App lifecycle:** done, and checked with a probe on the TV; a real network drop is still to be tried.
   - **Hidden:** `src/player/lifecycle.ts` listens for `visibilitychange`, which Tizen and webOS both send when the app goes behind Home or another app. The player closes the stream (`suspend()`, state `suspended`) and opens it again when the app comes back (`resume()`), as a fresh start. A live stream would be stale after a pause anyway, and closing frees the decoder for the other app.
   - **Network:** it also listens for `online` and `offline`. A live stream that fails while the TV is offline waits for the network, with "No network connection. The channel comes back with it." on screen, instead of using up its tries; it opens again as soon as the network is back.
   - **Waiting for a frame:** the player opens a stream after the UI has drawn (step 1). A hidden page draws no frames, so that wait now stops after 100 ms.
   - **On the TV** (`lifecycle` probe; the dev machine brought the app back with `tizen run`, as the remote's app list would):
     - `hide()` → the page says it is hidden 0.4–0.7 s later; the stream was closed 1.0–1.1 s after `hide()` (`close()` took 370 ms).
     - Timers and frames stop while the app is hidden, and start again when it is shown: the first frame came 1–94 ms after it was visible.
     - Shown again 29 s later: the same channel played 0.7–1.0 s after the app was visible, on HLS.
     - A pretend network drop (the page sent `offline`, the server refused the stream for 15 s): the stream buffered, then went to waiting for the network at 6 s without counting a try. After `online` at 20 s, it played again 0.4 s later.
   - **Not known yet:** whether Tizen sends the page `offline` and `online` when the cable or Wi-Fi really goes; `navigator.onLine` is true while connected. Without them, a real drop falls back to the normal reconnect tries (step 4). Samsung's `webapis.network` would say more, but it needs the `network.get` privilege: without it, `isConnectedToGateway()` throws a `SecurityError` (`getActiveConnectionType()` works, and says 1, wired). Called while the app was still loading its channels, it kept them from loading in three runs out of three, so the probe now calls it only once a channel plays.
7. **Done check:** a long run of playback and zapping on the TV, recording memory, errors and start times. Its length is agreed before it runs. Ready, not run yet. **Moved to after Phase 6** (decided 2026-11-06), so one soak covers the guide, library and VOD work too; Phase 4 starts now. Until it runs, Phase 3 is done apart from this check.
   - **The probe:** `soak` zaps up through the channels with the Up key, as a viewer would: 15 s on each channel and 2 minutes on every 10th (`zapSeconds`, `watchEvery`, `watchSeconds`; `minutes` sets the length). It records each channel's start time, errors and end state, and counts the test server's failing channels (`/fail/` URLs) separately. Each minute it logs the TV's free memory, the JS heap, the frame rate and the longest frame. At the end it summarises start times (median, 90th percentile, max) for raw TS and HLS, the errors, and memory first, lowest or highest, and last.
   - **To run:** in the box, with the test server running and the app full screen on Live TV, run `PROBE_TIMEOUT=<seconds> ./scripts/tv-probe/run.sh <tv-ip> soak '{"minutes": 120}' > soak.json 2> soak.log`. The time limit must be longer than the run, for example 7500 for 2 hours. `soak.log` gets a line a minute, so a run cut short still leaves its trend. About 140 zaps an hour.
   - **Length:** proposed at 2 hours (about 280 zaps), not agreed yet. Samsung's auto power-off (about 4 h without a real remote press) can end a longer run, as the probe's key presses don't count.
   - **Smoke run** (1 minute, 8 s per channel): 7 of 7 channels played. Start times were 3.0–5.0 s on raw TS and 0.6 s on HLS. Free memory stayed at about 290 MB and the JS heap at 20 MB. Frame rate was 58–60 fps, apart from one 1.95 s freeze at a switch (the H.264 to HEVC raw TS close, steps 1 and 3).

## Phase 4 plan: TV guide and main UI

Done when scrolling stays smooth at the 10k channel load on the Samsung TV. Phase 3 is done apart from its soak (step 7), which now runs after Phase 6.

1. **Guide data off the main thread:** done. A guide screen (10 channels × 3 h) took 62–103 ms to read on the main thread (Phase 2), too long while scrolling. Guide days are now read and unpacked in a worker (`src/data/guide.worker.ts`, `guideReader.ts`), which keeps the last 100 days it unpacked. The UI asks for them through `src/data/guideClient.ts`, which sends the reads asked for at the same time as one message and one transaction, and the guide cache (`guideCache.ts`) keeps what came back. The cache now reads whole UTC days rather than time ranges.
   - **On the TV** (`guide-read` probe, 1,000-channel test source with 931 guide channels and 7 days, 2026-11-07): both ways gave the same programmes. A screen of 10 channels took 40–65 ms on the main thread and 33–42 ms through the worker. In the worker, each screen read 20 records in 7–9 ms and unpacked them in 20–28 ms, 1–1.5 ms per record. Through the worker, a screen brings 250–277 programmes, the whole day, against 40–46 for 3 hours, so moving sideways later reads nothing. Scrolling, one new row every 100 ms: rows arrived in a median of 4 ms (most 10 ms) on the main thread and 5 ms (most 7 ms) through the worker, both at 60 fps with no frame over 50 ms. Through the worker the longest frame was 33 ms, once; on the main thread it was 17 ms. 343 MB free.
   - **So** at 1,000 channels the main thread kept up as well, since IndexedDB returns each record in its own callback. The worker costs no time and keeps the unpacking (1–1.5 ms per record) off the UI thread, and the grid will read more rows at once while it scrolls, so it stays. Step 6 checks it at 10,000 channels.
   - **Probe lessons:** `run.sh` restarts the app, which then takes about 8 s to read a 1,000-channel lineup, so probes that need channels wait for them first.
2. **Guide grid:** done, and checked with a probe on the TV; how it looks is still to be seen. `src/pages/Guide.tsx`, with its rows and details in `src/pages/guide/`, and the time line and data in `src/guide/`.
   - **Layout:** the preview at the top left (576×324), the highlighted programme beside it (channel, title, day and time, episode, a progress bar while it's on, 4 lines of description), the group line, the times, and 8 rows of channels. The span is 2 hours across 1,200 px, from the half hour before now; a red line marks now. A programme that started before the span shows "‹" before its title. The guide goes 7 days ahead; past programmes wait for catch-up (Phase 6).
   - **Rows** are drawn into 8 fixed slots and filled as the cursor moves, as in the Live TV channel list. Each row is cells along the time line (`src/guide/timeline.ts`): programmes, and gaps ("No information") where the guide has nothing, so every moment can take the focus. A channel without a guide is one bar. Programmes that overlap the one before lose the overlap.
   - **Focus** is a row and a moment, not a cell: Up and Down keep the moment and land on whatever is on then, so going down a column doesn't drift. Right moves to the next programme and Left to the one before; the span moves in half hours to keep the focus in view, with at least half an hour after it. Left from the programme on now goes to the menu. The focused cell is filled blue, not outlined, so the outline cost from Phase 0 doesn't apply.
   - **Data:** each row asks the guide cache for the days its span covers, plus a span either side for Left and Right; the rows a page above and below are read ahead (`src/guide/guideDays.ts`). Reads asked for together go to the worker as one message (step 1). A row shows an empty bar until its days arrive.
3. **Mini-preview:** done. The cursor's channel plays in the preview once it has stayed on a channel for 800 ms, and at once when the guide opens, on the last channel watched. The player's state shows in the window while it starts or fails. OK watches the channel full screen (step 5).
4. **Search:** done, channel names only. OK on the group line opens the TV's keyboard; the results become a group of their own ("Search: “…”"), first after All channels, and Left and Right on the group line move between them and the groups. A name matches when it holds every word typed, ignoring case and accents, so "cafe hd" finds "Café ᴴᴰ" (`src/guide/search.ts`). An empty search removes the results.
   - **Programme titles are left out:** searching them means unpacking every stored day (65,000 records for 10,000 channels × 7 days, at 1–1.5 ms each, step 1), about two minutes on the TV. That needs a title index written at import, if it's wanted later.
5. **Main UI:** done.
   - **In the guide:** number keys jump to a channel on OK or after 2 s (`src/live/numberEntry.ts`), showing every channel if the group hasn't got it; the channel keys move a page. Up from the first row reaches the group line, where Left and Right change group and OK searches.
   - **Live TV is the guide** (changed 2026-11-07, at the user's request): the menu has one Live TV entry, which opens the guide, and no separate TV Guide entry. Full screen is a page of its own (`src/pages/Watch.tsx`, at `#/watch`, with no menu), where the app still opens on the last channel. OK in the guide goes full screen on the channel, zapping through the guide's group; Back there (after closing the banner) returns to the guide on the channel playing, and with nothing to play it goes to the guide, which says what's missing. The Guide key on Samsung remotes (458, now registered) opens the guide from full screen, and Back there returns to the channel. The pages pass each other the channel, its group and where Back goes (`src/live/handoff.ts`).
   - **The stream carries on** between the pages: the player stops only once neither page holds it, and a page starting a channel that is already playing keeps its stream. Going from the preview to full screen doesn't start it again, which saves 3 s on raw TS.
   - The side menu follows the page when a page changes it.
   - **Checked after the change** (10,000-channel source, 2026-11-07): `guide-page` passed every step, with Back from full screen landing in the guide in two presses (banner, then Back), 60 fps scrolling (longest frame 17 ms, none over 50 ms), 168 guide days read with none failed and 260 MB free. `live` matched Phase 3, and Back from full screen reached the guide on the channel playing, with OK there going full screen again on it. One bug was found and fixed: the side menu's `autofocus` followed the path, so going from full screen to Live TV made the menu take the focus from the guide (and a further Back on the menu closed the app). It is now read once, at the app's start (`src/pages/App.tsx`).
6. **Done check:** passed, so Phase 4 is done apart from the user's look at it. The `guide-page` probe drives the guide with key presses and records each step and the frames. On the 10,000-channel test source (9,305 guide channels, 3 days kept, 2026-11-07):

   | Step                                        | Result                                                           |
   | ------------------------------------------- | ---------------------------------------------------------------- |
   | Opening the guide                           | 119–129 ms; the cursor on the last channel, its preview playing  |
   | 150 rows down, 10 a second                  | 60 fps (once 59); longest frame 17–33 ms; no frame over 50 ms    |
   | 30 pages down with the channel key, 3 a sec | 60 fps; longest frame 17–33 ms; every row ready when it stopped  |
   | 8 programmes right, then back               | The span moved 5.5 h and back; longest frame 17 ms               |
   | Number 500, a group, a search               | All landed on the right channel or list                          |
   | OK, Back, the Guide key, Back               | Full screen on the channel without restarting it, and back again |
   | Guide days read                             | 409, none failed; 301 MB free at the end                         |

   The preview switching channels still blocks for about 200 ms, as any switch does (Phase 3, step 1), but only once the cursor stops. On the 1,000-channel source the numbers were the same. The `live` probe gave the same results as in Phase 3 (step 3), so Live TV didn't change.
   - **Lost data, not explained:** after one 10,000-channel import on a fresh install, the stored data was gone at a later start: the source was still in the list, but its import state and channel list had both gone, and storage counted 87.7 MB against the 83.9 MB quota. The same steps again kept everything through three restarts, at 56 MB. The extra 32 MB suggests an import began at that start and failed on the quota, after clearing the old data and without room to save its state, but nothing in the logs shows that yet. Phase 8 should look at it with the storage questions from Phase 2 (step 6) and Phase 3 (step 2), starting with what the importer does when a write fails on the quota.

## What you need before starting

- **TVs:** at least one Samsung in developer mode now, and an LG in developer mode by Phase 9. The oldest models you own set the realistic support floor.
- **Tools:** the Tizen CLI and Samsung certificates, both set up in the `tv-dev` distrobox (`scripts/setup-dev.sh`). The script also installs the webOS `ares` CLI, ready for Phase 9.
  - **Signing diagnostic (2026-11-06):** the Samsung build passes, but packaging fails with `CertificationException: Invaild password`. The active profile references `author.pwd` and `distributor.pwd` files that are both missing; the `.p12` certificates remain present and valid until 2027-11-02. Restore the password files from a secure backup or reconfigure the profile with the existing certificates and their original passwords. No TV install was attempted.
  - **Signing/deploy retry (2026-11-06):** the existing `TizenDev` profile now signs successfully. `scripts/deploy-tizen.sh` built, signed, installed and launched the current working tree on the Samsung TV; the CLI confirmed installation and launch. No certificate/profile changes or uninstall were needed. The user confirmed the app is showing on the TV. `CI=1 pnpm check` also passed (format, lint, types and 92 tests). The box's login shell did not find pnpm until the fnm environment was loaded explicitly.
- **Test sources:** several real playlists from different providers, including one with catch-up and one with 10k+ channels.

`solidtv.dev/solid/`, the docs link in the README, returned a 404, so use the docs in `node_modules/@solidtv/solid/docs` and the demo app instead.

## Sources

- **Samsung:** [AVPlay API](https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/avplay-api.html), [AVPlay guide](https://developer.samsung.com/smarttv/develop/guides/multimedia/media-playback/using-avplay.html), [media specs](https://developer.samsung.com/smarttv/develop/specifications/media-specifications.html), [USB storage](https://developer.samsung.com/smarttv/develop/guides/data-handling/handling-usb-storages.html)
- **LG:** [streaming protocols and DRM](https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm), [video and audio formats](https://webostv.developer.lge.com/develop/specifications/video-audio-250), [JS services](https://webostv.developer.lge.com/develop/guides/js-service-basics)
- **SolidTV:** [demo app](https://github.com/solid-tv/solid-demo-app)
- **TiviMate (third-party, and they disagree on details such as multi-view limits):** [setup guide](https://iptvbros.pages.dev/blog/tivimate-setup-guide), [comparison](https://iptv.us.com/blog/tivimate-vs-iptv-smarters-comparison), [user guide on Scribd](https://www.scribd.com/document/725020649/TiViMate-Users-Guide)
