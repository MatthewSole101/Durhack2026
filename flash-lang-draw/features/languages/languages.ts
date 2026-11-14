// Languages a learner can pick on the start screen.
// `tag` matches the short tag on the start-screen doodle cards.

export const LANGUAGES = [
  { code: "es", tag: "ES", name: "Español", english: "Spanish" },
  { code: "fr", tag: "FR", name: "Français", english: "French" },
  { code: "de", tag: "DE", name: "Deutsch", english: "German" },
  { code: "it", tag: "IT", name: "Italiano", english: "Italian" },
  { code: "pt", tag: "PT", name: "Português", english: "Portuguese" },
  { code: "ja", tag: "JA", name: "日本語", english: "Japanese" },
  { code: "ko", tag: "KO", name: "한국어", english: "Korean" },
] as const;

export type Language = (typeof LANGUAGES)[number];
export type LangCode = Language["code"];

export const DEFAULT_LANG: LangCode = "es";

export const languageByCode = (code: LangCode): Language => LANGUAGES.find(l => l.code === code)!;
