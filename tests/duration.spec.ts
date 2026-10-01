/**
 * @fileoverview Tests for the Temporal-backed Duration class.
 *
 * Calendar-dependent results use a fixed `relativeTo` so they do not depend
 * on the day the tests run.
 */
import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { Duration } from '../src';

const FEB_2025 = '2025-02-01T00:00:00Z';
const MAR_2025 = '2025-03-01T00:00:00Z';

describe('Duration — construction and serialization', () => {
  it('keeps only the record fields it was given', () => {
    const d = new Duration({ hours: 2, minutes: 30 });
    expect(d.toJSON()).toEqual({ hours: 2, minutes: 30 });
    expect(Object.keys(d)).toEqual(['hours', 'minutes']);
  });

  it('does not serialize the reference point', () => {
    const d = new Duration({ days: 1 }, { relativeTo: FEB_2025 });
    expect(JSON.parse(JSON.stringify(d))).toEqual({ days: 1 });
  });

  it('round-trips through Temporal.Duration', () => {
    const d = new Duration({ decades: 1, years: 2, hours: 3 });
    const temporal = d.toTemporal();
    expect(temporal.years).toBe(12);
    expect(Duration.fromTemporal(temporal).toJSON()).toEqual({ years: 12, hours: 3 });
  });

  it('spills fractional fields into smaller units', () => {
    expect(new Duration({ hours: 1.5 }).toTemporal().toString()).toBe('PT1H30M');
    expect(new Duration({ weeks: 0.5 }).toTemporal().toString()).toBe('P3DT12H');
  });

  it('rejects mixed signs in toTemporal()', () => {
    expect(() => new Duration({ hours: 1, minutes: -30 }).toTemporal()).toThrow(RangeError);
  });
});

describe('Duration — totals', () => {
  it('measures time units exactly', () => {
    const d = new Duration({ hours: 1, minutes: 30, seconds: 15, milliseconds: 500 });
    expect(d.getTotalMilliseconds()).toBe(5_415_500);
    expect(d.getTotalSeconds()).toBe(5_415.5);
    expect(d.getTotalMinutes()).toBeCloseTo(90.258333, 5);
    expect(d.getTotalHours()).toBeCloseTo(1.504305, 5);
  });

  it('measures calendar units from the reference point', () => {
    expect(new Duration({ months: 1 }, { relativeTo: FEB_2025 }).normalize('days').days).toBe(28);
    expect(new Duration({ months: 1 }, { relativeTo: MAR_2025 }).normalize('days').days).toBe(31);
  });

  it('subtracts the negative part of a mixed-sign record', () => {
    expect(new Duration({ hours: 1, minutes: -30 }).getTotalMinutes()).toBe(30);
  });

  it('supports decades, centuries and millennia as target units', () => {
    const d = new Duration({ centuries: 1 }, { relativeTo: '2000-01-01T00:00:00Z' });
    expect(d.normalize('decades').decades).toBe(10);
    expect(d.normalize('millennia').millennia).toBeCloseTo(0.1, 10);
  });
});

describe('Duration — normalize()', () => {
  it('balances overflowing time units up to weeks', () => {
    const d = new Duration({ days: 6, hours: 23, minutes: 59, seconds: 59, milliseconds: 1_001 });
    expect(d.normalize().toJSON()).toEqual({
      weeks: 1,
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      milliseconds: 1,
    });
  });

  it('leaves calendar units as they are', () => {
    expect(new Duration({ months: 14, minutes: 90 }).normalize().toJSON()).toEqual({
      months: 14,
      hours: 1,
      minutes: 30,
    });
  });

  it('rounds to a single unit when approximate', () => {
    const d = new Duration({ minutes: 2, seconds: 90 });
    expect(d.normalize('seconds', { approximate: true }).toJSON()).toEqual({ seconds: 210 });
    expect(d.normalize('minutes', { approximate: true }).toJSON()).toEqual({ minutes: 4 });
  });
});

describe('Duration — arithmetic', () => {
  it('adds field by field, then normalizes', () => {
    const sum = new Duration({ hours: 2, minutes: 30 }).add({ minutes: 45 });
    expect(sum.toJSON()).toEqual({ hours: 3, minutes: 15 });
  });

  it('accepts ISO strings, milliseconds and Temporal durations', () => {
    const base = new Duration({ minutes: 1 });
    expect(base.add('PT30S').getTotalSeconds()).toBe(90);
    expect(base.add(500).getTotalMilliseconds()).toBe(60_500);
    expect(base.equals(Temporal.Duration.from({ seconds: 60 }) as never)).toBe(true);
  });

  it('clamps subtraction at zero per field', () => {
    expect(new Duration({ hours: 1, minutes: 10 }).subtract({ minutes: 20 }).toJSON()).toEqual({
      hours: 1,
      minutes: 0,
    });
  });

  it('multiplies and divides field by field', () => {
    expect(new Duration({ minutes: 45 }).multiply(2).toJSON()).toEqual({ hours: 1, minutes: 30 });
    expect(new Duration({ hours: 1 }).divide(4).toJSON()).toEqual({ hours: 0, minutes: 15 });
    expect(() => new Duration({ hours: 1 }).multiply(-1)).toThrow();
    expect(() => new Duration({ hours: 1 }).divide(0)).toThrow();
  });

  it('rounds to the nearest unit', () => {
    expect(new Duration({ milliseconds: 1_234 }).roundTo('seconds').toJSON()).toEqual({
      seconds: 1,
    });
  });

  it('splits into whole units plus a millisecond remainder', () => {
    const chunks = new Duration({ hours: 2, minutes: 30 }).split('hours');
    expect(chunks.map((c) => c.toJSON())).toEqual([
      { hours: 1 },
      { hours: 1 },
      { milliseconds: 1_800_000 },
    ]);
    expect(() => new Duration({ hours: -1 }).split('hours')).toThrow(RangeError);
  });
});

describe('Duration — comparison and sign', () => {
  it('compares by length from the reference point', () => {
    const month = new Duration({ months: 1 }, { relativeTo: FEB_2025 });
    expect(month.compareTo({ days: 28 })).toBe(0);
    expect(month.isLessThan({ days: 29 })).toBe(true);
    expect(month.isGreaterThan({ days: 27 })).toBe(true);
    expect(new Duration({ minutes: 90 }).equals({ hours: 1, minutes: 30 })).toBe(true);
  });

  it('treats a duration with any negative field as negative', () => {
    const mixed = new Duration({ hours: 1, minutes: -30 });
    expect(mixed.isNegative()).toBe(true);
    expect(mixed.isPositive()).toBe(false);
    expect(mixed.isZero()).toBe(false);
  });

  it('treats an empty or all-zero duration as zero', () => {
    for (const d of [new Duration(), new Duration({ hours: 0, minutes: 0 })]) {
      expect(d.isZero()).toBe(true);
      expect(d.isPositive()).toBe(false);
      expect(d.isNegative()).toBe(false);
    }
  });
});

describe('Duration — dates', () => {
  it('applies time units forwards and backwards', () => {
    const d = new Duration({ hours: 2 });
    expect(d.fromThen(0).getTime()).toBe(7_200_000);
    expect(d.ago(7_200_000).getTime()).toBe(0);
  });

  it('constrains month-end arithmetic instead of rolling over', () => {
    // Mid-day UTC keeps the local date on Jan 31 in every time zone between UTC-11 and UTC+11.
    const end = new Duration({ months: 1 }).toDate('2025-01-31T12:00:00Z');
    expect(end.getMonth()).toBe(1);
    expect(end.getDate()).toBe(28);
  });

  it('measures the calendar-exact distance between two dates', () => {
    const d = Duration.between('1971-02-03T04:05:06.007Z', '1970-01-01T00:00:00Z');
    expect(d.toJSON()).toEqual({
      years: 1,
      months: 1,
      days: 2,
      hours: 4,
      minutes: 5,
      seconds: 6,
      milliseconds: 7,
    });
  });
});

describe('Duration — ISO 8601', () => {
  it('parses RFC 9557, including weeks, fractions and signs', () => {
    expect(Duration.fromISO8601('P1W2DT3.5S').toJSON()).toEqual({
      weeks: 1,
      days: 2,
      seconds: 3,
      milliseconds: 500,
    });
    expect(Duration.fromRFC9557('-PT1M').toJSON()).toEqual({ minutes: -1 });
  });

  it('rejects weeks in RFC 3339 and invalid strings', () => {
    expect(() => Duration.fromRFC3339('P1W')).toThrow(RangeError);
    expect(Duration.isValidRFC3339('P1W')).toBe(false);
    expect(Duration.isValidRFC9557('P1W')).toBe(true);
    expect(Duration.isValidRFC9557('1 hour')).toBe(false);
    expect(Duration.parseComponentFromRFC3339('P1Y2M', 'months')).toBe(2);
  });

  it('serializes RFC 3339 without weeks or fractions', () => {
    const d = new Duration({ weeks: 1, days: 1, seconds: 3, milliseconds: 500 });
    expect(d.toISO8601()).toBe('P8DT3S');
    expect(d.toISO8601({ format: 'RFC9557' })).toBe('P1W1DT3.5S');
    expect(new Duration().toISO8601()).toBe('PT0S');
  });
});

describe('Duration — formatting', () => {
  it('formats with Intl.DurationFormat styles', () => {
    const d = new Duration({ hours: 2, minutes: 30 });
    expect(d.toHumanReadableString({ locale: 'en' })).toBe('2 hours, 30 minutes');
    expect(d.toHumanReadableString({ locale: 'en', concise: true })).toBe('2h 30m');
    expect(d.formatIntl('en', 'digital')).toBe('2:30:00');
  });

  it('formats a zero duration as zero seconds', () => {
    expect(new Duration().toHumanReadableString({ locale: 'en' })).toBe('0 seconds');
  });

  it('formats custom patterns', () => {
    expect(new Duration({ years: 1, months: 2, days: 3 }).format('Y-M-D')).toBe('1-2-3');
  });
});

describe('Duration — key helpers', () => {
  it('floors, truncates and inspects keys', () => {
    const d = new Duration({ hours: 1, minutes: 45, seconds: 0, days: -1 });
    expect(d.floor('hours').toJSON()).toEqual({ days: -1, hours: 1 });
    expect(new Duration({ hours: 1, minutes: 45 }).trunc(1).toJSON()).toEqual({
      hours: 1,
      minutes: 45,
    });
    expect(d.getPositiveKeys()).toEqual(['hours', 'minutes']);
    expect(d.getZeroKeys()).toEqual(['seconds']);
    expect(d.getNegativeKeys()).toEqual(['days']);
    expect(Duration.negative('days').toJSON()).toEqual({ days: -1 });
  });
});
