import { Text, View } from "@solidtv/solid";
import { Column, Row } from "@solidtv/solid/primitives";
import { createSignal, onCleanup, Show } from "solid-js";
import { BUTTON_HEIGHT, ChoiceField, FIELD_WIDTH, FormButton, TextField } from "../../components/Form";
import {
  DEFAULT_REFRESH_HOURS,
  defaultSourceName,
  REFRESH_CHOICES,
  sourceProblem,
  splitGuideUrls,
  type SourceDraft,
  type SourceKind,
} from "../../data/sources";
import { edits, library, watched } from "../../library";
import { $t } from "../../translate";
import { statusLines } from "./status";

const KINDS: { value: SourceKind; label: string }[] = [
  { value: "m3u", label: $t("source.kind.m3u") },
  { value: "xtream", label: $t("source.kind.xtream") },
];
const REFRESH = REFRESH_CHOICES.map(hours => ({
  value: hours,
  label: hours === 168 ? $t("source.refresh.week") : $t("source.refresh.hours", { count: hours }),
}));

interface FormState {
  kind: SourceKind;
  name: string;
  url: string;
  server: string;
  username: string;
  password: string;
  guide: string;
  refreshHours: number;
}

// The draft to save: only the fields the source's kind uses.
const toDraft = (form: FormState): SourceDraft => {
  const draft: SourceDraft = { kind: form.kind, name: form.name, refreshHours: form.refreshHours };
  if (form.kind === "m3u") {
    if (form.url) draft.url = form.url;
  } else {
    if (form.server) draft.server = form.server;
    if (form.username) draft.username = form.username;
    if (form.password) draft.password = form.password;
  }
  const guideUrls = splitGuideUrls(form.guide);
  if (guideUrls.length > 0) draft.guideUrls = guideUrls;
  if (!draft.name) draft.name = defaultSourceName(draft);
  return draft;
};

/** Adds a source (with no `id`), or edits one. Back leaves without saving. */
export const SourceForm = (props: { id?: string; onClose: () => void }) => {
  const existing = props.id ? library.sources().find(source => source.id === props.id) : undefined;
  // A signal, not a store: stores need Proxy, which the oldest TVs lack.
  const [form, setForm] = createSignal<FormState>({
    kind: existing?.kind ?? "m3u",
    name: existing?.name ?? "",
    url: existing?.url ?? "",
    server: existing?.server ?? "",
    username: existing?.username ?? "",
    password: existing?.password ?? "",
    guide: existing?.guideUrls?.join(" ") ?? "",
    refreshHours: existing?.refreshHours ?? DEFAULT_REFRESH_HOURS,
  });
  const [problem, setProblem] = createSignal("");
  const [confirmRemove, setConfirmRemove] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(clock));

  // A field's props; `value` is a getter so it stays reactive when spread.
  const field = <K extends keyof FormState>(key: K) => ({
    get value() {
      return form()[key];
    },
    onChange: (value: FormState[K]) => {
      setForm(before => ({ ...before, [key]: value }));
      setProblem("");
    },
  });

  // Saves the form, or shows why it can't; true if saved.
  const store = () => {
    const draft = toDraft(form());
    const issue = sourceProblem(draft);
    if (issue) {
      setProblem($t(issue));
      return false;
    }
    if (existing) library.update(existing.id, draft);
    else library.add(draft);
    return true;
  };
  const save = () => {
    if (store()) props.onClose();
  };
  // Saves any changes first, so the import uses them; stays to show progress.
  const update = () => {
    if (existing && store()) library.refresh(existing.id);
  };

  const remove = () => {
    if (!existing) return;
    if (!confirmRemove()) {
      setConfirmRemove(true);
      return;
    }
    void library.remove(existing.id);
    // Its channels' favourites, hiding, locks and moves go with it.
    edits.forgetSource(existing.id);
    watched.forgetSource(existing.id);
    props.onClose();
  };

  const status = () => (existing ? statusLines(library.statusOf(existing.id), now()) : undefined);
  const current = () => library.sources().find(source => source.id === existing?.id);
  const place = () => {
    const at = library.sources().findIndex(source => source.id === existing?.id);
    return { first: at <= 0, last: at === library.sources().length - 1 };
  };

  return (
    <View
      onBack={() => {
        props.onClose();
        return true;
      }}
      forwardFocus={0}
    >
      <Column x={80} y={190} width={FIELD_WIDTH} gap={12} scroll="none" autofocus>
        <ChoiceField
          label={$t("source.field.kind")}
          choices={KINDS}
          hint={$t("source.change")}
          {...field("kind")}
        />
        <Show
          when={form().kind === "m3u"}
          fallback={
            <>
              <TextField
                label={$t("source.field.server")}
                hint={$t("source.edit.hint")}
                inputMode="url"
                {...field("server")}
              />
              <TextField
                label={$t("source.field.username")}
                hint={$t("source.edit.hint")}
                {...field("username")}
              />
              <TextField
                label={$t("source.field.password")}
                hint={$t("source.edit.hint")}
                secret
                {...field("password")}
              />
            </>
          }
        >
          <TextField
            label={$t("source.field.url")}
            hint={$t("source.edit.hint")}
            inputMode="url"
            {...field("url")}
          />
        </Show>
        <TextField
          label={$t("source.field.name")}
          hint={$t("source.edit.hint")}
          placeholder={$t("source.field.namePlaceholder")}
          {...field("name")}
        />
        <TextField
          label={$t("source.field.guide")}
          hint={$t("source.edit.hint")}
          inputMode="url"
          placeholder={
            form().kind === "m3u"
              ? $t("source.field.guidePlaceholderM3u")
              : $t("source.field.guidePlaceholderXtream")
          }
          {...field("guide")}
        />
        <ChoiceField
          label={$t("source.field.refresh")}
          choices={REFRESH}
          hint={$t("source.change")}
          {...field("refreshHours")}
        />
        <Row width={FIELD_WIDTH} height={BUTTON_HEIGHT} gap={24} marginTop={12} scroll="none">
          <FormButton label={existing ? $t("source.save") : $t("source.saveAndImport")} onEnter={save} />
          <Show when={existing}>
            <>
              <FormButton label={$t("source.refreshNow")} onEnter={update} />
              <FormButton
                label={confirmRemove() ? $t("source.removeConfirm") : $t("source.remove")}
                width={confirmRemove() ? 360 : 300}
                danger
                onEnter={remove}
              />
            </>
          </Show>
        </Row>
        <Show when={existing}>
          {source => (
            <Row width={FIELD_WIDTH} height={BUTTON_HEIGHT} gap={24} scroll="none">
              <FormButton
                label={current()?.disabled ? $t("source.turnOn") : $t("source.turnOff")}
                onEnter={() => library.setDisabled(source().id, !current()?.disabled)}
              />
              <FormButton
                label={$t("source.moveUp")}
                dim={place().first}
                onEnter={() => library.move(source().id, -1)}
              />
              <FormButton
                label={$t("source.moveDown")}
                dim={place().last}
                onEnter={() => library.move(source().id, 1)}
              />
            </Row>
          )}
        </Show>
      </Column>

      <Text x={80} y={50} fontSize={56}>
        {existing ? $t("source.edit") : $t("source.add")}
      </Text>
      <Show when={status()}>
        {lines => (
          <Text x={80} y={128} width={1400} contain="width" maxLines={1} fontSize={26} color="#ffffffb3">
            {lines().filter(Boolean).join(". ")}
          </Text>
        )}
      </Show>
      <Text x={80} y={1010} width={FIELD_WIDTH} contain="width" fontSize={28} color="#ff8a80ff">
        {problem()}
      </Text>
    </View>
  );
};
