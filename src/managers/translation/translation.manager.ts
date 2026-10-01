/**
 * @fileoverview
 * @summary The Translation manager: locale-aware string and plural rendering.
 * @description
 * Implements the localization core of M4. It holds message catalogs per locale
 * and namespace, resolves keys through a fallback chain, interpolates
 * `{placeholder}` values, and selects plural variants with `Intl.PluralRules`.
 * Missing keys fall back to the key itself and are reported, never throwing.
 *
 * ```text
 *   t(key, params)     -> locale -> base -> default -> interpolate
 *   tPlural(key, n, p) -> Intl.PluralRules.select(n) -> variant -> interpolate
 *   setLocale('ar')    -> direction rtl
 *   ```
 *
 * Catalogs are added per locale and namespace, so a view can lazy-load only
 * what it needs.
 *
 * @author MathAid
 */

/**
 * @summary Text direction.
 */
export type TextDirection = 'ltr' | 'rtl';

/**
 * @summary A plural category.
 */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/**
 * @summary A message catalog for one locale and namespace.
 */
export interface MessageCatalog {
  /** The locale. */
  locale: string;
  /** The namespace. */
  namespace: string;
  /** Key to message, with `{placeholder}` slots. */
  messages: Record<string, string>;
  /** Key to plural variants. Missing categories fall back to `other`. */
  plurals?: Record<string, Partial<Record<PluralCategory, string>>>;
}

/**
 * @summary Locales that read right to left.
 */
const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'dv', 'sd', 'ug', 'yi']);

/**
 * @summary Options for constructing a {@linkcode TranslationManager}.
 */
export interface TranslationManagerOptions {
  /** The default locale. Defaults to `en`. */
  defaultLocale?: string;
  /** The base fallback locale. Defaults to `en`. */
  fallbackLocale?: string;
  /** Optional missing-key sink. */
  onMissingKey?: (key: string, locale: string) => void;
}

/**
 * @summary The Translation manager.
 * @description
 * One instance per realm. A missing translation falls back through the locale
 * chain to the key itself. It never crashes.
 *
 * @example
 * Example 1: Add a catalog and translate
 * ```ts
 * const i18n = new TranslationManager();
 * i18n.addCatalog('en', 'common', { locale: 'en', namespace: 'common', messages: { hello: 'Hello, {name}!' } });
 * i18n.t('hello', { name: 'Alice' }); // "Hello, Alice!"
 * ```
 */
export class TranslationManager {
  /** @internal The active locale. */
  private activeLocale: string;

  /** @internal The fallback locale. */
  private readonly fallbackLocale: string;

  /** @internal locale to namespace to catalog. */
  private readonly catalogs = new Map<string, Map<string, MessageCatalog>>();

  /** @internal key to missing-key record. */
  private readonly missingKeys = new Map<string, { count: number; locales: Set<string> }>();

  /** @internal The missing-key sink. */
  private readonly onMissingKey?: (key: string, locale: string) => void;

  /**
   * @summary Creates a TranslationManager.
   * @param {TranslationManagerOptions} [options] The configuration.
   */
  constructor(options: TranslationManagerOptions = {}) {
    this.activeLocale = options.defaultLocale ?? 'en';
    this.fallbackLocale = options.fallbackLocale ?? 'en';
    this.onMissingKey = options.onMissingKey;
  }

  /**
   * @summary Sets the active locale.
   * @param {string} locale The BCP-47 locale, for example `en-US`.
   * @returns {void}
   */
  setLocale(locale: string): void {
    this.activeLocale = locale;
  }

  /**
   * @summary The active locale.
   * @returns {string} The locale.
   */
  getLocale(): string {
    return this.activeLocale;
  }

  /**
   * @summary The text direction for the active locale.
   * @returns {TextDirection} `rtl` for right-to-left locales, else `ltr`.
   */
  getDirection(): TextDirection {
    const base = this.baseOf(this.activeLocale);
    return RTL_LOCALES.has(base) ? 'rtl' : 'ltr';
  }

  /**
   * @summary Registers a catalog.
   * @param {string} locale The locale.
   * @param {string} namespace The namespace.
   * @param {MessageCatalog} catalog The catalog.
   * @returns {void}
   */
  addCatalog(locale: string, namespace: string, catalog: MessageCatalog): void {
    if (!this.catalogs.has(locale)) this.catalogs.set(locale, new Map());
    this.catalogs.get(locale)!.set(namespace, catalog);
  }

  /**
   * @summary Translates a key, interpolating placeholders.
   * @description
   * Resolves the key through `locale`, then the base language, then the
   * fallback locale. A missing key returns the key itself and reports it.
   *
   * @param {string} key The key.
   * @param {Record<string, unknown>} [params] Interpolation values.
   * @returns {string} The rendered string.
   */
  t(key: string, params: Record<string, unknown> = {}): string {
    const message = this.resolveMessage(key);
    if (message === null) {
      this.reportMissing(key);
      return key;
    }
    return interpolate(message, params);
  }

  /**
   * @summary Translates a key with plural selection.
   * @param {string} key The key.
   * @param {number} count The count that drives plural selection.
   * @param {Record<string, unknown>} [params] Interpolation values.
   * @returns {string} The rendered string.
   */
  tPlural(key: string, count: number, params: Record<string, unknown> = {}): string {
    const variants = this.resolvePlural(key);
    if (!variants) {
      this.reportMissing(key);
      return key;
    }

    const rule = new Intl.PluralRules(this.activeLocale);
    const category = rule.select(count) as PluralCategory;
    const message = variants[category] ?? variants.other ?? key;

    return interpolate(message, { count, ...params });
  }

  /**
   * @summary The missing keys, in request order.
   * @returns {string[]} The keys.
   */
  getMissingKeys(): string[] {
    return [...this.missingKeys.keys()];
  }

  /**
   * @summary Resolves a message through the fallback chain.
   * @param {string} key The key.
   * @returns {string | null} The message, or `null` when missing.
   * @internal
   */
  private resolveMessage(key: string): string | null {
    for (const locale of this.chain()) {
      for (const catalog of this.catalogs.get(locale)?.values() ?? []) {
        if (catalog.messages[key] !== undefined) return catalog.messages[key];
      }
    }
    return null;
  }

  /**
   * @summary Resolves plural variants through the fallback chain.
   * @param {string} key The key.
   * @returns {Partial<Record<PluralCategory, string>> | null} The variants, or `null`.
   * @internal
   */
  private resolvePlural(key: string): Partial<Record<PluralCategory, string>> | null {
    for (const locale of this.chain()) {
      for (const catalog of this.catalogs.get(locale)?.values() ?? []) {
        if (catalog.plurals?.[key]) return catalog.plurals[key];
      }
    }
    return null;
  }

  /**
   * @summary The locale fallback chain, active first.
   * @returns {string[]} The chain.
   * @internal
   */
  private chain(): string[] {
    const base = this.baseOf(this.activeLocale);
    const chain = [this.activeLocale];
    if (base !== this.activeLocale) chain.push(base);
    if (base !== this.fallbackLocale) chain.push(this.fallbackLocale);
    return chain;
  }

  /**
   * @summary The base language of a locale.
   * @param {string} locale The locale.
   * @returns {string} The base, for example `en` from `en-US`.
   * @internal
   */
  private baseOf(locale: string): string {
    return locale.split('-')[0];
  }

  /**
   * @summary Records a missing key.
   * @param {string} key The key.
   * @returns {void}
   * @internal
   */
  private reportMissing(key: string): void {
    const record = this.missingKeys.get(key) ?? { count: 0, locales: new Set<string>() };
    record.count += 1;
    record.locales.add(this.activeLocale);
    this.missingKeys.set(key, record);
    this.onMissingKey?.(key, this.activeLocale);
  }
}

/**
 * @summary Interpolates `{placeholder}` values into a message.
 * @param {string} message The message.
 * @param {Record<string, unknown>} params The values.
 * @returns {string} The interpolated string.
 * @internal
 */
function interpolate(message: string, params: Record<string, unknown>): string {
  return message.replace(/\{(\w+)\}/g, (_, name: string) =>
    params[name] === undefined ? `{${name}}` : String(params[name]),
  );
}
