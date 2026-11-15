// Languages a learner can pick on the start screen.
// `code` is the BCP 47 tag (also used for the `lang` attribute and as the key into a word's
// translations); `tag` matches the short tag on the start-screen doodle cards.

export const LANGUAGES = [
  { code: "es", tag: "ES", name: "Español", english: "Spanish" },
  { code: "uk", tag: "UA", name: "Українська", english: "Ukrainian" },
  { code: "pl", tag: "PL", name: "Polski", english: "Polish" },
  { code: "id", tag: "ID", name: "Bahasa Indonesia", english: "Indonesian" },
  { code: "te", tag: "TE", name: "తెలుగు", english: "Telugu" },
  { code: "yo", tag: "YO", name: "Yorùbá", english: "Yoruba" },
  { code: "ja", tag: "JA", name: "日本語", english: "Japanese" },
] as const;

export type Language = (typeof LANGUAGES)[number];
export type LangCode = Language["code"];

export const languageByCode = (code: LangCode): Language => LANGUAGES.find(l => l.code === code)!;
