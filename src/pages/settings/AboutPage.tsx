import { Text, View } from "@solidtv/solid";
import { createSignal, type JSX, Show } from "solid-js";
import { FIELD_WIDTH } from "../../components/Form";
import { tmdbOn } from "../../library";
import { colors, radius } from "../../theme";
import { $t } from "../../translate";
import { SubPage } from "./SubPage";

const TEXT_WIDTH = FIELD_WIDTH - 64;

/** A panel of text that takes the focus, so Up and Down move between them and the voice guide reads each. */
const Panel = (props: { height: number; announce: string; children: JSX.Element }) => {
  const [focused, setFocused] = createSignal(false);
  return (
    <View
      width={FIELD_WIDTH}
      height={props.height}
      borderRadius={radius.medium}
      color={colors.panel}
      border={{ width: focused() ? 3 : 0, color: colors.focus }}
      announce={props.announce}
      onFocusChanged={setFocused}
    >
      {props.children}
    </View>
  );
};

/**
 * Where films' and series' details come from, with TMDB's logo and notice,
 * which its terms ask for in an About or Credits page (PLAN.md, "Movies and
 * Series by title").
 */
export const AboutPage = (props: { onClose: () => void }) => (
  <SubPage title={$t("about.title")} intro={$t("about.intro")} onClose={props.onClose}>
    <Panel height={170} announce={$t("about.sources")}>
      <Text x={32} y={28} width={TEXT_WIDTH} contain="width" maxLines={3} lineHeight={40} fontSize={28}>
        {$t("about.sources")}
      </Text>
    </Panel>
    <Show when={tmdbOn()}>
      <Panel height={190} announce={`TMDB. ${$t("about.tmdb")}`}>
        <View x={32} y={32} width={303} height={40} src="assets/credits/tmdb.png" />
        <Text
          x={32}
          y={96}
          width={TEXT_WIDTH}
          contain="width"
          maxLines={2}
          lineHeight={38}
          fontSize={26}
          color={colors.textDim}
        >
          {$t("about.tmdb")}
        </Text>
      </Panel>
    </Show>
  </SubPage>
);
