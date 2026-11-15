// The "Hint?" box under the flashcard: a few letters of the word's English, the rest starred out
// ("word" → "w**d"). Which letters are shown is random, so asking again on a later round differs.

const isLetter = (c: string) => /\p{L}/u.test(c);

/** How many letters a hint gives away: 2–3 depending on length, and only 1 of a very short word. */
export const hintLetters = (letters: number) => (letters <= 3 ? 1 : letters <= 6 ? 2 : 3);

/** `word` with all but a few randomly chosen letters replaced by "*". Spaces and hyphens are kept. */
export function maskWord(word: string, random: () => number = Math.random): string {
  const chars = [...word];
  const letters = chars.flatMap((c, i) => (isLetter(c) ? [i] : []));
  // partial shuffle: the first `n` entries end up being a random pick without repeats
  const n = Math.min(hintLetters(letters.length), letters.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.min(Math.floor(random() * (letters.length - i)), letters.length - i - 1);
    [letters[i], letters[j]] = [letters[j], letters[i]];
  }
  const shown = new Set(letters.slice(0, n));
  return chars.map((c, i) => (!isLetter(c) || shown.has(i) ? c : "*")).join("");
}
