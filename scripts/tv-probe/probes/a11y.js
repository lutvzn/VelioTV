// Phase 8, step 5: what the TV offers for languages and for its voice guide.
// It reports the browser's and the system's languages, whether the Web Speech
// API is there and its voices, and whether Samsung's API says the voice
// guide is on. With "speak": "some text", it also speaks that text through
// speechSynthesis, and with "aria": "some text" it puts it in an aria-live
// region, so the user can listen for either. It takes a few seconds.
//
// Input (all optional):
//   "speak": "Hello"   text to speak with speechSynthesis
//   "aria": "Hello"    text to put in an assertive aria-live region
//   "lang": "en-US"    the language to speak in

async function probe(input) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const tryIt = run => {
    try {
      return run();
    } catch (error) {
      return { error: String(error) };
    }
  };
  const result = {
    navigatorLanguage: navigator.language,
    navigatorLanguages: navigator.languages,
    intlLocale: tryIt(() => Intl.DateTimeFormat().resolvedOptions().locale),
    pluralRules: typeof Intl.PluralRules,
    relativeTime: typeof Intl.RelativeTimeFormat,
    speechSynthesis: typeof speechSynthesis,
    utterance: typeof SpeechSynthesisUtterance,
  };

  if (typeof tizen !== "undefined" && tizen.systeminfo) {
    result.systemLocale = await new Promise(resolve =>
      tizen.systeminfo.getPropertyValue(
        "LOCALE",
        locale => resolve({ language: locale.language, country: locale.country }),
        error => resolve({ error: String(error && error.message) }),
      ),
    );
  }
  const tvinfo = typeof webapis !== "undefined" ? webapis.tvinfo : undefined;
  if (tvinfo) {
    result.voiceGuide = tryIt(() =>
      tvinfo.getMenuValue(tvinfo.TvInfoMenuKey.VOICE_GUIDE_KEY) === tvinfo.TvInfoMenuValue.ON ? "on" : "off",
    );
    result.tvinfoKeys = tryIt(() => Object.keys(tvinfo.TvInfoMenuKey));
  } else result.tvinfo = "missing";

  if (typeof speechSynthesis !== "undefined") {
    let voices = speechSynthesis.getVoices();
    for (let waited = 0; voices.length === 0 && waited < 3000; waited += 250) {
      await sleep(250);
      voices = speechSynthesis.getVoices();
    }
    result.voices = voices.map(voice => `${voice.name} (${voice.lang})${voice.default ? " default" : ""}`);
    if (input.speak) {
      result.spoken = await new Promise(resolve => {
        const utterance = new SpeechSynthesisUtterance(input.speak);
        utterance.lang = input.lang || "en-US";
        utterance.addEventListener("end", () => resolve("ended"));
        utterance.addEventListener("error", event => resolve(`error: ${event.error}`));
        speechSynthesis.speak(utterance);
        setTimeout(() => resolve("no end in 10 s"), 10_000);
      });
    }
  }

  if (input.aria) {
    let region = document.getElementById("probe-aria");
    if (!region) {
      region = document.createElement("div");
      region.id = "probe-aria";
      region.setAttribute("aria-live", "assertive");
      document.body.appendChild(region);
    }
    region.textContent = "";
    await sleep(100);
    const span = document.createElement("span");
    span.setAttribute("aria-label", input.aria);
    span.textContent = input.aria;
    region.appendChild(span);
    await sleep(4000);
    result.aria = "placed";
  }
  return { done: result };
}
