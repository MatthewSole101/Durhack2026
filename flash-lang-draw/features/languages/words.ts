// Flashcard words: simple, drawable things. Japanese is in kana (beginner-friendly).

import type { LangCode } from "./languages";

export type Word = { id: string; en: string } & Record<LangCode, string>;

export const WORDS: Word[] = [
  { id: "sun", en: "sun", es: "el sol", fr: "le soleil", de: "die Sonne", it: "il sole", pt: "o sol", ja: "たいよう", ko: "해" },
  { id: "cat", en: "cat", es: "el gato", fr: "le chat", de: "die Katze", it: "il gatto", pt: "o gato", ja: "ねこ", ko: "고양이" },
  { id: "house", en: "house", es: "la casa", fr: "la maison", de: "das Haus", it: "la casa", pt: "a casa", ja: "いえ", ko: "집" },
  { id: "apple", en: "apple", es: "la manzana", fr: "la pomme", de: "der Apfel", it: "la mela", pt: "a maçã", ja: "りんご", ko: "사과" },
  { id: "fish", en: "fish", es: "el pez", fr: "le poisson", de: "der Fisch", it: "il pesce", pt: "o peixe", ja: "さかな", ko: "물고기" },
  { id: "star", en: "star", es: "la estrella", fr: "l'étoile", de: "der Stern", it: "la stella", pt: "a estrela", ja: "ほし", ko: "별" },
  { id: "tree", en: "tree", es: "el árbol", fr: "l'arbre", de: "der Baum", it: "l'albero", pt: "a árvore", ja: "き", ko: "나무" },
  { id: "moon", en: "moon", es: "la luna", fr: "la lune", de: "der Mond", it: "la luna", pt: "a lua", ja: "つき", ko: "달" },
  { id: "flower", en: "flower", es: "la flor", fr: "la fleur", de: "die Blume", it: "il fiore", pt: "a flor", ja: "はな", ko: "꽃" },
  { id: "dog", en: "dog", es: "el perro", fr: "le chien", de: "der Hund", it: "il cane", pt: "o cão", ja: "いぬ", ko: "개" },
  { id: "bird", en: "bird", es: "el pájaro", fr: "l'oiseau", de: "der Vogel", it: "l'uccello", pt: "o pássaro", ja: "とり", ko: "새" },
  { id: "boat", en: "boat", es: "el barco", fr: "le bateau", de: "das Boot", it: "la barca", pt: "o barco", ja: "ふね", ko: "배" },
];

export const randomWord = (): Word => WORDS[Math.floor(Math.random() * WORDS.length)];
