import { useNavigate } from "@solidjs/router";
import { activeElement, type ElementNode, Text, View } from "@solidtv/solid";
import { Show } from "solid-js";
import { sync } from "../library";
import { OVERLAY_Z } from "../pages/live/ChannelOptions";
import { BOLD, colors, dialogShadow, radius } from "../theme";
import { $t } from "../translate";
import { setSettingsCategory } from "../pages/settings/category";

const WIDTH = 860;
const HEIGHT = 250;

const Notice = () => {
  const navigate = useNavigate();
  const before: ElementNode | undefined = activeElement();
  return (
    <View
      autofocus
      zIndex={OVERLAY_Z + 1}
      x={(1920 - WIDTH) / 2}
      y={80}
      width={WIDTH}
      height={HEIGHT}
      borderRadius={radius.xlarge}
      color={colors.dialog}
      border={{ width: 2, color: colors.line }}
      shadow={dialogShadow}
      onEnter={() => {
        sync.dismissNotice();
        setSettingsCategory("account");
        navigate("/settings", { replace: true });
        return true;
      }}
      onBack={() => {
        sync.dismissNotice();
        before?.setFocus();
        return true;
      }}
      // Every other key stops here.
      onKeyPress={() => true}
    >
      <Text x={40} y={36} width={WIDTH - 80} maxLines={1} contain="width" fontSize={38} fontFamily={BOLD}>
        {$t("account.removedTitle")}
      </Text>
      <Text
        x={40}
        y={96}
        width={WIDTH - 80}
        maxLines={2}
        contain="width"
        fontSize={26}
        color={colors.textDim}
      >
        {$t("account.removedText")}
      </Text>
      <Text
        x={40}
        y={186}
        width={WIDTH - 80}
        maxLines={1}
        contain="width"
        fontSize={24}
        color={colors.accentText}
      >
        {$t("account.removedHint")}
      </Text>
    </View>
  );
};

/**
 * Shown once after the account signed this TV out: it was removed, or the
 * account was reset, deleted or closed (SYNC-PLAN.md, step 7). OK goes to
 * Settings to sign in again; Back closes it.
 */
export const SignedOutNotice = () => (
  <Show when={sync.signedOutNotice()}>
    <Notice />
  </Show>
);
