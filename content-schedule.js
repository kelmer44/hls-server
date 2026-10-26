export const availableContentChunks = 48;

function positiveInteger(value, fallback, name, maximum = Number.MAX_SAFE_INTEGER - 2) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (typeof value === "boolean" || !Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return number;
}

export function createContentSchedule({ maxUsableChunks, chunksBetweenAdBreaks } = {}) {
  const chunkCount = positiveInteger(maxUsableChunks, 6, "maxUsableChunks", availableContentChunks);
  const contentPerBreak = positiveInteger(chunksBetweenAdBreaks, 3, "chunksBetweenAdBreaks");
  const breakInterval = contentPerBreak + 2;

  return {
    maxUsableChunks: chunkCount,
    chunksBetweenAdBreaks: contentPerBreak,
    itemForSequence(sequence) {
      const ordinal = Math.floor(sequence / breakInterval);
      const position = sequence % breakInterval;
      if (position >= contentPerBreak) {
        const adBreakPosition = position - contentPerBreak;
        return { type: "broadcast-ad", file: `broadcast-ad-${adBreakPosition + 1}.ts`, adBreakPosition };
      }
      const contentIndex = ordinal * contentPerBreak + position;
      return { type: "content", file: `content-${contentIndex % chunkCount + 1}.ts` };
    },
    adBreakOrdinal(startSequence) {
      return Math.floor(startSequence / breakInterval);
    }
  };
}
