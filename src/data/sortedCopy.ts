// Sorting for the import's worker.

/**
 * A sorted copy of `list`, in a stable order. A list already in order, as
 * most playlists' episodes and guides' programmes are, isn't sorted again:
 * on Samsung TVs, whose browser names no Chrome version, core-js takes it
 * for an old Safari and replaces sort() with a slower one of its own
 * (PLAN.md, Faster playlist imports). Not toSorted(), which older TVs lack.
 */
export const sortedCopy = <T>(list: readonly T[], compare: (a: T, b: T) => number): T[] => {
  const copy = list.slice();
  for (let i = 1; i < copy.length; i++) {
    if (compare(copy[i - 1], copy[i]) > 0) {
      // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array
      copy.sort(compare);
      break;
    }
  }
  return copy;
};
