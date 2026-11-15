// Flashcard words: simple, drawable things. Japanese is in kana (beginner-friendly).
//
// `labels` are the Quick Draw classes (features/quickdraw/labels.ts) that count as this word:
// a round is won when the classifier's top guess is one of them.

import type { LangCode } from "./languages";

/** `text`: the word in each language a learner can pick (a separate field: Indonesian's code is "id"). */
export type Word = { id: string; en: string; labels: readonly string[]; text: Record<LangCode, string> };

/** Quick Draw label → the flashcard word it counts as ("sailboat" → boat). */
const WORD_BY_LABEL = new Map<string, Word>();

/** The flashcard word a classifier label belongs to, or undefined when the dictionary has no entry. */
export const wordForLabel = (label: string): Word | undefined => WORD_BY_LABEL.get(label);

export const WORDS: Word[] = [
  { id: "sun", en: "sun", labels: ["sun"], text: { es: "el sol", ru: "солнце", pl: "słońce", id: "matahari", ja: "たいよう", ko: "해" } },
  { id: "cat", en: "cat", labels: ["cat"], text: { es: "el gato", ru: "кошка", pl: "kot", id: "kucing", ja: "ねこ", ko: "고양이" } },
  { id: "house", en: "house", labels: ["house"], text: { es: "la casa", ru: "дом", pl: "dom", id: "rumah", ja: "いえ", ko: "집" } },
  { id: "apple", en: "apple", labels: ["apple"], text: { es: "la manzana", ru: "яблоко", pl: "jabłko", id: "apel", ja: "りんご", ko: "사과" } },
  { id: "fish", en: "fish", labels: ["fish"], text: { es: "el pez", ru: "рыба", pl: "ryba", id: "ikan", ja: "さかな", ko: "물고기" } },
  { id: "star", en: "star", labels: ["star"], text: { es: "la estrella", ru: "звезда", pl: "gwiazda", id: "bintang", ja: "ほし", ko: "별" } },
  { id: "tree", en: "tree", labels: ["tree"], text: { es: "el árbol", ru: "дерево", pl: "drzewo", id: "pohon", ja: "き", ko: "나무" } },
  { id: "moon", en: "moon", labels: ["moon"], text: { es: "la luna", ru: "луна", pl: "księżyc", id: "bulan", ja: "つき", ko: "달" } },
  { id: "flower", en: "flower", labels: ["flower"], text: { es: "la flor", ru: "цветок", pl: "kwiat", id: "bunga", ja: "はな", ko: "꽃" } },
  { id: "dog", en: "dog", labels: ["dog"], text: { es: "el perro", ru: "собака", pl: "pies", id: "anjing", ja: "いぬ", ko: "개" } },
  { id: "bird", en: "bird", labels: ["bird"], text: { es: "el pájaro", ru: "птица", pl: "ptak", id: "burung", ja: "とり", ko: "새" } },
  { id: "boat", en: "boat", labels: ["sailboat", "speedboat", "cruise ship", "canoe"], text: { es: "el barco", ru: "лодка", pl: "łódź", id: "perahu", ja: "ふね", ko: "배" } },
];

for (const w of WORDS) for (const label of w.labels) WORD_BY_LABEL.set(label, w);
