import type { DurationRecord } from '@/types';

export const MS_IN_SEC = 1000;
export const SEC_IN_MIN = 60;
export const MIN_IN_HOUR = 60;
export const HOUR_IN_DAY = 24;
export const DAY_IN_WEEK = 7;
export const AVG_DAYS_IN_MONTH = 30.44;
export const AVG_DAYS_IN_YEAR = 365.25;

export const MIN_IN_DAY = MIN_IN_HOUR * HOUR_IN_DAY;
export const SEC_IN_DAY = SEC_IN_MIN * MIN_IN_DAY;
export const MS_IN_DAY = MS_IN_SEC * SEC_IN_DAY;
export const MS_IN_MONTH = MS_IN_DAY * AVG_DAYS_IN_MONTH;
export const MS_IN_YEAR = MS_IN_DAY * AVG_DAYS_IN_YEAR;

// Canonical unit order, most-significant -> least-significant.
export const UNITS: ReadonlyArray<keyof DurationRecord> = [
  'millennia',
  'centuries',
  'decades',
  'years',
  'months',
  'weeks',
  'days',
  'hours',
  'minutes',
  'seconds',
  'milliseconds',
];

// ---------------------------------------------------------------------------
// Intl.DurationFormat helpers
// ---------------------------------------------------------------------------

/**
 * Maps our DurationRecord keys to the field names expected by
 * Intl.DurationFormat / Temporal.Duration.
 * Note: decades / centuries / millennia are not part of the Intl spec; they
 * are collapsed into `years` before formatting.
 */
export const INTL_UNIT_MAP: Partial<Record<keyof DurationRecord, keyof DurationRecord>> = {
  years: 'years',
  months: 'months',
  weeks: 'weeks',
  days: 'days',
  hours: 'hours',
  minutes: 'minutes',
  seconds: 'seconds',
  milliseconds: 'milliseconds',
} as const;

// ---------------------------------------------------------------------------
// ISO 8601 / RFC 9557 structural parsing (regex - format, not measurement)
// ---------------------------------------------------------------------------

/**
 * Structural regex covering both RFC 3339 (no weeks) and RFC 9557 (with weeks).
 * Using a single regex keeps parsing DRY; callers enforce the week-field
 * restriction for strict RFC 3339 validation.
 */
export const ISO_DURATION_RE =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
