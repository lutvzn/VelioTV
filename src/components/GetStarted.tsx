import { useNavigate } from "@solidjs/router";
import { type ElementNode, View } from "@solidtv/solid";
import { Row } from "@solidtv/solid/primitives";
import { Show } from "solid-js";
import { type StartPlace } from "../emptySection";
import { sync } from "../library";
import { openSettingsFor } from "../pages/settings/category";
import { $t } from "../translate";
import { BUTTON_HEIGHT, FormButton } from "./Form";

const SIGN_IN_WIDTH = 420;
const ADD_WIDTH = 380;

/**
 * Ways to get started on a section with nothing in it (Live, Movies,
 * Series): signing in to the account with a phone, unless the TV is signed
 * in already, and adding an IPTV playlist on the TV. Each opens Settings on
 * it, with the keys there. The app draws it beside the page, so Left at the
 * first button and Back go to the menu.
 */
export const GetStarted = (props: { place: StartPlace; ref?: (node: ElementNode) => void }) => {
  const navigate = useNavigate();
  const open = (action: "signIn" | "addSource") => {
    openSettingsFor(action);
    navigate("/settings", { replace: true });
  };
  const width = () => (sync.signedIn() ? ADD_WIDTH : SIGN_IN_WIDTH + 24 + ADD_WIDTH);
  return (
    <View
      ref={props.ref}
      x={props.place.x}
      y={props.place.y}
      width={width()}
      height={BUTTON_HEIGHT}
      forwardFocus={0}
    >
      <Row width={width()} height={BUTTON_HEIGHT} gap={24} scroll="none">
        <Show when={!sync.signedIn()}>
          <FormButton label={$t("account.signIn")} width={SIGN_IN_WIDTH} onEnter={() => open("signIn")} />
        </Show>
        <FormButton label={$t("start.addPlaylist")} width={ADD_WIDTH} onEnter={() => open("addSource")} />
      </Row>
    </View>
  );
};
