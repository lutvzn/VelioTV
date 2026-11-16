import { Text, View } from "@solidtv/solid";
import { createMemo, createSignal, For, Match, onCleanup, Switch } from "solid-js";
import { ChoiceField, FIELD_WIDTH, FormButton, TextField } from "../../components/Form";
import { clientFor } from "../../debrid/api";
import { type DeviceCode, torboxDeviceSignIn } from "../../debrid/deviceSignIn";
import { SERVICES, type ServiceId, serviceInfo } from "../../debrid/services";
import { exposeToProbes } from "../../devHooks";
import { debrid, debridAccounts } from "../../library";
import { debridErrorText } from "../../play/addonPlay";
import { qrImage } from "../../qrCode";
import { BOLD, colors, radius } from "../../theme";
import { $t } from "../../translate";
import { sayWhileFocused } from "../../voiceGuide";
import { SubPage } from "./SubPage";

const QR_SIZE = 400;
const QR_FRAME = 440;

/** A code read out a character at a time: "A B 1 2". */
const spokenCode = (code: string) => code.split("").join(" ");

/**
 * Settings → Debrid services (PLAN.md, "Debrid services"): the service the
 * profile's torrents play through, each service's API key, checked when
 * it's typed, and signing in to TorBox by a phone instead.
 */
export const DebridPage = (props: { onClose: () => void }) => {
  const accounts = debridAccounts.accounts;
  const [message, setMessage] = createSignal("");
  const [problem, setProblem] = createSignal(false);
  const [code, setCode] = createSignal<DeviceCode>();
  const say = (text: string, wrong = false) => {
    setMessage(text);
    setProblem(wrong);
  };

  const uses = createMemo(() => [
    { value: undefined as ServiceId | undefined, label: $t("debrid.none") },
    ...SERVICES.filter(service => accounts().keys[service.id]).map(service => ({
      value: service.id as ServiceId | undefined,
      label: service.name,
    })),
  ]);

  /** Whether the service takes the key, said on the message line. */
  const checkKey = async (id: ServiceId, key: string) => {
    const name = serviceInfo(id).name;
    say($t("debrid.checking", { name }));
    try {
      await clientFor(id, key).account();
      if (accounts().keys[id] === key) say($t("debrid.keyWorks", { name }));
    } catch (error) {
      if (accounts().keys[id] === key) say(debridErrorText(error, name), true);
    }
  };

  const setKey = (id: ServiceId, key: string) => {
    if (key === (accounts().keys[id] ?? "")) return;
    debridAccounts.setKey(id, key);
    debrid.forget();
    if (key) void checkKey(id, key);
    else say($t("debrid.keyRemoved", { name: serviceInfo(id).name }));
  };

  // Signing in to TorBox by a phone: the code shows until it's typed, it
  // expires, or the page closes.
  let run = 0;
  const stop = () => {
    run++;
    setCode(undefined);
  };
  onCleanup(stop);
  const signIn = async () => {
    const mine = ++run;
    const flow = torboxDeviceSignIn();
    say($t("debrid.signIn.starting"));
    let shown: DeviceCode;
    try {
      shown = await flow.start();
    } catch (error) {
      if (mine === run) say(debridErrorText(error, "TorBox"), true);
      return;
    }
    if (mine !== run) return;
    setCode(shown);
    say($t("debrid.signIn.waiting"));
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, shown.intervalMs));
      if (mine !== run) return;
      if (Date.now() > shown.expiresAt) {
        stop();
        say($t("debrid.signIn.expired"), true);
        return;
      }
      try {
        const answer = await flow.check(shown);
        if (mine !== run) return;
        if (answer.state === "expired") {
          stop();
          say($t("debrid.signIn.expired"), true);
          return;
        }
        if (answer.state === "signedIn") {
          stop();
          debridAccounts.setKey("torbox", answer.key);
          debrid.forget();
          say($t("debrid.signIn.done", { name: "TorBox" }));
          return;
        }
      } catch (error) {
        // A failed ask is tried again at the next turn, until the code expires.
        console.warn("TorBox sign-in:", error);
      }
    }
  };

  const qr = createMemo(() => {
    const shown = code();
    return shown ? qrImage(shown.fullAddress, QR_SIZE) : undefined;
  });

  sayWhileFocused(
    () => code() !== undefined,
    () => {
      const shown = code();
      return shown
        ? [
            $t("debrid.signIn.scan"),
            $t("debrid.signIn.orType", { page: shown.address }),
            spokenCode(shown.userCode),
          ]
        : undefined;
    },
  );

  exposeToProbes("debridPage", { message, problem, code, signIn, stop, setKey });

  // Each stage is drawn anew, so its first field takes the focus.
  const stage = () => (code() ? "code" : "fields");

  return (
    <Switch>
      <Match when={stage() === "code" && code()}>
        {shown => (
          <SubPage
            title={$t("settings.debrid")}
            intro={$t("debrid.signIn.title", { name: "TorBox" })}
            message={message()}
            problem={problem()}
            onClose={stop}
          >
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
                {$t("debrid.signIn.scan")}
              </Text>
              <Text
                x={QR_FRAME + 48}
                y={150}
                width={FIELD_WIDTH - QR_FRAME - 48}
                contain="width"
                fontSize={26}
                color={colors.textDim}
              >
                {$t("debrid.signIn.orType", { page: shown().address.replace(/^https?:\/\//i, "") })}
              </Text>
              <Text x={QR_FRAME + 48} y={260} fontSize={48} fontFamily={BOLD} letterSpacing={4}>
                {shown().userCode}
              </Text>
            </View>
            <FormButton label={$t("account.cancel")} onEnter={stop} />
          </SubPage>
        )}
      </Match>
      <Match when={stage() === "fields"}>
        <SubPage
          title={$t("settings.debrid")}
          intro={$t("debrid.intro")}
          message={message()}
          problem={problem()}
          onClose={props.onClose}
        >
          <ChoiceField
            label={$t("debrid.use")}
            choices={uses()}
            value={accounts().service}
            onChange={id => {
              debridAccounts.use(id);
              say(id ? $t("debrid.using", { name: serviceInfo(id).name }) : $t("debrid.notUsing"));
            }}
            hint={$t("source.change")}
          />
          <For each={SERVICES}>
            {service => (
              <>
                <TextField
                  label={$t("debrid.key", { name: service.name })}
                  value={accounts().keys[service.id] ?? ""}
                  placeholder={$t("debrid.key.empty", { page: service.keyPage })}
                  secret
                  onChange={key => setKey(service.id, key)}
                  hint={$t("source.edit.hint")}
                />
                {service.signIn === "device" ? (
                  <FormButton
                    label={$t("debrid.signIn.button", { name: service.name })}
                    width={FIELD_WIDTH}
                    onEnter={() => void signIn()}
                  />
                ) : null}
              </>
            )}
          </For>
        </SubPage>
      </Match>
    </Switch>
  );
};
