import { Row } from "@solidtv/solid/primitives";
import { createSignal } from "solid-js";
import { BUTTON_HEIGHT, FIELD_WIDTH, FormButton, TextField } from "../../components/Form";
import { appStorage } from "../../data/settingsCopy";
import { exposeToProbes } from "../../devHooks";
import { backUpTo, restoreFrom, settings } from "../../library";
import { askPin } from "../../pin";
import { $t, $tn, isTextKey } from "../../translate";
import { SubPage } from "./SubPage";

const URL_KEY = "velio.backupUrl";

const savedUrl = () => {
  try {
    return appStorage.getItem(URL_KEY) ?? "";
  } catch {
    return "";
  }
};

// A failure's message: ours are translation keys.
const problemText = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error);
  return text.startsWith("backup.problem.") && isTextKey(text)
    ? $t(text)
    : $t("backup.failed", { error: text });
};

/**
 * Backing up the sources, edits and settings to a URL, and restoring them
 * from one (PLAN.md, Phase 5, step 7). Restoring replaces what's here, so
 * it asks for OK twice, and for the PIN if one is set.
 */
export const BackupPage = (props: { onClose: () => void }) => {
  const [url, setUrl] = createSignal(savedUrl());
  const [message, setMessage] = createSignal("");
  const [problem, setProblem] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [confirmRestore, setConfirmRestore] = createSignal(false);
  const say = (text: string, wrong = false) => {
    setMessage(text);
    setProblem(wrong);
  };
  const keepUrl = (value: string) => {
    setUrl(value);
    setConfirmRestore(false);
    try {
      appStorage.setItem(URL_KEY, value);
    } catch {
      // Only the address is lost.
    }
  };

  const run = async (work: () => Promise<string>) => {
    if (busy()) return;
    setBusy(true);
    say($t("backup.working"));
    try {
      say(await work());
    } catch (error) {
      say(problemText(error), true);
    } finally {
      setBusy(false);
    }
  };
  const backUp = () =>
    run(async () => {
      await backUpTo(url());
      return $t("backup.saved");
    });
  const restore = async () => {
    if (!confirmRestore()) {
      setConfirmRestore(true);
      return;
    }
    setConfirmRestore(false);
    if (settings.hasPin() && !(await askPin(true))) return;
    await run(async () => {
      const backup = await restoreFrom(url());
      return $tn("backup.restored", backup.sources.length);
    });
  };
  exposeToProbes("backupPage", { url, message, problem, busy });

  return (
    <SubPage
      title={$t("backup.title")}
      intro={$t("backup.intro")}
      message={message()}
      problem={problem()}
      onClose={props.onClose}
    >
      <TextField
        label={$t("backup.url")}
        placeholder={$t("backup.urlPlaceholder")}
        hint={$t("source.edit.hint")}
        inputMode="url"
        value={url()}
        onChange={keepUrl}
      />
      <Row width={FIELD_WIDTH} height={BUTTON_HEIGHT} gap={24} marginTop={12} scroll="none">
        <FormButton label={$t("backup.backUp")} onEnter={() => void backUp()} />
        <FormButton
          label={confirmRestore() ? $t("backup.restoreConfirm") : $t("backup.restore")}
          width={confirmRestore() ? 420 : 300}
          danger
          onEnter={() => void restore()}
        />
      </Row>
    </SubPage>
  );
};
