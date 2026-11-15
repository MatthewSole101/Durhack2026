// Flashcard words: simple, drawable things. Japanese is in kana (beginner-friendly).
//
// `labels` are the Quick Draw classes (features/quickdraw/labels.ts) that count as this word:
// a round is won when the classifier's top guess is one of them.

import type { LangCode } from "./languages";

export type Word = { id: string; en: string; labels: readonly string[] } & Record<LangCode, string>;

/** Quick Draw label → the flashcard word it counts as ("sailboat" → boat). */
const WORD_BY_LABEL = new Map<string, Word>();

/** The flashcard word a classifier label belongs to, or undefined when the dictionary has no entry. */
export const wordForLabel = (label: string): Word | undefined => WORD_BY_LABEL.get(label);

export const WORDS: Word[] = [
  { id: "sun", en: "sun", labels: ["sun"], es: "el sol", fr: "le soleil", de: "die Sonne", it: "il sole", pt: "o sol", ja: "たいよう", ko: "해" },
  { id: "cat", en: "cat", labels: ["cat"], es: "el gato", fr: "le chat", de: "die Katze", it: "il gatto", pt: "o gato", ja: "ねこ", ko: "고양이" },
  { id: "house", en: "house", labels: ["house"], es: "la casa", fr: "la maison", de: "das Haus", it: "la casa", pt: "a casa", ja: "いえ", ko: "집" },
  { id: "apple", en: "apple", labels: ["apple"], es: "la manzana", fr: "la pomme", de: "der Apfel", it: "la mela", pt: "a maçã", ja: "りんご", ko: "사과" },
  { id: "fish", en: "fish", labels: ["fish"], es: "el pez", fr: "le poisson", de: "der Fisch", it: "il pesce", pt: "o peixe", ja: "さかな", ko: "물고기" },
  { id: "star", en: "star", labels: ["star"], es: "la estrella", fr: "l'étoile", de: "der Stern", it: "la stella", pt: "a estrela", ja: "ほし", ko: "별" },
  { id: "tree", en: "tree", labels: ["tree"], es: "el árbol", fr: "l'arbre", de: "der Baum", it: "l'albero", pt: "a árvore", ja: "き", ko: "나무" },
  { id: "moon", en: "moon", labels: ["moon"], es: "la luna", fr: "la lune", de: "der Mond", it: "la luna", pt: "a lua", ja: "つき", ko: "달" },
  { id: "flower", en: "flower", labels: ["flower"], es: "la flor", fr: "la fleur", de: "die Blume", it: "il fiore", pt: "a flor", ja: "はな", ko: "꽃" },
  { id: "dog", en: "dog", labels: ["dog"], es: "el perro", fr: "le chien", de: "der Hund", it: "il cane", pt: "o cão", ja: "いぬ", ko: "개" },
  { id: "bird", en: "bird", labels: ["bird"], es: "el pájaro", fr: "l'oiseau", de: "der Vogel", it: "l'uccello", pt: "o pássaro", ja: "とり", ko: "새" },
  { id: "boat", en: "boat", labels: ["sailboat", "speedboat", "cruise ship", "canoe"], es: "el barco", fr: "le bateau", de: "das Boot", it: "la barca", pt: "o barco", ja: "ふね", ko: "배" },
];

for (const w of WORDS) for (const label of w.labels) WORD_BY_LABEL.set(label, w);
