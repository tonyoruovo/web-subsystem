/**
 * @fileoverview Concrete implementation of duration operations.
 *
 * @summary The Duration class, implemented on top of `Temporal.Duration`.
 * @description
 * Every calculation (totals, comparison, calendar arithmetic, balancing,
 * parsing, serialization and localized formatting) is delegated to
 * `@js-temporal/polyfill`. The class keeps the {@linkcode DurationRecord}
 * fields as its public state, so it stays a plain, serializable record.
 *
 * Two gaps between a {@linkcode DurationRecord} and a `Temporal.Duration` are
 * bridged here:
 *
 * - **Mixed signs.** A record may hold positive and negative fields at once;
 *   a `Temporal.Duration` may not. Each record is split into a positive part
 *   and a negative part, both valid `Temporal.Duration`s, and calculations
 *   combine them.
 * - **Extra units and fractions.** `decades`, `centuries` and `millennia` are
 *   folded into `years`. Fractional fields are spilled into the next smaller
 *   unit (exactly for weeks and smaller, by 12 for years, and by the average
 *   month length for months), because Temporal fields must be integers.
 *
 * Calendar units (years, months) have no fixed length, so totals, comparisons
 * and splits are measured from a **reference instant**, in UTC. It defaults to
 * the moment of the call; pass `relativeTo` to the constructor for
 * deterministic results.
 */

import { Temporal } from '@js-temporal/polyfill';

import { AVG_DAYS_IN_MONTH, UNITS } from '@/constants';
import type { DateLike, DurationDefinition, DurationLike, DurationRecord } from '@/types';

/** @summary The fields of a `Temporal.Duration`. */
type TemporalFields = {
  -readonly [
    K in
      | 'years'
      | 'months'
      | 'weeks'
      | 'days'
      | 'hours'
      | 'minutes'
      | 'seconds'
      | 'milliseconds'
      | 'microseconds'
      | 'nanoseconds'
  ]: number;
};

/** @summary Temporal fields from largest to smallest, with the factor to the next smaller unit. */
const SPILL: ReadonlyArray<[keyof TemporalFields, keyof TemporalFields | null, number]> = [
  ['years', 'months', 12],
  ['months', 'days', AVG_DAYS_IN_MONTH],
  ['weeks', 'days', 7],
  ['days', 'hours', 24],
  ['hours', 'minutes', 60],
  ['minutes', 'seconds', 60],
  ['seconds', 'milliseconds', 1000],
  ['milliseconds', 'microseconds', 1000],
  ['microseconds', 'nanoseconds', 1000],
  ['nanoseconds', null, 1],
];

/** @summary Each {@linkcode DurationRecord} unit as a Temporal unit and a multiplier. */
const AS_TEMPORAL_UNIT: Record<
  keyof DurationRecord,
  { unit: Exclude<keyof TemporalFields, 'microseconds' | 'nanoseconds'>; factor: number }
> = {
  millennia: { unit: 'years', factor: 1000 },
  centuries: { unit: 'years', factor: 100 },
  decades: { unit: 'years', factor: 10 },
  years: { unit: 'years', factor: 1 },
  months: { unit: 'months', factor: 1 },
  weeks: { unit: 'weeks', factor: 1 },
  days: { unit: 'days', factor: 1 },
  hours: { unit: 'hours', factor: 1 },
  minutes: { unit: 'minutes', factor: 1 },
  seconds: { unit: 'seconds', factor: 1 },
  milliseconds: { unit: 'milliseconds', factor: 1 },
};

/** @summary Options for a {@linkcode Duration}. */
export interface DurationOptions {
  /**
   * The reference point for calendar units: a `Temporal.ZonedDateTime`, or a
   * {@linkcode DateLike} interpreted in UTC. Defaults to the moment of each call.
   */
  relativeTo?: Temporal.ZonedDateTime | DateLike;
}

/** @summary Converts a {@linkcode DateLike} to a `Temporal.Instant`. */
function toInstant(date: DateLike): Temporal.Instant {
  const ms = new Date(date).getTime();
  if (Number.isNaN(ms)) throw new RangeError(`Invalid date: ${String(date)}`);
  return Temporal.Instant.fromEpochMilliseconds(ms);
}

/** @summary Builds a `Temporal.Duration` from fields. Unlike `Duration.from`, it accepts all zeros. */
function temporalOf(f: Partial<TemporalFields>): Temporal.Duration {
  return new Temporal.Duration(
    f.years,
    f.months,
    f.weeks,
    f.days,
    f.hours,
    f.minutes,
    f.seconds,
    f.milliseconds,
    f.microseconds,
    f.nanoseconds,
  );
}

/**
 * @summary Converts a record to integer Temporal fields.
 * @description Folds decades, centuries and millennia into years, then spills
 * every fractional part into the next smaller unit. `Math.trunc` keeps each
 * spilled part on the same sign as its field.
 */
function toTemporalFields(record: DurationRecord): TemporalFields {
  const fields: TemporalFields = {
    years:
      (record.millennia ?? 0) * 1000 +
      (record.centuries ?? 0) * 100 +
      (record.decades ?? 0) * 10 +
      (record.years ?? 0),
    months: record.months ?? 0,
    weeks: record.weeks ?? 0,
    days: record.days ?? 0,
    hours: record.hours ?? 0,
    minutes: record.minutes ?? 0,
    seconds: record.seconds ?? 0,
    milliseconds: record.milliseconds ?? 0,
    microseconds: 0,
    nanoseconds: 0,
  };
  for (const [unit, next, factor] of SPILL) {
    const value = fields[unit];
    if (next === null) {
      fields[unit] = Math.round(value);
      continue;
    }
    const whole = Math.trunc(value);
    fields[unit] = whole;
    fields[next] += (value - whole) * factor;
  }
  return fields;
}

/**
 * @summary Splits a record into its positive and negative parts.
 * @returns Two non-negative `Temporal.Duration`s. The record equals `positive - negative`.
 */
function toParts(record: DurationRecord): {
  positive: Temporal.Duration;
  negative: Temporal.Duration;
} {
  const fields = toTemporalFields(record);
  const positive: Partial<TemporalFields> = {};
  const negative: Partial<TemporalFields> = {};
  for (const key of Object.keys(fields) as (keyof TemporalFields)[]) {
    const value = fields[key];
    if (value > 0) positive[key] = value;
    else if (value < 0) negative[key] = -value;
  }
  return { positive: temporalOf(positive), negative: temporalOf(negative) };
}

/**
 * @summary Converts a `Temporal.Duration` to a record with only its non-zero fields.
 * @description Microseconds and nanoseconds become the fraction of `milliseconds`.
 */
function fromTemporal(duration: Temporal.Duration): DurationRecord {
  const record: DurationRecord = {};
  const keys = [
    'years',
    'months',
    'weeks',
    'days',
    'hours',
    'minutes',
    'seconds',
    'milliseconds',
  ] as const;
  for (const key of keys) if (duration[key] !== 0) record[key] = duration[key];
  const subMillis = duration.microseconds / 1e3 + duration.nanoseconds / 1e6;
  if (subMillis !== 0) record.milliseconds = (record.milliseconds ?? 0) + subMillis;
  return record;
}

/**
 * @summary Parses an ISO 8601 / RFC 9557 duration string with Temporal.
 * @param {string} input The duration string.
 * @param {boolean} allowWeeks `false` rejects the `W` designator (RFC 3339).
 */
function parseISOString(input: string, allowWeeks: boolean): DurationRecord {
  let duration: Temporal.Duration;
  try {
    duration = Temporal.Duration.from(input);
  } catch (cause) {
    throw new RangeError(`Invalid ISO 8601 duration string: "${input}"`, { cause });
  }
  if (!allowWeeks && duration.weeks !== 0) {
    throw new RangeError('Weeks designator "W" is not valid in RFC 3339 duration strings.');
  }
  return fromTemporal(duration);
}

// ---------------------------------------------------------------------------
// Duration class
// ---------------------------------------------------------------------------

/**
 * @summary Concrete implementation of duration operations, backed by `Temporal.Duration`.
 * @description
 * Provides creation, arithmetic, comparison, conversion, serialization and
 * localized formatting of durations. Its public fields are a
 * {@linkcode DurationRecord}; the reference instant for calendar units is kept
 * private, so `toJSON()` and `Object.keys()` only see the record.
 *
 * @example
 * ```ts
 * const duration = new Duration({ hours: 2, minutes: 30 });
 * duration.toHumanReadableString(); // "2 hours, 30 minutes"
 * duration.add({ minutes: 45 }).normalize(); // { hours: 3, minutes: 15 }
 * ```
 * @example
 * ```ts
 * // Calendar-exact totals: pass the reference point.
 * new Duration({ months: 1 }, { relativeTo: '2025-02-01' }).normalize('days'); // { days: 28 }
 * ```
 * @example
 * ```ts
 * // Serializing for save files
 * const saved = new Duration({ days: 5 }).toISO8601(); // "P5D"
 * Duration.fromISO8601(saved);
 * ```
 *
 * Edge cases:
 * - Subtraction clamps each field at zero.
 * - Fractional fields are spilled into smaller units before calculations.
 * - A record with mixed signs is valid; `toTemporal()` and `toISO8601()`
 *   throw a `RangeError` for it, because ISO 8601 has no mixed-sign form.
 *
 * @see {@link IDuration} For the interface it implements.
 * @see {@link DurationRecord} For the data structure.
 * @see RFC 3339 and RFC 9557 for supported string formats.
 */
export class Duration implements DurationDefinition {
  declare milliseconds?: number;
  declare seconds?: number;
  declare minutes?: number;
  declare hours?: number;
  declare days?: number;
  declare weeks?: number;
  declare months?: number;
  declare years?: number;
  declare decades?: number;
  declare centuries?: number;
  declare millennia?: number;

  /** @internal The reference point for calendar units, or `undefined` for "now". */
  readonly #relativeTo?: Temporal.ZonedDateTime;

  constructor(initialState: DurationRecord = {}, options: DurationOptions = {}) {
    for (const unit of UNITS) {
      if (initialState[unit] !== undefined) this[unit] = initialState[unit];
    }
    const { relativeTo } = options;
    if (relativeTo !== undefined) {
      this.#relativeTo =
        relativeTo instanceof Temporal.ZonedDateTime
          ? relativeTo
          : toInstant(relativeTo).toZonedDateTimeISO('UTC');
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /** @internal Creates a duration that shares this one's reference point. */
  private _derive(record: DurationRecord): Duration {
    return new Duration(record, { relativeTo: this.#relativeTo });
  }

  /** @internal The reference point for calendar units. */
  private _anchor(): Temporal.ZonedDateTime {
    return this.#relativeTo ?? Temporal.Now.zonedDateTimeISO('UTC');
  }

  /** @internal The instant reached by applying this duration to `anchor`. */
  private _endFrom(anchor: Temporal.ZonedDateTime): Temporal.ZonedDateTime {
    const { positive, negative } = toParts(this);
    return anchor.add(positive).subtract(negative);
  }

  /** @internal The total length in `unit`, measured from the reference point. */
  private _total(unit: keyof DurationRecord): number {
    const { unit: temporalUnit, factor } = AS_TEMPORAL_UNIT[unit];
    const relativeTo = this._anchor();
    const { positive, negative } = toParts(this);
    const total =
      positive.total({ unit: temporalUnit, relativeTo }) -
      negative.total({ unit: temporalUnit, relativeTo });
    return total / factor;
  }

  // ── Temporal interop ──────────────────────────────────────────────────────

  /**
   * @summary Returns this duration as a `Temporal.Duration`.
   * @throws {RangeError} When the fields have mixed signs.
   */
  toTemporal(): Temporal.Duration {
    return temporalOf(toTemporalFields(this));
  }

  // ── Standard methods ──────────────────────────────────────────────────────

  toDate(fromDate: DateLike = new Date(), direction: 'future' | 'past' = 'future'): Date {
    // The system time zone matches the local-time semantics of `Date`.
    const start = toInstant(fromDate).toZonedDateTimeISO(Temporal.Now.timeZoneId());
    const { positive, negative } = toParts(this);
    const end =
      direction === 'future'
        ? start.add(positive).subtract(negative)
        : start.subtract(positive).add(negative);
    return new Date(end.epochMilliseconds);
  }

  ago(fromDate: DateLike = new Date()): Date {
    return this.toDate(fromDate, 'past');
  }
  fromThen(fromDate: DateLike = new Date()): Date {
    return this.toDate(fromDate, 'future');
  }
  fromNow(): Date {
    return this.fromThen();
  }

  normalize(targetUnit?: keyof DurationRecord, options?: { approximate: boolean }): Duration {
    if (targetUnit) {
      const total = this._total(targetUnit);
      return this._derive({ [targetUnit]: options?.approximate ? Math.round(total) : total });
    }

    // Balance the time part (days and smaller) with Temporal, then days into
    // weeks. Calendar units are left as they are.
    const time = toParts({
      days: this.days,
      hours: this.hours,
      minutes: this.minutes,
      seconds: this.seconds,
      milliseconds: this.milliseconds,
    });
    const balanced = time.positive.subtract(time.negative).round({ largestUnit: 'days' });
    const weeks = Math.trunc(balanced.days / 7);

    const result: DurationRecord = {
      millennia: this.millennia,
      centuries: this.centuries,
      decades: this.decades,
      years: this.years,
      months: this.months,
      weeks: (this.weeks ?? 0) + weeks,
      ...fromTemporal(balanced.with({ days: balanced.days - weeks * 7 })),
    };
    // Keep zero fields only where this duration defined them.
    for (const unit of UNITS) {
      if (result[unit] === 0 && this[unit] === undefined) delete result[unit];
      if (result[unit] === undefined && this[unit] !== undefined) result[unit] = 0;
    }
    return this._derive(result);
  }

  /**
   * Returns a locale-aware human-readable string via `Temporal.Duration#toLocaleString`.
   *
   * @param options.locale  - BCP 47 locale (default: runtime locale).
   * @param options.concise - `true` -> "narrow" style ("2h 30m"),
   *                          `false` -> "long" style ("2 hours, 30 minutes").
   */
  toHumanReadableString(options?: { locale?: string; concise?: boolean }): string {
    const { locale, concise = false } = options ?? {};
    return this.formatIntl(locale, concise ? 'narrow' : 'long');
  }

  /**
   * Formats the duration with full `Intl.DurationFormat` style control.
   *
   * @example
   * new Duration({ hours: 1, minutes: 30 }).formatIntl('en', 'digital'); // "1:30:00"
   * new Duration({ hours: 1, minutes: 30 }).formatIntl('de', 'long');    // "1 Stunde und 30 Minuten"
   */
  formatIntl(locale?: string, style: Intl.DurationFormatStyle = 'long'): string {
    const duration = this.toTemporal();
    // A zero duration would format as "", so always show the seconds for it.
    // Temporal types the options loosely; they are passed to Intl.DurationFormat.
    const options: Intl.DurationFormatOptions & Record<string, unknown> = duration.blank
      ? { style, secondsDisplay: 'always' }
      : { style };
    return duration.toLocaleString(locale, options);
  }

  roundTo(unit: keyof DurationRecord): Duration {
    return this._derive({ [unit]: Math.round(this._total(unit)) });
  }

  /**
   * Formats the duration using a custom token pattern.
   * Tokens: Y M W D H m s ms.
   *
   * For locale-aware output prefer toHumanReadableString() / formatIntl().
   */
  format(pattern: string): string {
    const placeholders: Record<string, number | undefined> = {
      Y: this.years,
      M: this.months,
      W: this.weeks,
      D: this.days,
      H: this.hours,
      m: this.minutes,
      s: this.seconds,
      ms: this.milliseconds,
    };
    return pattern.replace(/ms|Y|M|W|D|H|m|s/g, (match) => (placeholders[match] ?? 0).toString());
  }

  split(unit: keyof DurationRecord): Duration[] {
    if (this.isNegative()) throw new RangeError('Cannot split a negative duration.');
    const { unit: temporalUnit, factor } = AS_TEMPORAL_UNIT[unit];
    const anchor = this._anchor();
    const end = this._endFrom(anchor);
    const count = Math.floor(this._total(unit));
    const afterChunks = anchor.add({ [temporalUnit]: count * factor });
    const remainder = end.epochMilliseconds - afterChunks.epochMilliseconds;

    const chunks = Array.from({ length: count }, () => this._derive({ [unit]: 1 }));
    if (remainder > 0) chunks.push(this._derive({ milliseconds: remainder }));
    return chunks;
  }

  add(other: DurationLike): Duration {
    const duration = Duration.fromDurationLike(other);
    const newState: DurationRecord = {};
    for (const unit of UNITS) {
      if (this[unit] !== undefined || duration[unit] !== undefined) {
        newState[unit] = (this[unit] ?? 0) + (duration[unit] ?? 0);
      }
    }
    return this._derive(newState).normalize();
  }

  subtract(other: DurationLike): Duration {
    const duration = Duration.fromDurationLike(other);
    const newState: DurationRecord = {};
    for (const unit of UNITS) {
      if (this[unit] !== undefined || duration[unit] !== undefined) {
        newState[unit] = Math.max(0, (this[unit] ?? 0) - (duration[unit] ?? 0));
      }
    }
    return this._derive(newState);
  }

  equals(other: DurationLike): boolean {
    try {
      return this.compareTo(other) === 0;
    } catch {
      return false;
    }
  }

  clone(): Duration {
    return this._derive(this);
  }

  isZero(): boolean {
    const { positive, negative } = toParts(this);
    return positive.blank && negative.blank;
  }
  isNegative(): boolean {
    return !toParts(this).negative.blank;
  }
  isPositive(): boolean {
    const { positive, negative } = toParts(this);
    return !positive.blank && negative.blank;
  }

  multiply(factor: number): Duration {
    if (factor < 0) throw new Error('Factor must be a non-negative number.');
    const newState: DurationRecord = {};
    for (const unit of UNITS) if (this[unit] !== undefined) newState[unit] = this[unit] * factor;
    return this._derive(newState).normalize();
  }

  divide(divisor: number): Duration {
    if (divisor <= 0) throw new Error('Divisor must be a positive number.');
    const newState: DurationRecord = {};
    for (const unit of UNITS) if (this[unit] !== undefined) newState[unit] = this[unit] / divisor;
    return this._derive(newState).normalize();
  }

  compareTo(other: DurationLike): -1 | 0 | 1 {
    const anchor = this._anchor();
    return Temporal.ZonedDateTime.compare(
      this._endFrom(anchor),
      Duration.fromDurationLike(other)._endFrom(anchor),
    );
  }

  /**
   * Converts this duration to an ISO 8601 duration string.
   *
   * - `RFC9557` (Temporal's format): every field, fractional seconds, and weeks.
   * - `RFC3339` (default): weeks are folded into days and seconds are whole,
   *   because RFC 3339's grammar allows neither weeks with other units nor fractions.
   *
   * @throws {RangeError} When the fields have mixed signs.
   */
  toISO8601(options?: { format?: 'RFC3339' | 'RFC9557' }): string {
    const { format = 'RFC3339' } = options ?? {};
    const duration = this.toTemporal();
    if (format === 'RFC9557') return duration.toString();
    return duration
      .with({ weeks: 0, days: duration.days + duration.weeks * 7 })
      .toString({ fractionalSecondDigits: 0, roundingMode: 'trunc' });
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  getTotalMilliseconds(): number {
    return this._total('milliseconds');
  }
  getTotalSeconds(): number {
    return this._total('seconds');
  }
  getTotalMinutes(): number {
    return this._total('minutes');
  }
  getTotalHours(): number {
    return this._total('hours');
  }

  isGreaterThan(other: DurationLike): boolean {
    return this.compareTo(other) === 1;
  }
  isLessThan(other: DurationLike): boolean {
    return this.compareTo(other) === -1;
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  toJSON(): DurationRecord {
    const state: DurationRecord = {};
    for (const unit of UNITS) if (this[unit] !== undefined) state[unit] = this[unit];
    return state;
  }

  floor(unit: keyof DurationRecord): Duration {
    const newDuration = this.clone();
    const targetIndex = UNITS.indexOf(unit);
    for (let i = targetIndex + 1; i < UNITS.length; i++) delete newDuration[UNITS[i]];
    return newDuration;
  }

  trunc(unitOrLevels?: keyof DurationRecord | number): Duration {
    if (typeof unitOrLevels === 'string') return this.floor(unitOrLevels);

    const levels = unitOrLevels ?? 0;
    const newDuration = this.clone();
    const msIndex = UNITS.findIndex((u) => newDuration[u] && newDuration[u] !== 0);

    if (msIndex === -1) return this._derive({});

    const startIndex = levels < 0 ? Math.max(0, msIndex + levels) : msIndex;
    const endIndex = levels > 0 ? Math.min(UNITS.length - 1, msIndex + levels) : msIndex;

    for (let i = 0; i < UNITS.length; i++) {
      if (i < startIndex || i > endIndex) delete newDuration[UNITS[i]];
      else if (newDuration[UNITS[i]] === undefined) newDuration[UNITS[i]] = 0;
    }
    return newDuration;
  }

  // ── Key inspection ────────────────────────────────────────────────────────

  getPositiveKeys(): (keyof DurationRecord)[] {
    return UNITS.filter((u) => (this[u] ?? 0) > 0);
  }
  getNilKeys(): (keyof DurationRecord)[] {
    return UNITS.filter((u) => this[u] == null);
  }
  getZeroKeys(): (keyof DurationRecord)[] {
    return UNITS.filter((u) => this[u] === 0);
  }
  getNegativeKeys(): (keyof DurationRecord)[] {
    return UNITS.filter((u) => (this[u] ?? 0) < 0);
  }

  // ── Static factory methods ────────────────────────────────────────────────

  static fromMilliseconds(ms: number): Duration {
    return new Duration({ milliseconds: ms });
  }
  static fromSeconds(seconds: number): Duration {
    return new Duration({ seconds });
  }

  /** Creates a duration from a `Temporal.Duration`. */
  static fromTemporal(duration: Temporal.Duration): Duration {
    return new Duration(fromTemporal(duration));
  }

  /**
   * The calendar-exact distance between two dates, always non-negative,
   * from years down to milliseconds. Measured in UTC.
   */
  static between(date1: DateLike, date2: DateLike): Duration {
    const [a, b] = [toInstant(date1), toInstant(date2)];
    const [start, end] = Temporal.Instant.compare(a, b) <= 0 ? [a, b] : [b, a];
    const difference = start
      .toZonedDateTimeISO('UTC')
      .until(end.toZonedDateTimeISO('UTC'), { largestUnit: 'years' });
    return new Duration(fromTemporal(difference), { relativeTo: start.toZonedDateTimeISO('UTC') });
  }

  /** Parses an ISO 8601 duration string (RFC 9557 superset: weeks and fractions allowed). */
  static fromISO8601(isoString: string): Duration {
    return new Duration(parseISOString(isoString, true));
  }

  /** Parses an RFC 3339 duration string (no weeks designator). */
  static fromRFC3339(rfc3339String: string): Duration {
    return new Duration(parseISOString(rfc3339String, false));
  }

  /** Parses an RFC 9557 duration string (weeks designator allowed). */
  static fromRFC9557(rfc9557String: string): Duration {
    return new Duration(parseISOString(rfc9557String, true));
  }

  /**
   * Converts any DurationLike value to a Duration instance.
   * String inputs are tried as RFC 9557, then as a Date constructor argument.
   */
  static fromDurationLike(d: DurationLike | Temporal.Duration): Duration {
    if (d instanceof Duration) return d;
    if (d instanceof Temporal.Duration) return Duration.fromTemporal(d);
    if (typeof d === 'number') return Duration.fromMilliseconds(d);
    if (d instanceof Date) return Duration.fromMilliseconds(d.getTime());

    if (typeof d === 'string') {
      try {
        return Duration.fromRFC9557(d);
      } catch {
        /* fall through */
      }
      const date = new Date(d);
      if (Number.isNaN(date.getTime()))
        throw new Error(
          'Invalid duration string. Must be RFC 9557, RFC 3339, or a valid Date constructor argument.',
        );
      return Duration.fromMilliseconds(date.getTime());
    }

    if (typeof d === 'object' && d !== null) return new Duration(d as DurationRecord);
    throw new Error('Unsupported DurationLike type.');
  }

  // ── Validation helpers ────────────────────────────────────────────────────

  /** Returns true if the string is a valid RFC 3339 duration (no weeks). */
  static isValidRFC3339(input: string): boolean {
    try {
      parseISOString(input, false);
      return true;
    } catch {
      return false;
    }
  }

  /** Returns true if the string is a valid RFC 9557 duration (weeks allowed). */
  static isValidRFC9557(input: string): boolean {
    try {
      parseISOString(input, true);
      return true;
    } catch {
      return false;
    }
  }

  /** Extracts a single component from an RFC 3339 duration string. */
  static parseComponentFromRFC3339(
    input: string,
    component: keyof DurationRecord,
  ): number | undefined {
    return parseISOString(input, false)[component];
  }

  static zero(): Duration {
    return new Duration({});
  }

  static negative(unit: keyof DurationRecord): Duration {
    if (!UNITS.includes(unit)) throw new Error(`Invalid unit: ${unit}`);
    return new Duration({ [unit]: -1 });
  }
}
