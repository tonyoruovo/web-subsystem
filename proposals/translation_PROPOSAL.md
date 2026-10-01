# Translation Manager

**Type**: Featurized  
**Importance/Priority/Weight**: **HIGH** - Every user-facing string depends on it, but it is not on the failure-critical path (a missing translation degrades to the fallback key, never a crash).

The Translation Manager (i18n / localization) provides localized strings and locale-aware formatting to the UI. It resolves the active locale from the user's preference, the device, and a fallback chain; lazily loads only the catalogs the current view needs; and keeps those catalogs cached so translation works fully offline. It is a featurized subsystem: it coordinates with centralized managers (Storage, Network, Sync, Global State) but is not itself a coordination hub.

---

## States

The state object maintains the active locale, the loaded catalogs, and the formatting configuration:

### Locale State
- **localeState**:
  ```typescript
  interface LocaleState {
    activeLocale: string;        // BCP-47 tag, e.g. 'en-US'
    fallbackLocale: string;      // base language fallback, e.g. 'en'
    resolvedChain: string[];     // en-US -> en -> default, in resolution order
    direction: 'ltr' | 'rtl';    // derived from the active locale
    loading: boolean;            // a catalog fetch is in flight
  }
  ```

### Catalog Registry
- **catalogRegistry**: `Map<locale, Map<namespace, MessageCatalog>>` - loaded translation catalogs
  ```typescript
  interface MessageCatalog {
    namespace: string;
    locale: string;
    /** key -> ICU MessageFormat string */
    messages: Record<string, string>;
    /** plural categories and their variants, keyed by base key */
    plurals: Record<string, Record<'zero'|'one'|'two'|'few'|'many'|'other', string>>;
    version: number;
    loadedAt: number;
    source: 'storage' | 'network' | 'inline';
  }
  ```

### Formatting Settings
- **formattingSettings**: Per-locale formatting configuration
  ```typescript
  interface FormattingSettings {
    number: Intl.NumberFormatOptions;
    date: Intl.DateTimeFormatOptions;
    relativeTime: Intl.RelativeTimeFormatOptions;
    currency: { code: string; display: 'symbol' | 'code' | 'name' };
    list: Intl.ListFormatOptions;
  }
  ```

### Missing-Key Tracking
- **missingKeyRegistry**: `Map<string, { count: number; locales: Set<string>; lastSeen: number }>` - keys requested but not found, used to report gaps to the Logger and surface them in dev.

### Configuration
- **translationSettings**:
  ```typescript
  interface TranslationSettings {
    defaultLocale: string;
    supportedLocales: string[];
    fallbackStrategy: 'chain' | 'strict';  // strict = throw on missing key
    lazyLoading: boolean;                  // load namespaces on demand
    cacheEnabled: boolean;
    cacheMaxEntries: number;
    interpolationEscapeHtml: boolean;      // XSS protection toggle
  }
  ```

---

## Features

### Locale Manager
**Purpose**: Resolves and switches the active locale.  
**Responsibilities**:
- Resolve locale from user preference → device (`navigator.language`) → `defaultLocale`.
- Validate against `supportedLocales`; fall back through the chain.
- Derive text direction (RTL for ar/he/fa/ur/etc.).
- Broadcast `translation:locale-changed` on switch.
- **Weight**: HIGH - Correct locale is the entry point to everything else.

### Catalog Loader
**Purpose**: Lazily loads only the namespaces the current view needs.  
**Responsibilities**:
- Load catalogs from Storage (fast, offline) first; fall through to Network/Sync.
- Respect `lazyLoading` and `cacheMaxEntries`; evict least-recently-used catalogs.
- Register loaded catalogs in `catalogRegistry`.
- **Weight**: HIGH - Determines memory footprint and offline capability.

### Interpolation Engine
**Purpose**: Renders parameterized messages.  
**Responsibilities**:
- Support ICU MessageFormat (plural, select, and nested placeholders).
- Handle escaping and select/plural syntax.
- Escape HTML by default to prevent XSS via injected translation parameters.
- **Weight**: HIGH - Correctness and safety of every rendered string.

### Pluralization Engine
**Purpose**: Selects the correct plural variant.  
**Responsibilities**:
- Use `Intl.PluralRules` with CLDR categories (`zero/one/two/few/many/other`).
- Resolve `key` → plural variants from the catalog.
- Fall back to `other` when a category is missing.
- **Weight**: MEDIUM - Correctness for locale-sensitive quantity wording.

### Formatter
**Purpose**: Locale-aware formatting of scalars.  
**Responsibilities**:
- Wrap `Intl.NumberFormat`, `DateTimeFormat`, `RelativeTimeFormat`, `ListFormat`, `Collator`.
- Format currency with the correct code/display.
- **Weight**: MEDIUM - Numeric/date correctness.

### Fallback Resolver
**Purpose**: Resolves a key through the locale chain.  
**Responsibilities**:
- For a missing key in `en-US`, try `en`, then `defaultLocale`, then return the key itself (or throw in `strict` mode).
- Support per-key fallback overrides.
- **Weight**: MEDIUM - Graceful degradation is a core reliability requirement.

### Missing-Key Reporter
**Purpose**: Surfaces gaps in coverage.  
**Responsibilities**:
- Record misses in `missingKeyRegistry`.
- Emit `translation:missing-key` to the Logger (beacon/console) in dev.
- **Weight**: LOW - Observability.

### Namespace Manager
**Purpose**: Scopes keys to reduce bundle size and enable lazy loading.  
**Responsibilities**:
- Organize catalogs by namespace (e.g. `common`, `checkout`, `settings`).
- Provide `loadNamespace(ns)` and `unloadNamespace(ns)`.
- **Weight**: MEDIUM - Bundle-size and memory control.

---

## Life Cycle Manager

### Initialization Sequence
1. Read the persisted locale and catalog cache from Storage.
2. Resolve the active locale (user preference from Auth → device → default).
3. Load the `common` namespace eagerly (everything else lazily).
4. Subscribe to `global:auth-context-changed` (user locale preference) and `global:device-info` (device locale).
5. Register `translation:locale-changed`, `translation:catalog-loaded`, `translation:missing-key` events.
6. If online, request the latest catalog versions via Sync; otherwise serve cached catalogs.
7. Log initialization complete (locale + catalog count).

### Destruction Sequence
1. Flush `missingKeyRegistry` to the Logger (final report).
2. Unsubscribe from all events.
3. Persist the active locale and catalog cache metadata to Storage.
4. Clear `catalogRegistry` and `missingKeyRegistry`.
5. Log shutdown complete.

---

## Worker

**Type**: Virtual Worker (main thread) with an optional Physical Worker for catalog compilation.

The Translation Manager runs synchronously on the main thread because `t()` is called inline in render functions and templates. An async round-trip would block rendering. Catalog *loading* (fetch, parse, compile ICU messages) is the only heavy work. It can be offloaded to a Physical Worker when catalogs are large.

### Receiver
- `onLocaleChange(locale: string)` - browser/device locale change.
- `onCatalogRequest(namespace, locale)` - lazy-load request from a view.
- `onAuthContextChange(context)` - user locale preference change.

### Processor
- **Catalog Processor**: fetch → parse → compile ICU → cache.
- **Interpolation Processor**: render a message with parameters and plural/select resolution.
- **Formatting Processor**: format numbers/dates/lists via Intl.

### Dispatcher
- Emits `translation:locale-changed`, `translation:catalog-loaded`, `translation:missing-key`.
- Returns rendered strings to callers.

---

## Dependencies

Ordered by initialization priority:

1. **Global State** (HIGH) - device locale, user context, online status.
2. **Storage Manager** (HIGH) - persist locale and cached catalogs (window-scoped).
3. **Network Manager** (MEDIUM) - fetch remote catalogs.
4. **Sync Manager** (MEDIUM) - reconcile catalog versions with the server.
5. **Notification Center** (MEDIUM) - broadcast locale/catalog changes.
6. **Logger** (LOW) - report missing keys and catalog load failures.
7. **Auth Manager** (LOW) - user's preferred locale from their profile.

### Functional Predicates

```javascript
function shouldLazyLoad(namespace) {
  return translationSettings.lazyLoading && namespace !== 'common';
}

function shouldFetchFromNetwork(locale, namespace) {
  // Serve cache offline; only hit network when online and the catalog is stale
  return globalState.isOnline() && isCatalogStale(locale, namespace);
}

function resolveKey(key, locale) {
  // Walk the chain: locale -> base -> default -> key itself (or throw in strict)
  for (const loc of localeState.resolvedChain) {
    const catalog = catalogRegistry.get(loc);
    if (catalog && catalog.messages[key]) return catalog.messages[key];
  }
  reportMissingKey(key, locale);
  return translationSettings.fallbackStrategy === 'strict' ? throwMissing(key) : key;
}
```

---

## Control Interface

### Getters (No-arg)
- `getLocale(): string` - active BCP-47 locale.
- `getDirection(): 'ltr' | 'rtl'`.
- `getSupportedLocales(): string[]`.
- `getResolvedChain(): string[]`.
- `getLoadedNamespaces(): string[]`.
- `isCatalogLoaded(namespace, locale?): boolean`.

### Actions
- `t(key, params?)` - translate a key with interpolation.
- `tPlural(key, count, params?)` - translate with plural selection.
- `formatNumber(value, options?)` / `formatDate(value, options?)` / `formatRelativeTime(value, unit, options?)` / `formatList(items, options?)` / `formatCurrency(value, code?)`.
- `setLocale(locale)` - switch locale (fires `translation:locale-changed`).
- `loadNamespace(namespace)` / `unloadNamespace(namespace)`.
- `addCatalog(locale, namespace, catalog)` - register an inline catalog.
- `evictCatalog(locale?, namespace?)` - drop catalogs from memory.
- `getMissingKeys(): string[]`.

### Subscriptions
- `global:auth-context-changed` - update user locale preference.
- `global:network-status-changed` - re-enable remote catalog fetch on reconnect.
- `sync:catalog-updated` - refresh cached catalogs.

---

## Message Packets

```typescript
export type Importance = 'HIGH' | 'MEDIUM' | 'LOW';

export interface BasePacket<P, R = any> {
  eventId: symbol;
  actionName: string;
  payload: P;
  importance: Importance;
  onComplete: (result: R) => void;
  onError: (error: Error) => void;
  onLog: ((fingerprints: Fingerprint[]) => void) | null;
  fingerprints: Fingerprint[];
}

/** 1. Locale Change */
export interface LocaleChangePayload {
  oldLocale: string;
  newLocale: string;
  direction: 'ltr' | 'rtl';
  source: 'user' | 'device' | 'default';
}
export type LocaleChangePacket = BasePacket<LocaleChangePayload, void>;
// Event ID: translation:locale-changed | Importance: HIGH | Broadcast: Yes

/** 2. Catalog Load */
export interface CatalogLoadPayload {
  locale: string;
  namespace: string;
  version: number;
}
export interface CatalogLoadResult {
  catalog: MessageCatalog;
  source: 'storage' | 'network' | 'inline';
}
export type CatalogLoadPacket = BasePacket<CatalogLoadPayload, CatalogLoadResult>;
// Event ID: translation:catalog-load | Importance: MEDIUM | Broadcast: No

/** 3. Translation Request */
export interface TranslationRequestPayload {
  key: string;
  locale: string;
  params?: Record<string, unknown>;
  count?: number;
}
export interface TranslationRequestResult {
  value: string;
  resolvedFrom: string; // which locale in the chain actually provided it
}
export type TranslationRequestPacket = BasePacket<TranslationRequestPayload, TranslationRequestResult>;
// Event ID: translation:request | Importance: LOW | Broadcast: No

/** 4. Missing Key Report */
export interface MissingKeyPayload {
  key: string;
  locale: string;
  namespace: string;
  timestamp: number;
}
export type MissingKeyPacket = BasePacket<MissingKeyPayload, void>;
// Event ID: translation:missing-key | Importance: LOW | Broadcast: Yes (Logger)

export type TranslationPacket =
  | LocaleChangePacket
  | CatalogLoadPacket
  | TranslationRequestPacket
  | MissingKeyPacket;
```

---

## Special Considerations

### 1. Memory & bundle size
- **Lazy namespaces**: only `common` loads eagerly; view-specific namespaces load on demand and evict LRU.
- **Tree-shaking**: namespace-scoped keys let a build drop catalogs a route never touches.

### 2. Offline capability
- Catalogs are window-scoped: cached in Storage, so translation works with no network. Remote catalog updates flow through Sync and refresh the cache.

### 3. Plural & gender correctness
- Use `Intl.PluralRules` (CLDR categories), never hard-coded `n === 1` checks. Fall back to `other` when a category is missing.

### 4. RTL
- `direction` is derived from the locale and drives layout mirroring via a reactive binding, not CSS class hacks.

### 5. Interpolation safety
- Parameters are HTML-escaped by default; raw insertion is an explicit opt-in. Prevents XSS through user-supplied interpolation values.

### 6. Message format
- Use ICU MessageFormat. It supports plural and select. There is no placeholder-style alternative.

### 7. Scope note (behavioral)
- The catalogs themselves are **window-scoped** (cached locally, shared across tabs), but their *source of truth* is **global** (remote catalogs fetched via Network/Sync). This is a concrete illustration of scope being an emergent property of behavior. The manager has no `scope` field. Its `loadNamespace()`/`sync` surface determines where its state lives.

---

## Summary

The Translation Manager provides offline-capable, lazy-loaded, locale-aware localization with plural/RTL/number/date support. It depends on the centralized managers (Storage for caching, Network/Sync for catalog freshness, Global State for locale resolution, Logger for gap reporting) but is itself featurized. Its reliability guarantee is graceful degradation. A missing translation falls back through the locale chain to the key itself. It never crashes.
