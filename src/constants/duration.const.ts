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
