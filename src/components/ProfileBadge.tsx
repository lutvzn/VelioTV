import { Text, View } from "@solidtv/solid";
import type { DeviceProfile } from "../sync-core/device";
import { PROFILE_COLORS, PROFILE_LETTER_COLOR, profileColor, profileInitial } from "../sync-core/records";
import { BOLD } from "../theme";

/**
 * A "#rrggbb" from sync-core as the renderer's 0xrrggbbaa. In the build,
 * @lightningtv/vite-hex-transform has already turned the literal into that
 * number, as it does every colour literal; in tests it's still text.
 */
const toColor = (hex: string) => {
  const value: unknown = hex;
  return typeof value === "number" ? value : Number.parseInt(hex.slice(1, 7), 16) * 256 + 0xff;
};

/** A profile's picture: its initial on its colour, as velio.tv draws it. */
export const ProfileBadge = (props: { profile: DeviceProfile; size: number }) => (
  <View
    width={props.size}
    height={props.size}
    borderRadius={props.size / 2}
    color={toColor(PROFILE_COLORS[profileColor(props.profile)]?.background ?? PROFILE_COLORS[0].background)}
    skipFocus
  >
    <Text
      width={props.size}
      height={props.size}
      lineHeight={props.size}
      contain="width"
      textAlign="center"
      fontSize={Math.round(props.size * 0.48)}
      fontFamily={BOLD}
      color={toColor(PROFILE_LETTER_COLOR)}
    >
      {profileInitial(props.profile.name)}
    </Text>
  </View>
);
