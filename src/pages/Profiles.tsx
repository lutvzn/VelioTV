import { useNavigate } from "@solidjs/router";
import { Text, View } from "@solidtv/solid";
import { Row } from "@solidtv/solid/primitives";
import { createSignal, For } from "solid-js";
import { Glow } from "../components/Glow";
import { ProfileBadge } from "../components/ProfileBadge";
import { profiles } from "../library";
import { askProfilePin } from "../pin";
import type { DeviceProfile } from "../sync-core/device";
import { BOLD, colors } from "../theme";
import { $t } from "../translate";

const CARD = 260;
const BADGE = 200;
const RING = 8;
const GAP = 48;

const ProfileCard = (props: { profile: DeviceProfile; current: boolean; onEnter: () => void }) => {
  const [focused, setFocused] = createSignal(false);
  const ring = BADGE + 2 * RING;
  const ringX = (CARD - ring) / 2;
  return (
    <View
      width={CARD}
      height={CARD + 80}
      onFocusChanged={setFocused}
      onEnter={() => {
        props.onEnter();
        return true;
      }}
    >
      <Glow x={ringX} width={ring} height={ring} borderRadius={ring / 2} shown={focused()} />
      <View
        x={ringX}
        width={ring}
        height={ring}
        borderRadius={ring / 2}
        color={focused() ? colors.focus : props.current ? colors.line : colors.transparent}
      />
      <View x={ringX + RING} y={RING} width={BADGE} height={BADGE} skipFocus>
        <ProfileBadge profile={props.profile} size={BADGE} />
      </View>
      <Text
        y={ring + 20}
        width={CARD}
        maxLines={1}
        contain="width"
        textAlign="center"
        fontSize={32}
        fontFamily={focused() ? BOLD : undefined}
        color={focused() ? colors.text : colors.textDim}
      >
        {props.profile.name}
      </Text>
      <Text
        y={ring + 64}
        width={CARD}
        textAlign="center"
        fontSize={22}
        color={colors.textFaint}
        alpha={props.profile.pin ? 1 : 0}
      >
        {$t("profiles.locked")}
      </Text>
    </View>
  );
};

/** The current profile's place, where the cursor starts. */
const selected = () =>
  Math.max(
    0,
    profiles.list().findIndex(profile => profile.id === profiles.currentId()),
  );

/**
 * "Who's watching?": the TV's profiles, centred in `width`. OK opens one,
 * after its PIN if it has one (SYNC-PLAN.md, step 5).
 */
export const ProfilePicker = (props: {
  width: number;
  /** Takes the focus when shown: at startup, not when opened from the menu. */
  autofocus?: boolean;
  onChosen?: () => void;
}) => {
  const choose = async (profile: DeviceProfile) => {
    if (!(await askProfilePin(profile))) return;
    profiles.choose(profile.id);
    props.onChosen?.();
  };
  const rowWidth = () => {
    const count = profiles.list().length;
    return Math.min(props.width - 160, count * CARD + Math.max(0, count - 1) * GAP);
  };
  return (
    <View width={props.width} height={1080} forwardFocus={1}>
      <Text y={260} width={props.width} contain="width" textAlign="center" fontSize={60} fontFamily={BOLD}>
        {$t("profiles.title")}
      </Text>
      <Row
        x={(props.width - rowWidth()) / 2}
        y={400}
        width={rowWidth()}
        height={CARD + 80}
        gap={GAP}
        scroll="auto"
        selected={selected()}
        autofocus={props.autofocus}
      >
        <For each={profiles.list()}>
          {profile => (
            <ProfileCard
              profile={profile}
              current={profile.id === profiles.currentId()}
              onEnter={() => void choose(profile)}
            />
          )}
        </For>
      </Row>
    </View>
  );
};

/** The menu's Profiles section: switching profile, then back to Live TV. */
export default () => {
  const navigate = useNavigate();
  return <ProfilePicker width={1920 - 96} onChosen={() => navigate("/", { replace: true })} />;
};
