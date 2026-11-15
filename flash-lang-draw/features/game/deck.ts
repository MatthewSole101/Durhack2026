// Which word comes up next, and whether a drawing counts as that word.

import { WORDS, type Word } from "@/features/languages/words";
import { labelKey } from "@/features/quickdraw/labels";

/**
 * Endless deck of flashcard words: every word comes up once before any repeats.
 * Shuffled by default; with `shuffle = false` the words are dealt in the order given.
 */
export function createDeck(words: readonly Word[] = WORDS, shuffle = true): () => Word {
  let bag: Word[] = [];
  let last: Word | null = null;
  return () => {
    if (!bag.length) {
      bag = [...words].reverse(); // dealt from the end
      for (let i = bag.length - 1; shuffle && i > 0; i--) { // Fisher–Yates
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      if (shuffle && bag.length > 1 && bag.at(-1) === last) bag.reverse(); // no back-to-back repeat across reshuffles
    }
    return (last = bag.pop()!);
  };
}

/** The word is drawn correctly when it is the classifier's top guess (labels compared in canonical form). */
export const isCorrect = (word: Word, topGuess: string | undefined) =>
  !!topGuess && word.labels.some(label => labelKey(label) === labelKey(topGuess));
