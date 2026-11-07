// The programme on now and the next one, for a channel that may change with
// every press. A channel whose guide was read before shows straight away;
// otherwise the guide is read once the channel has stayed put for `delayMs`,
// so zapping or scrolling through channels doesn't read each one.

import { createEffect, createSignal, onCleanup } from "solid-js";
import { DAY } from "../data/guideCodec";
import { type GuideCache, type NowAndNext, nowAndNext } from "../data/guideCache";
import type { Channel } from "../data/lineup";

export const GUIDE_DELAY_MS = 250;

/** What a cache already holds for `at`, or undefined if it has to read. */
const fromCache = (guide: GuideCache, source: string, guideId: string, at: number) => {
  const today = Math.floor(at / DAY);
  const programmes = guide.peek(source, guideId, today);
  if (!programmes) return undefined;
  const found = nowAndNext(programmes, at);
  if (found.next) return found;
  const tomorrow = guide.peek(source, guideId, today + 1);
  if (!tomorrow) return undefined;
  const later = nowAndNext(tomorrow, at);
  return { now: found.now ?? later.now, next: later.next };
};

export const createNowNext = (
  channel: () => Channel | undefined,
  options: { guide: GuideCache; clock: () => number; delayMs?: number },
) => {
  const [value, setValue] = createSignal<NowAndNext>({});
  let request = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  createEffect(() => {
    const current = channel();
    const at = options.clock();
    const mine = ++request;
    clearTimeout(timer);
    const guideId = current?.guideId;
    if (!current || !guideId) {
      setValue({});
      return;
    }
    const cached = fromCache(options.guide, current.source, guideId, at);
    if (cached) {
      setValue(cached);
      return;
    }
    setValue({});
    timer = setTimeout(() => {
      options.guide
        .nowAndNext(current.source, guideId, at)
        .then(found => mine === request && setValue(found))
        .catch((error: unknown) => console.error("Couldn't read the guide:", error));
    }, options.delayMs ?? GUIDE_DELAY_MS);
  });
  onCleanup(() => clearTimeout(timer));

  return value;
};
