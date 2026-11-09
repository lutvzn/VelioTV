import { View } from "@solidtv/solid";
import { edits } from "../library";
import { colors } from "../theme";

export const FAVOURITE_COLOR = colors.gold;

/**
 * The gold dot by a favourite channel's name (Noto Sans has no star). `y` is
 * the line's middle.
 */
export const FavouriteDot = (props: { channelId: string; x: number; y: number; size?: number }) => {
  const size = () => props.size ?? 12;
  return (
    <View
      x={props.x}
      y={props.y - size() / 2}
      width={size()}
      height={size()}
      borderRadius={size() / 2}
      color={FAVOURITE_COLOR}
      alpha={edits.isFavourite(props.channelId) ? 1 : 0}
    />
  );
};
