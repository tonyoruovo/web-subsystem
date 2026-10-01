/**
 * @fileoverview Concrete implementation of duration operations.
 *
 * @summary This file contains the Duration class, which implements the DurationDefinition interface.
 * Duration parsing uses Intl.DurationFormat and temporal parsing where available,
 * with ISO 8601 / RFC 9557 regex as a structural fallback.
 * Formatting delegates entirely to Intl.DurationFormat.
 */

import {
  DAY_IN_WEEK,
  HOUR_IN_DAY,
  INTL_UNIT_MAP,
  ISO_DURATION_RE,
  MIN_IN_HOUR,
  MS_IN_DAY,
  MS_IN_MONTH,
  MS_IN_SEC,
  MS_IN_YEAR,
  SEC_IN_MIN,
  UNITS,
} from '@/constants';
import type { DateLike, DurationDefinition, DurationLike, DurationRecord } from '@/types';

/**
 * Collapses decades / centuries / millennia into `years` so the record is
 * consumable by Intl.DurationFormat (which has no concept of those units).
 */
function toIntlRecord(record: DurationRecord) {
  const extraYears =
    (record.millennia ?? 0) * 1000 + (record.centuries ?? 0) * 100 + (record.decades ?? 0) * 10;

  const intl: DurationRecord = {};

  for (const [key, intlKey] of Object.entries(INTL_UNIT_MAP)) {
    const k = key as keyof DurationRecord;
    const v = record[k] ?? 0;
    if (v !== 0) intl[intlKey] = v;
  }

  if (extraYears) {
    intl['years'] = (intl['years'] ?? 0) + extraYears;
  }

  return intl;
}

/**
 * Formats a DurationRecord as a human-readable string via Intl.DurationFormat.
 *
 * @param record  - The duration fields to format.
 * @param locale  - BCP 47 locale tag (default: runtime locale).
 * @param style   - Intl.DurationFormat style: "long" | "short" | "narrow" | "digital"
 *                  "long"    -> "2 hours, 30 minutes"
 *                  "short"   -> "2 hr., 30 min."
 *                  "narrow"  -> "2h 30m"   (closest to the old `concise` flag)
 *                  "digital" -> "2:30:00"
 */
function formatWithIntl(
  record: DurationRecord,
  locale: string | undefined,
  style: Intl.DurationFormatStyle,
): string {
  // Intl.DurationFormat omits zero-valued fields automatically.
  const intlRecord = toIntlRecord(record);

  // Guard: if every field is zero, display "0 seconds" in the requested style.
  const allZero = Object.values(intlRecord).every((v) => !v);
  if (allZero) {
    return new Intl.DurationFormat(locale, { style }).format({ seconds: 0 });
  }

  return new Intl.DurationFormat(locale, { style }).format(intlRecord);
}

/**
 * Parses an ISO 8601 / RFC 9557 duration string into a DurationRecord.
 * Milliseconds are extracted from the fractional part of the seconds designator.
 *
 * Using Intl.DurationFormat for *parsing* is not yet part of the spec
 * (formatToParts goes the other direction). The regex remains here as the
 * correct tool for *structural* ISO string parsing.
 */
function parseISOString(input: string, allowWeeks: boolean = true): DurationRecord {
  const matches = input.match(ISO_DURATION_RE);
  if (!matches) throw new Error(`Invalid ISO 8601 duration string: "${input}"`);

  const [, rawYears, rawMonths, rawWeeks, rawDays, rawHours, rawMinutes, rawSeconds] = matches.map(
    (v) => (v != null ? parseFloat(v) : undefined),
  );

  if (!allowWeeks && rawWeeks != null) {
    throw new Error(`Weeks designator "W" is not valid in RFC 3339 duration strings.`);
  }

  const record: DurationRecord = {
    years: rawYears || undefined,
    months: rawMonths || undefined,
    weeks: rawWeeks || undefined,
    days: rawDays || undefined,
    hours: rawHours || undefined,
    minutes: rawMinutes || undefined,
  };

  if (rawSeconds != null && rawSeconds !== 0) {
    record.seconds = Math.floor(rawSeconds);
    record.milliseconds = Math.round((rawSeconds % 1) * 1000) || undefined;
  }

  return record;
}

// ---------------------------------------------------------------------------
// Duration class
// ---------------------------------------------------------------------------

/**
 * @summary Concrete implementation of duration operations.
 * @description
 * This class provides a full-featured implementation of the IDuration interface, offering methods for
 * creating, manipulating, and converting durations. It uses the DurationRecord structure internally
 * and provides static factory methods for easy instantiation from various sources.
 *
 * The "why" is to have a ready-to-use duration class that handles all common operations, normalization,
 * and serialization. The "how" involves maintaining state as optional number properties and using
 * private methods for calculations, with public methods for user interactions.
 *
 * @example
 * ```ts
 * // Creating and using durations
 * const duration = new Duration({ hours: 2, minutes: 30 });
 * console.log(duration.toHumanReadableString()); // "2 hours, 30 minutes"
 * const added = duration.add({ minutes: 45 });
 * console.log(added.normalize()); // Normalized result
 * ```
 * @example
 * ```ts
 * // In game development for timers
 * const gameTimer = Duration.fromSeconds(120);
 * setInterval(() => {
 *   if (!gameTimer.isZero()) {
 *     gameTimer.subtract({ seconds: 1 });
 *     console.log(gameTimer.toHumanReadableString({ concise: true }));
 *   }
 * }, 1000);
 * ```
 * @example
 * ```ts
 * // In physics simulations for time steps
 * const timeStep = new Duration({ milliseconds: 16 });
 * let simulationTime = new Duration();
 * while (simulationTime.getTotalMilliseconds() < 10000) {
 *   // Run simulation step
 *   simulationTime = simulationTime.add(timeStep);
 * }
 * ```
 * @example
 * ```ts
 * // Serializing for save files
 * const saveData = { lastPlayed: new Duration({ days: 5 }).toISO8601() };
 * // Later: Duration.fromISO8601(saveData.lastPlayed)
 * ```
 * Edge cases include:
 * - Negative values in operations: Subtraction clamps to zero.
 * - Very large durations: Uses BigInt internally for calculations if needed.
 * - Fractional units: Handled in normalization and serialization.
 * - Zero durations: Special handling in string representations.
 *
 * Exceptions and errors: Methods throw for invalid inputs (e.g., negative divisors in divide).
 * All methods that take a `DurationLike` type as argument may throw if
 * passed a stateless `IDuration`, as this is illegal
 *
 * @see {@link IDuration} For the interface it implements.
 * @see {@link DurationRecord} For the internal data structure.
 * @see RFC 3339 and RFC 9557 for supported string formats.
 */
export class Duration implements DurationDefinition {
  milliseconds?: number;
  seconds?: number;
  minutes?: number;
  hours?: number;
  days?: number;
  weeks?: number;
  months?: number;
  years?: number;
  decades?: number;
  centuries?: number;
  millennia?: number;

  constructor(initialState: DurationRecord = {}) {
    Object.assign(this, initialState);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private _toTotalMillis(): number {
    const years =
      (this.millennia ?? 0) * 1000 +
      (this.centuries ?? 0) * 100 +
      (this.decades ?? 0) * 10 +
      (this.years ?? 0);

    return (
      (this.milliseconds ?? 0) +
      (this.seconds ?? 0) * MS_IN_SEC +
      (this.minutes ?? 0) * SEC_IN_MIN * MS_IN_SEC +
      (this.hours ?? 0) * MIN_IN_HOUR * SEC_IN_MIN * MS_IN_SEC +
      (this.days ?? 0) * HOUR_IN_DAY * MIN_IN_HOUR * SEC_IN_MIN * MS_IN_SEC +
      (this.weeks ?? 0) * DAY_IN_WEEK * HOUR_IN_DAY * MIN_IN_HOUR * SEC_IN_MIN * MS_IN_SEC +
      (this.months ?? 0) * MS_IN_MONTH +
      years * MS_IN_YEAR
    );
  }

  // ── Standard methods ──────────────────────────────────────────────────────

  toDate(fromDate: DateLike = new Date(), direction: 'future' | 'past' = 'future'): Date {
    const result = new Date(fromDate);
    const sign = direction === 'future' ? 1 : -1;

    const years =
      (this.millennia ?? 0) * 1000 +
      (this.centuries ?? 0) * 100 +
      (this.decades ?? 0) * 10 +
      (this.years ?? 0);

    if (years) result.setFullYear(result.getFullYear() + sign * years);
    if (this.months) result.setMonth(result.getMonth() + sign * this.months);
    if (this.weeks) result.setDate(result.getDate() + sign * this.weeks * 7);
    if (this.days) result.setDate(result.getDate() + sign * this.days);
    if (this.hours) result.setHours(result.getHours() + sign * this.hours);
    if (this.minutes) result.setMinutes(result.getMinutes() + sign * this.minutes);
    if (this.seconds) result.setSeconds(result.getSeconds() + sign * this.seconds);
    if (this.milliseconds)
      result.setMilliseconds(result.getMilliseconds() + sign * this.milliseconds);

    return result;
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
    const totalMillis = this._toTotalMillis();
    const approximate = options?.approximate ?? false;

    if (targetUnit) {
      const divisors: Record<keyof DurationRecord, number> = {
        millennia: MS_IN_YEAR * 1000,
        centuries: MS_IN_YEAR * 100,
        decades: MS_IN_YEAR * 10,
        years: MS_IN_YEAR,
        months: MS_IN_MONTH,
        weeks: MS_IN_DAY * 7,
        days: MS_IN_DAY,
        hours: MS_IN_DAY / 24,
        minutes: MS_IN_SEC * 60,
        seconds: MS_IN_SEC,
        milliseconds: 1,
      };
      const totalValue = totalMillis / divisors[targetUnit];
      return new Duration({ [targetUnit]: approximate ? Math.round(totalValue) : totalValue });
    }

    const d = new Duration(this);
    if (d.milliseconds && d.milliseconds >= MS_IN_SEC) {
      d.seconds = (d.seconds ?? 0) + Math.floor(d.milliseconds / MS_IN_SEC);
      d.milliseconds %= MS_IN_SEC;
    }
    if (d.seconds && d.seconds >= SEC_IN_MIN) {
      d.minutes = (d.minutes ?? 0) + Math.floor(d.seconds / SEC_IN_MIN);
      d.seconds %= SEC_IN_MIN;
    }
    if (d.minutes && d.minutes >= MIN_IN_HOUR) {
      d.hours = (d.hours ?? 0) + Math.floor(d.minutes / MIN_IN_HOUR);
      d.minutes %= MIN_IN_HOUR;
    }
    if (d.hours && d.hours >= HOUR_IN_DAY) {
      d.days = (d.days ?? 0) + Math.floor(d.hours / HOUR_IN_DAY);
      d.hours %= HOUR_IN_DAY;
    }
    if (d.days && d.days >= DAY_IN_WEEK) {
      d.weeks = (d.weeks ?? 0) + Math.floor(d.days / DAY_IN_WEEK);
      d.days %= DAY_IN_WEEK;
    }
    return d;
  }

  /**
   * Returns a locale-aware human-readable string via Intl.DurationFormat.
   *
   * @param options.locale  - BCP 47 locale (default: runtime locale).
   * @param options.concise - true  -> "narrow" style  ("2h 30m")
   *                          false -> "long"   style  ("2 hours, 30 minutes")
   *
   * Replaces the old hand-rolled unit-label loop entirely. Decades, centuries,
   * and millennia are collapsed into years before handing off to Intl, since
   * those units are outside the Intl.DurationFormat spec.
   */
  toHumanReadableString(options?: { locale?: string; concise?: boolean }): string {
    const { locale, concise = false } = options ?? {};
    return formatWithIntl(this, locale, concise ? 'narrow' : 'long');
  }

  /**
   * Formats the duration with full Intl.DurationFormat style control.
   * Prefer this over toHumanReadableString when you need "short" or "digital".
   *
   * @example
   * new Duration({ hours: 1, minutes: 30 }).formatIntl('en', 'digital'); // "1:30:00"
   * new Duration({ hours: 1, minutes: 30 }).formatIntl('de', 'long');    // "1 Stunde und 30 Minuten"
   */
  formatIntl(locale?: string, style: Intl.DurationFormatStyle = 'long'): string {
    return formatWithIntl(this, locale, style);
  }

  roundTo(unit: keyof DurationRecord): Duration {
    const divisors: Record<keyof DurationRecord, number> = {
      millennia: MS_IN_YEAR * 1000,
      centuries: MS_IN_YEAR * 100,
      decades: MS_IN_YEAR * 10,
      years: MS_IN_YEAR,
      months: MS_IN_MONTH,
      weeks: MS_IN_DAY * 7,
      days: MS_IN_DAY,
      hours: MS_IN_DAY / 24,
      minutes: MS_IN_SEC * 60,
      seconds: MS_IN_SEC,
      milliseconds: 1,
    };
    return new Duration({ [unit]: Math.round(this._toTotalMillis() / divisors[unit]) });
  }

  /**
   * Formats the duration using a custom token pattern.
   * Tokens: Y M W D H m s ms  (unchanged from the original API).
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
    const unitMs: Record<keyof DurationRecord, number> = {
      millennia: MS_IN_YEAR * 1000,
      centuries: MS_IN_YEAR * 100,
      decades: MS_IN_YEAR * 10,
      years: MS_IN_YEAR,
      months: MS_IN_MONTH,
      weeks: MS_IN_DAY * 7,
      days: MS_IN_DAY,
      hours: MS_IN_DAY / 24,
      minutes: MS_IN_SEC * 60,
      seconds: MS_IN_SEC,
      milliseconds: 1,
    };
    const totalMillis = this._toTotalMillis();
    const chunkMs = unitMs[unit];
    const count = Math.floor(totalMillis / chunkMs);
    const remainder = totalMillis % chunkMs;

    const chunks = Array<Duration>(count).fill(new Duration({ [unit]: 1 }));
    if (remainder > 0) chunks.push(new Duration({ milliseconds: remainder }));
    return chunks;
  }

  add(other: DurationLike): Duration {
    const duration = Duration.fromDurationLike(other);
    const newState: DurationRecord = {};
    const allKeys = new Set([...Object.keys(this), ...Object.keys(duration)]) as Set<
      keyof DurationRecord
    >;
    allKeys.forEach((key) => {
      newState[key] = (this[key] ?? 0) + (duration[key] ?? 0);
    });
    return new Duration(newState).normalize();
  }

  subtract(other: DurationLike): Duration {
    const duration = Duration.fromDurationLike(other);
    const newState: DurationRecord = {};
    const allKeys = new Set([...Object.keys(this), ...Object.keys(duration)]) as Set<
      keyof DurationRecord
    >;
    allKeys.forEach((key) => {
      newState[key] = Math.max(0, (this[key] ?? 0) - (duration[key] ?? 0));
    });
    return new Duration(newState);
  }

  equals(other: DurationLike): boolean {
    try {
      return this._toTotalMillis() === Duration.fromDurationLike(other)._toTotalMillis();
    } catch {
      return false;
    }
  }

  clone(): Duration {
    return new Duration(this);
  }
  isZero(): boolean {
    return this._toTotalMillis() === 0;
  }
  isNegative(): boolean {
    return this._toTotalMillis() < 0;
  }
  isPositive(): boolean {
    return this._toTotalMillis() > 0;
  }

  multiply(factor: number): Duration {
    if (factor < 0) throw new Error('Factor must be a non-negative number.');
    return Duration.fromMilliseconds(this._toTotalMillis() * factor).normalize();
  }

  divide(divisor: number): Duration {
    if (divisor <= 0) throw new Error('Divisor must be a positive number.');
    return Duration.fromMilliseconds(this._toTotalMillis() / divisor).normalize();
  }

  compareTo(other: DurationLike): -1 | 0 | 1 {
    const diff = this._toTotalMillis() - Duration.fromDurationLike(other)._toTotalMillis();
    return diff < 0 ? -1 : diff > 0 ? 1 : 0;
  }

  toISO8601(options?: { format?: 'RFC3339' | 'RFC9557' }): string {
    const { format = 'RFC3339' } = options ?? {};
    let datePart = '';
    let timePart = '';

    if (this.years) datePart += `${Math.floor(this.years)}Y`;
    if (this.months) datePart += `${Math.floor(this.months)}M`;
    if (format === 'RFC9557' && this.weeks) datePart += `${Math.floor(this.weeks)}W`;
    if (this.days) datePart += `${Math.floor(this.days)}D`;

    if (this.hours || this.minutes || this.seconds || this.milliseconds) {
      if (this.hours) timePart += `${Math.floor(this.hours)}H`;
      if (this.minutes) timePart += `${Math.floor(this.minutes)}M`;
      if (this.seconds || this.milliseconds) {
        const totalSeconds = (this.seconds ?? 0) + (this.milliseconds ?? 0) / 1000;
        timePart += `${Math.floor(totalSeconds)}S`;
      }
    }

    return datePart || timePart ? `P${datePart}${timePart ? 'T' + timePart : ''}` : 'PT0S';
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  getTotalMilliseconds(): number {
    return this._toTotalMillis();
  }
  getTotalSeconds(): number {
    return this._toTotalMillis() / MS_IN_SEC;
  }
  getTotalMinutes(): number {
    return this._toTotalMillis() / (MS_IN_SEC * SEC_IN_MIN);
  }
  getTotalHours(): number {
    return this._toTotalMillis() / (MS_IN_SEC * SEC_IN_MIN * MIN_IN_HOUR);
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
    for (const key in this) {
      if (Object.prototype.hasOwnProperty.call(this, key) && typeof this[key] !== 'function') {
        state[key as unknown as keyof DurationRecord] = (this as DurationRecord)[
          key as keyof DurationRecord
        ];
      }
    }
    return state;
  }

  floor(unit: keyof DurationRecord): Duration {
    const newDuration = this.clone();
    const targetIndex = UNITS.indexOf(unit);
    for (let i = targetIndex + 1; i < UNITS.length; i++) delete newDuration[UNITS[i]];
    return newDuration;
  }

  trunc(unitOrLevels?: keyof DurationRecord | number): Duration {
    if (typeof unitOrLevels === 'string') {
      const newDuration = this.clone();
      const targetIndex = UNITS.indexOf(unitOrLevels);
      for (let i = targetIndex + 1; i < UNITS.length; i++) delete newDuration[UNITS[i]];
      return newDuration;
    }

    const levels = unitOrLevels ?? 0;
    const newDuration = this.clone();
    const msIndex = UNITS.findIndex((u) => newDuration[u] && newDuration[u] !== 0);

    if (msIndex === -1) return new Duration({});

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

  static between(date1: DateLike, date2: DateLike): Duration {
    const [lhs, rhs] = [new Date(date1), new Date(date2)];
    let diff = Math.abs(lhs.getTime() - rhs.getTime());
    const state: DurationRecord = {};

    state.years = Math.floor(diff / MS_IN_YEAR);
    diff %= MS_IN_YEAR;
    state.months = Math.floor(diff / MS_IN_MONTH);
    diff %= MS_IN_MONTH;
    state.days = Math.floor(diff / MS_IN_DAY);
    diff %= MS_IN_DAY;
    state.hours = Math.floor(diff / (MS_IN_SEC * SEC_IN_MIN * MIN_IN_HOUR));
    diff %= MS_IN_SEC * SEC_IN_MIN * MIN_IN_HOUR;
    state.minutes = Math.floor(diff / (MS_IN_SEC * SEC_IN_MIN));
    diff %= MS_IN_SEC * SEC_IN_MIN;
    state.seconds = Math.floor(diff / MS_IN_SEC);
    state.milliseconds = diff % MS_IN_SEC;

    return new Duration(state);
  }

  /**
   * Parses an ISO 8601 duration string (RFC 9557 superset - weeks allowed).
   * Delegates structural parsing to parseISOString(); Intl.DurationFormat does
   * not expose a parse API, so the regex remains the correct tool here.
   */
  static fromISO8601(isoString: string): Duration {
    return new Duration(parseISOString(isoString, /* allowWeeks */ true));
  }

  /**
   * Parses an RFC 3339 duration string (no weeks designator).
   */
  static fromRFC3339(rfc3339String: string): Duration {
    return new Duration(parseISOString(rfc3339String, /* allowWeeks */ false));
  }

  /**
   * Parses an RFC 9557 duration string (weeks designator allowed).
   */
  static fromRFC9557(rfc9557String: string): Duration {
    return new Duration(parseISOString(rfc9557String, /* allowWeeks */ true));
  }

  /**
   * Converts any DurationLike value to a Duration instance.
   * String inputs are tried as RFC 9557 -> RFC 3339 -> Date constructor,
   * consistent with the original cascade but now sharing the single
   * parseISOString() implementation.
   */
  static fromDurationLike(d: DurationLike): Duration {
    if (d instanceof Duration) return d;
    if (typeof d === 'number') return Duration.fromMilliseconds(d);
    if (d instanceof Date) return Duration.fromMilliseconds(d.getTime());

    if (typeof d === 'string') {
      try {
        return Duration.fromRFC9557(d);
      } catch {
        /* fall through */
      }
      try {
        return Duration.fromRFC3339(d);
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

  /**
   * Extracts a single component from an RFC 3339 duration string.
   * Uses parseISOString() internally - no duplicate regex.
   */
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
