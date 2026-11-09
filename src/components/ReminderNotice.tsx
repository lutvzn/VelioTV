import { useNavigate } from "@solidjs/router";
import { activeElement, type ElementNode, Text, View } from "@solidtv/solid";
import { createSignal, onCleanup, Show } from "solid-js";
import type { Reminder } from "../data/reminders";
import { exposeToProbes } from "../devHooks";
import { lineup, reminders } from "../library";
import { handOff } from "../live/handoff";
import { clockTime } from "../live/format";
import { OVERLAY_Z } from "../pages/live/ChannelOptions";
import { BOLD, colors, dialogShadow, radius } from "../theme";
import { $t } from "../translate";

const CHECK_MS = 10_000;
const WIDTH = 760;
const HEIGHT = 230;
/** A notice nobody answers goes after this long. */
const SHOWN_MS = 60_000;

const Notice = (props: { reminder: Reminder; onDone: () => void }) => {
  const navigate = useNavigate();
  // Where the focus goes back to.
  const before: ElementNode | undefined = activeElement();
  const close = () => {
    props.onDone();
    before?.setFocus();
  };
  const timer = setTimeout(close, SHOWN_MS);
  onCleanup(() => clearTimeout(timer));
  const watch = () => {
    props.onDone();
    const channel = lineup.find(props.reminder.channelId);
    if (!channel) {
      before?.setFocus();
      return;
    }
    handOff({ channelId: channel.id });
    navigate("/watch", { replace: true });
  };
  const starts = () =>
    props.reminder.start > Date.now()
      ? $t("reminder.startsAt", { time: clockTime(props.reminder.start) })
      : $t("reminder.onNow");

  return (
    <View
      autofocus
      zIndex={OVERLAY_Z + 1}
      x={1920 - WIDTH - 60}
      y={60}
      width={WIDTH}
      height={HEIGHT}
      borderRadius={radius.xlarge}
      color={colors.dialog}
      border={{ width: 2, color: colors.goldWash }}
      shadow={dialogShadow}
      onEnter={() => {
        watch();
        return true;
      }}
      onBack={() => {
        close();
        return true;
      }}
      // Every other key stops here.
      onKeyPress={() => true}
    >
      <View x={36} y={40} width={12} height={12} borderRadius={6} color={colors.gold} />
      <Text
        x={60}
        y={28}
        width={WIDTH - 96}
        maxLines={1}
        contain="width"
        fontSize={26}
        fontFamily={BOLD}
        color={colors.gold}
      >
        {`${starts()}  ·  ${props.reminder.channelName}`}
      </Text>
      <Text x={36} y={72} width={WIDTH - 72} maxLines={1} contain="width" fontSize={40} fontFamily={BOLD}>
        {props.reminder.title}
      </Text>
      <Text
        x={36}
        y={158}
        width={WIDTH - 72}
        maxLines={1}
        contain="width"
        fontSize={26}
        color={colors.textDim}
      >
        {$t("reminder.hint")}
      </Text>
    </View>
  );
};

/**
 * Reminders' notices (PLAN.md, Phase 6, step 6), over any page: a minute
 * before a programme with a reminder starts, a notice offers its channel.
 * OK watches it; Back, or a minute, dismisses it.
 */
export const ReminderNotice = () => {
  const [queue, setQueue] = createSignal<Reminder[]>([]);
  const check = () => {
    const due = reminders.due();
    if (due.length > 0) setQueue(list => [...list, ...due]);
  };
  const timer = setInterval(check, CHECK_MS);
  check();
  onCleanup(() => clearInterval(timer));
  exposeToProbes("reminderNotice", { queue, check });
  const done = () => setQueue(list => list.slice(1));
  return (
    <Show when={queue()[0]} keyed>
      {reminder => <Notice reminder={reminder} onDone={done} />}
    </Show>
  );
};
