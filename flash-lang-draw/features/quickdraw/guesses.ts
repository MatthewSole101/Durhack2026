// Post-processing: the one place where the model's raw output becomes the guesses the game uses
// (the win check, the "You drew…" feed and the debug panel all read this same list).
//
// The model has 345 classes; the game only knows the flashcard words (features/languages/words.ts).
// Output index i still means labels[i] — labels.txt is never filtered or reordered — but classes
// that are not flashcard words are dropped *before* ranking, and what is left is re-normalised:
//
//   validMass = Σ probs[i] over the flashcard classes
//   prob      = probs[i] / validMass            (so the surviving guesses sum to 1)
//
// then sorted, best first, and cut to the top k.

import { wordForLabel, WORDS, type Word } from "@/features/languages/words";
import { TOP_K } from "./constants";

/**
 * One guess: a model class that is a flashcard word.
 * `label` is the class name exactly as the model's label list has it; `word` is the flashcard
 * entry it resolved to, attached here so nothing downstream has to look it up again (or miss).
 * `prob` is the share of the flashcard classes' probability, not of all 345.
 */
export type Guess = { label: string; prob: number; word: Word };

/** Raw class probabilities (in label order) → the top `k` flashcard guesses, best first. */
export type Ranker = (probs: ArrayLike<number>, k?: number) => Guess[];

/**
 * Build the ranker for a label list. Which output indices are flashcard words is resolved once,
 * here, through the same canonical lookup the translations use (wordForLabel), so a label that
 * differs only in case, spacing or underscores still finds its word.
 */
export function createRanker(labels: readonly string[]): Ranker {
  const kept = labels.flatMap((label, index) => {
    const word = wordForLabel(label);
    return word ? [{ index, label, word }] : [];
  });

  if (process.env.NODE_ENV !== "production") {
    // a flashcard word with no class in the label list can be dealt but never guessed or won
    const found = new Set(kept.map(c => c.word));
    const missing = WORDS.filter(w => !found.has(w));
    if (missing.length) console.warn(`Quick Draw: no model class for the flashcard word(s): ${missing.map(w => w.id).join(", ")}`);
  }

  return (probs, k = TOP_K) => {
    let validMass = 0;
    for (const c of kept) validMass += probs[c.index] || 0;
    if (!(validMass > 0)) return []; // nothing (or NaN) on any flashcard class: there is no guess to make
    return kept
      .map(c => ({ label: c.label, prob: (probs[c.index] || 0) / validMass, word: c.word }))
      .sort((a, b) => b.prob - a.prob)
      .slice(0, k);
  };
}
