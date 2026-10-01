import { anyNil, isNil } from '@/libs';
import type { CanonicalKey, ICanonicalKeySegments, UnderlyingPlatform } from './storage.types';

const PLATFORMS = new Set<UnderlyingPlatform>([
  'android',
  'ios',
  'win',
  'unix',
  'mac',
  'safari',
  'chrome',
  'edge',
  'firefox',
  'opera',
  'browser',
  'iot',
]);

const SEP = ':';

/**
 * Build a canonical key string from its constituent segments.
 *
 * Format: `<domain>:<platform>:<platform-version>:<calling-module>:<actual-key>`
 *
 * Validates that:
 * - No segment is empty.
 * - `platform` is one of the known values.
 * - `platformVersion` is a positive integer.
 * - No segment (except `actualKey`) contains the separator character.
 */
export function buildCanonicalKey(segments: ICanonicalKeySegments): CanonicalKey {
  const { domain, platform, platformVersion, callingModule, actualKey } = segments;

  if (!domain) throw new Error('[CanonicalKey] "domain" must not be empty.');
  if (!platform) throw new Error('[CanonicalKey] "platform" must not be empty.');
  if (!callingModule) throw new Error('[CanonicalKey] "callingModule" must not be empty.');
  if (!actualKey) throw new Error('[CanonicalKey] "actualKey" must not be empty.');

  if (!PLATFORMS.has(platform)) {
    throw new Error(`[CanonicalKey] Unknown platform "${platform}".`);
  }
  if (!Number.isInteger(platformVersion) || platformVersion < 0) {
    throw new Error(
      `[CanonicalKey] "platformVersion" must be a non-negative integer, got ${platformVersion}.`,
    );
  }

  for (const [name, val] of [
    ['domain', domain],
    ['callingModule', callingModule],
  ] as const) {
    if (val.includes(SEP)) {
      throw new Error(
        `[CanonicalKey] Segment "${name}" must not contain the separator character "${SEP}". ` +
          `Got: "${val}"`,
      );
    }
  }

  return `${domain}${SEP}${platform}${SEP}${platformVersion}${SEP}${callingModule}${SEP}${actualKey}` as CanonicalKey;
}

/**
 * Parse a canonical key string back into its typed segments.
 * Returns `null` if the string does not conform to the expected format.
 */
export function parseCanonicalKey(key: string): ICanonicalKeySegments | null {
  // Split on the first 4 occurrences of SEP only - actualKey may contain colons
  const parts = key.split(SEP);
  if (parts.length < 5) return null;

  const [domain, platform, platformVersionStr, callingModule, ...rest] = parts;
  const actualKey = rest.join(SEP); // rejoin in case actualKey contained ':'

  if (!domain || !platform || !platformVersionStr || !callingModule || !actualKey) return null;
  if (!PLATFORMS.has(platform as UnderlyingPlatform)) return null;

  const platformVersion = Number(platformVersionStr);
  if (!Number.isInteger(platformVersion) || platformVersion < 0) return null;

  return {
    domain,
    platform: platform as UnderlyingPlatform,
    platformVersion,
    callingModule,
    actualKey,
  };
}

/**
 * Build a prefix string for querying all keys within a given module scope.
 * e.g. `"myapp:chrome:130:auth-module:"` matches every key that module wrote.
 */
export function buildModulePrefix(path: ICanonicalKeySegments): string;
/**
 * Build a prefix string for querying all keys within a given module scope.
 * e.g. `"myapp:chrome:130:auth-module:"` matches every key that module wrote.
 */
export function buildModulePrefix(
  domain: string,
  platform: UnderlyingPlatform,
  platformVersion: number,
  callingModule: string,
): string;
export function buildModulePrefix(...args: unknown[]): string {
  const [domain, platform, platformVersion, callingModule] = args;
  if (isNil(domain)) return '';
  else if (typeof domain === 'object' && 'domain' in domain) {
    const { domain, platform, platformVersion, callingModule } = args[0] as ICanonicalKeySegments;
    return `${domain}${SEP}${platform}${SEP}${platformVersion}${SEP}${callingModule}${SEP}`;
  } else if (anyNil(platform, platformVersion, callingModule)) {
    return '';
  }
  return `${domain}${SEP}${platform}${SEP}${platformVersion}${SEP}${callingModule}${SEP}`;
}
