export const supportedLocales = ["en", "ja"] as const;

export type Locale = (typeof supportedLocales)[number];

export function normalizeLocale(value: unknown): Locale {
  return value === "ja" ? "ja" : "en";
}

export function localized<T>(locale: Locale, values: { en: T; ja: T }): T {
  return values[locale];
}
