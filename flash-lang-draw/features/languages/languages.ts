// Languages a learner can pick on the start screen.
// `tag` matches the short tag on the start-screen doodle cards.

export const LANGUAGES = [
  { code: "es", tag: "ES", name: "Español", english: "Spanish" },
  { code: "ru", tag: "RU", name: "Русский", english: "Russian" },
  { code: "pl", tag: "PL", name: "Polski", english: "Polish" },
  { code: "id", tag: "ID", name: "Bahasa Indonesia", english: "Indonesian" },
  { code: "ja", tag: "JA", name: "日本語", english: "Japanese" },
  { code: "ko", tag: "KO", name: "한국어", english: "Korean" },
] as const;

export type Language = (typeof LANGUAGES)[number];
export type LangCode = Language["code"];

export const languageByCode = (code: LangCode): Language => LANGUAGES.find(l => l.code === code)!;
