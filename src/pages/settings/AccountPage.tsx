import { Text, View } from "@solidtv/solid";
import { Row } from "@solidtv/solid/primitives";
import { createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { BUTTON_HEIGHT, FIELD_WIDTH, FormButton } from "../../components/Form";
import { ProfileBadge } from "../../components/ProfileBadge";
import { startPairing, tvName, waitForOwner, type Pairing, type PairingRun } from "../../data/pairing";
import { exposeToProbes } from "../../devHooks";
import { profiles, sync } from "../../library";
import { qrImage } from "../../qrCode";
import { BOLD, colors, radius } from "../../theme";
import { $t, $tn } from "../../translate";
import { sayWhileFocused } from "../../voiceGuide";
import { SubPage } from "./SubPage";
import { timeAgo } from "./status";

const QR_SIZE = 480;
const QR_FRAME = 520;

/** "velio.tv/pair", from the site's address. */
const pairPage = (site: string) => `${site.replace(/^https?:\/\//i, "")}/pair`;

/** A code read out a character at a time, a group at a time: "K 7 Q M, 2 X H F, …". */
const spokenCode = (code: string) =>
  code
    .split("-")
    .map(group => group.split("").join(" "))
    .join(", ");

/**
 * Settings → Velio account (SYNC-PLAN.md, step 3): signing this TV in by a
 * phone, which scans the QR code or types the code at velio.tv/pair; then
 * the TV's profiles, its last pull, and signing out.
 */
export const AccountPage = (props: { onClose: () => void }) => {
  const [pairing, setPairing] = createSignal<Pairing>();
  const [expired, setExpired] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [problem, setProblem] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  const [confirmSignOut, setConfirmSignOut] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 30_000);
  let run: PairingRun | undefined;
  const say = (text: string, wrong = false) => {
    setMessage(text);
    setProblem(wrong);
  };

  const stop = () => {
    run?.stop();
    run = undefined;
    setPairing(undefined);
  };
  // Leaving the page stops waiting; the pairing then expires by itself.
  onCleanup(() => {
    clearInterval(clock);
    stop();
  });

  const signIn = async () => {
    if (starting()) return;
    stop();
    setExpired(false);
    setStarting(true);
    say($t("account.starting"));
    let next: Pairing;
    try {
      next = await startPairing(sync.site(), tvName(), (input, init) => fetch(input, init));
    } catch (error) {
      say($t("account.failed", { error: error instanceof Error ? error.message : String(error) }), true);
      return;
    } finally {
      setStarting(false);
    }
    say("");
    setPairing(next);
    const waiting = waitForOwner(next, (input, init) => fetch(input, init));
    run = waiting;
    const step = await waiting.done;
    if (run !== waiting || !step) return;
    run = undefined;
    if (step.status === "done") {
      setPairing(undefined);
      say($t("account.signedIn"));
      const outcome = await sync.signIn(step.trust, step.token);
      if (outcome.result === "failed") say($t("account.pullFailed", { error: outcome.problem }), true);
    } else if (step.status === "expired") {
      setPairing(undefined);
      setExpired(true);
      say($t("account.expired"), true);
    } else if (step.status === "failed") {
      setPairing(undefined);
      say($t("account.failed", { error: step.problem }), true);
    }
  };

  const pullNow = async () => {
    say($t("account.pulling"));
    const outcome = await sync.pull();
    if (outcome.result === "failed") say($t("account.pullFailed", { error: outcome.problem }), true);
    else if (outcome.result === "changed") say($t("account.pulledChanged"));
    else if (outcome.result === "same") say($t("account.pulledSame"));
    else say("");
  };

  const signOut = async () => {
    if (!confirmSignOut()) {
      setConfirmSignOut(true);
      return;
    }
    setConfirmSignOut(false);
    say($t("account.signingOut"));
    await sync.signOut();
    say($t("account.signedOut"));
  };

  const qr = createMemo(() => {
    const shown = pairing();
    return shown ? qrImage(shown.url, QR_SIZE) : undefined;
  });

  const lastPull = () => {
    const status = sync.status();
    const pulledAt = sync.saved().pulledAt;
    if (status.pulling) return $t("account.pulling");
    if (status.last?.result === "failed") return $t("account.pullFailed", { error: status.last.problem });
    const checked = status.checkedAt ?? pulledAt;
    return checked ? $t("account.checked", { when: timeAgo(checked, now()) }) : "";
  };

  // The code is read out in groups while it shows.
  sayWhileFocused(
    () => pairing() !== undefined,
    () => {
      const shown = pairing();
      return shown
        ? [$t("account.scan"), $t("account.orType", { page: pairPage(shown.site) }), spokenCode(shown.code)]
        : undefined;
    },
  );

  exposeToProbes("accountPage", { pairing, expired, message, problem, signIn, stop });

  // Each stage is drawn anew, so its first button takes the focus.
  const stage = () => (sync.signedIn() ? "in" : pairing() ? "pairing" : "out");

  return (
    <Show when={stage()} keyed>
      {_stage => (
        <SubPage
          title={$t("account.title")}
          intro={sync.signedIn() ? $t("account.signedInIntro") : $t("account.intro")}
          message={message()}
          problem={problem()}
          onClose={props.onClose}
        >
          <Switch>
            <Match when={sync.signedIn()}>
              <Text width={FIELD_WIDTH} contain="width" fontSize={28} color={colors.textDim} skipFocus>
                {$tn("account.profiles", profiles.list().length)}
              </Text>
              <View width={FIELD_WIDTH} height={profiles.list().length > 0 ? 150 : 0} skipFocus>
                <Row width={FIELD_WIDTH} height={150} gap={32} scroll="none" skipFocus>
                  <For each={profiles.list()}>
                    {profile => (
                      <View width={150} height={150} skipFocus>
                        <View x={27} width={96} height={96} skipFocus>
                          <ProfileBadge profile={profile} size={96} />
                        </View>
                        <Text
                          y={108}
                          width={150}
                          maxLines={1}
                          contain="width"
                          textAlign="center"
                          fontSize={24}
                          color={profile.id === profiles.currentId() ? colors.text : colors.textDim}
                        >
                          {profile.name}
                        </Text>
                      </View>
                    )}
                  </For>
                </Row>
              </View>
              <Text width={FIELD_WIDTH} contain="width" fontSize={24} color={colors.textFaint} skipFocus>
                {lastPull()}
              </Text>
              <Row width={FIELD_WIDTH} height={BUTTON_HEIGHT} gap={24} marginTop={12} scroll="none">
                <FormButton label={$t("account.pullNow")} width={360} onEnter={() => void pullNow()} />
                <FormButton
                  label={confirmSignOut() ? $t("account.signOutConfirm") : $t("account.signOut")}
                  width={confirmSignOut() ? 520 : 300}
                  danger
                  onEnter={() => void signOut()}
                />
              </Row>
              <Text width={FIELD_WIDTH} contain="width" fontSize={22} color={colors.textFaint} skipFocus>
                {$t("account.signOutNote", { page: sync.site().replace(/^https?:\/\//i, "") })}
              </Text>
            </Match>
            <Match when={pairing()}>
              {shown => (
                <>
                  <View width={FIELD_WIDTH} height={QR_FRAME} skipFocus>
                    <View
                      width={QR_FRAME}
                      height={QR_FRAME}
                      borderRadius={radius.large}
                      color="#ffffffff"
                      skipFocus
                    >
                      <View
                        x={(QR_FRAME - (qr()?.size ?? QR_SIZE)) / 2}
                        y={(QR_FRAME - (qr()?.size ?? QR_SIZE)) / 2}
                        width={qr()?.size ?? QR_SIZE}
                        height={qr()?.size ?? QR_SIZE}
                        src={qr()?.src}
                      />
                    </View>
                    <Text
                      x={QR_FRAME + 48}
                      y={24}
                      width={FIELD_WIDTH - QR_FRAME - 48}
                      contain="width"
                      fontSize={30}
                      color={colors.text}
                    >
                      {$t("account.scan")}
                    </Text>
                    <Text
                      x={QR_FRAME + 48}
                      y={180}
                      width={FIELD_WIDTH - QR_FRAME - 48}
                      contain="width"
                      fontSize={26}
                      color={colors.textDim}
                    >
                      {$t("account.orType", { page: pairPage(shown().site) })}
                    </Text>
                    <Text x={QR_FRAME + 48} y={290} fontSize={48} fontFamily={BOLD} letterSpacing={4}>
                      {shown().code}
                    </Text>
                  </View>
                  <FormButton label={$t("account.cancel")} onEnter={stop} />
                </>
              )}
            </Match>
            <Match when={true}>
              <Text width={FIELD_WIDTH} contain="width" fontSize={28} color={colors.textDim} skipFocus>
                {$t("account.what")}
              </Text>
              <FormButton
                label={expired() ? $t("account.newCode") : $t("account.signIn")}
                width={460}
                onEnter={() => void signIn()}
              />
            </Match>
          </Switch>
        </SubPage>
      )}
    </Show>
  );
};
