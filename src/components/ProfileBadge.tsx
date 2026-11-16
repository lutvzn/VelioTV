import { Text, View } from "@solidtv/solid";
import { PROFILE_LETTER_COLOR, profileInitial, type DeviceProfile } from "../data/accountView";
import { BOLD } from "../theme";

/**
 * A "#rrggbb", from the account or a literal, as the renderer's 0xrrggbbaa. In the build,
 * @lightningtv/vite-hex-transform has already turned the literal into that
 * number, as it does every colour literal; the account's colours, and
 * literals in tests, are still text.
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
    color={toColor(props.profile.color)}
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
