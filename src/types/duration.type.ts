/**
 * @fileoverview Data Transfer Objects and types for duration representation and manipulation.
 *
 * @summary This file defines various types and interfaces for representing durations,
 * providing a foundation for duration-related operations and calculations.
 */

import type { DateLike } from './utils.type';

/**
 * @summary A record type defining the structure of duration components.
 * @description
 * This interface represents a plain object that holds optional numeric values for various time units,
 * allowing flexible representation of durations. It serves as the foundational data structure for duration
 * calculations, enabling operations like addition, subtraction, normalization, and serialization.
 *
 * The "why" is to provide a type-safe, extensible way to define durations without methods, making it
 * suitable for data transfer, storage, and manipulation. The "how" involves defining properties for each
 * time unit, where each property is optional and represents the quantity of that unit in the duration.
 *
 * @example
 * ```ts
 * // Basic usage for a duration of 2 hours and 30 minutes
 * const durationRecord: DurationRecord = { hours: 2, minutes: 30 };
 * ```
 * @example
 * ```ts
 * // In game development, representing cooldown periods
 * const cooldown: DurationRecord = { seconds: 45, milliseconds: 500 };
 * ```
 * @example
 * ```ts
 * // In physics simulations, defining time steps
 * const timeStep: DurationRecord = { milliseconds: 16 }; // ~60 FPS
 * ```
 * @example
 * ```ts
 * // Handling large durations in historical data
 * const historicalPeriod: DurationRecord = { years: 100, months: 6 };
 * ```
 *
 * @remarks
 * Edge cases include:
 * - All properties undefined: Represents a zero duration.
 * - Negative values: Not enforced by the type, but methods using this may clamp or throw errors.
 * - Fractional values: Allowed, but interpretation depends on the context (e.g., seconds can be fractional).
 *
 * Exceptions and errors: None directly from the type, but consuming code may validate or normalize values.
 *
 * @see {@link DurationDefinition} For the full interface with methods.
 * @see {@link DurationLike} For union types that include this record.
 */
export interface DurationRecord {
  /**
   * The number of milliseconds (1/1000 of a second).
   *
   * @example
   * // In animation timings
   * const animation: DurationRecord = { milliseconds: 300 };
   *
   * @example
   * // For high-precision timing in games
   * const frameTiming: DurationRecord = { milliseconds: 16.67 }; // ~60fps
   */
  milliseconds?: number;

  /**
   * The number of seconds (60 seconds = 1 minute).
   *
   * @example
   * // For countdown timers
   * const countdown: DurationRecord = { seconds: 30 };
   *
   * @example
   * // For animation durations
   * const transition: DurationRecord = { seconds: 1.5 };
   */
  seconds?: number;

  /**
   * The number of minutes (60 minutes = 1 hour).
   *
   * @example
   * // For meeting durations
   * const meeting: DurationRecord = { minutes: 45 };
   *
   * @example
   * // For cooking timers
   * const cookingTime: DurationRecord = { minutes: 12 };
   */
  minutes?: number;

  /**
   * The number of hours (24 hours = 1 day).
   *
   * @example
   * // For event durations
   * const workshop: DurationRecord = { hours: 3 };
   *
   * @example
   * // For long-running processes
   * const buildProcess: DurationRecord = { hours: 2, minutes: 45 };
   */
  hours?: number;

  /**
   * The number of days (1 day = 24 hours).
   *
   * @example
   * // For project deadlines
   * const timeRemaining: DurationRecord = { days: 3 };
   *
   * @example
   * // For vacation lengths
   * const vacation: DurationRecord = { days: 14 };
   */
  days?: number;

  /**
   * The number of weeks (1 week = 7 days).
   *
   * @example
   * // For sprint durations in agile development
   * const sprint: DurationRecord = { weeks: 2 };
   *
   * @example
   * // For subscription periods
   * const trialPeriod: DurationRecord = { weeks: 1 };
   */
  weeks?: number;

  /**
   * The number of months (variable length, typically 28-31 days).
   * Note: Months are approximated in calculations due to their variable length.
   *
   * @example
   * // For subscription periods
   * const subscription: DurationRecord = { months: 3 };
   *
   * @example
   * // For project timelines
   * const projectDuration: DurationRecord = { months: 6, weeks: 2 };
   */
  months?: number;

  /**
   * The number of years (typically 365 or 366 days).
   * Note: Years may be approximated in calculations to handle leap years.
   *
   * @example
   * // For contract durations
   * const contract: DurationRecord = { years: 1 };
   *
   * @example
   * // For historical time spans
   * const periodLength: DurationRecord = { years: 5 };
   */
  years?: number;

  /**
   * The number of decades (1 decade = 10 years).
   *
   * @example
   * // For historical analysis
   * const historicalPeriod: DurationRecord = { decades: 2 };
   *
   * @example
   * // For long-term projections
   * const forecast: DurationRecord = { decades: 3, years: 5 };
   */
  decades?: number;

  /**
   * The number of centuries (1 century = 100 years).
   *
   * @example
   * // For historical timelines
   * const historicalSpan: DurationRecord = { centuries: 2 };
   *
   * @example
   * // For archaeological dating
   * const artifactAge: DurationRecord = { centuries: 4, decades: 3 };
   */
  centuries?: number;

  /**
   * The number of millennia (1 millennium = 1000 years).
   *
   * @example
   * // For geological time periods
   * const geologicalEra: DurationRecord = { millennia: 2 };
   *
   * @example
   * // For archaeological or paleontological timescales
   * const fossilAge: DurationRecord = { millennia: 3, centuries: 5 };
   */
  millennia?: number;
}

/**
 * @summary Interface defining the contract for duration operations and properties.
 * @description
 * This interface outlines the complete API for working with durations, including methods for arithmetic,
 * comparison, formatting, and conversion. It ensures that any implementation provides a consistent set of
 * functionalities for manipulating time intervals.
 *
 * The "why" is to standardize duration handling across the application, enabling polymorphism and
 * interchangeability of duration implementations. The "how" combines data properties from DurationRecord
 * with method signatures for operations like normalization, addition, and serialization.
 * @example
 * ```ts
 * // Implementing a custom duration class
 * class CustomDuration implements IDuration {
 *   constructor(private data: DurationRecord) {
 *     // Initialize with data
 *   }
 *   // ... implement all methods
 * }
 * ```
 * @example
 * ```ts
 * // Using in game timers for countdowns
 * const timer: IDuration = new CustomDuration({ minutes: 5 });
 * if (timer.isGreaterThan({ seconds: 30 })) {
 *   console.log("More than 30 seconds left");
 * }
 * ```
 * @example
 * ```ts
 * // In scheduling systems for event durations
 * const eventDuration: IDuration = new CustomDuration({ hours: 2, minutes: 30 });
 * const endTime = eventDuration.toDate(new Date());
 * ```
 * Edge cases include:
 * - Zero durations: Methods like isZero() handle this.
 * - Negative results in subtraction: Clamped to zero.
 * - Large values: Normalization may be needed for display.
 * - Fractional seconds: Handled in serialization methods.
 *
 * Exceptions and errors: Methods may throw for invalid inputs (e.g., negative factors in multiply).
 *
 * @see {@link DurationRecord} For the data structure.
 * @see {@link DurationDefinition} For the combined type.
 * @see {@link Duration} For the concrete implementation.
 */
export interface IDuration {
  /**
   * Converts the duration to a `Date` object relative to a given reference date.
   * If no date is provided, the current date and time is used.
   * @param fromDate - The reference date from which to compute the result (default is `new Date()`).
   * @param direction - Either "future" or "past". Determines the direction of the duration (default is "future").
   * @returns A new `Date` object after applying the duration.
   */
  toDate(fromDate?: DateLike, direction?: 'future' | 'past'): Date;

  /**
   * Computes a past date by subtracting the duration from a given reference date.
   * @param {DateLike} fromDate the reference date
   * @returns {Date} the computed past date
   */
  ago(fromDate?: DateLike): Date;

  /**
   * Computes a future date by adding the duration to a given reference date.
   * @param {DateLike} fromDate the reference date
   * @returns {Date} the computed future date
   */
  fromThen(fromDate?: DateLike): Date;

  /** @see {@link IDuration.fromThen} */
  fromNow(): Date;

  /**
   * ### Without the argument:
   * Normalizes the duration fields by converting overflow (e.g., 90 seconds becomes 1 minute 30 seconds).
   * ### With the argument:
   * Converts the entire duration into a normalized form using only the specified unit.
   * All other fields will be zero or undefined, and the specified unit will contain the full duration value.
   * The operation is immutable. \
   * \
   * Normalizes the duration fields.
   * @param {keyof DurationRecord} [targetUnit] - The unit to normalize to.
   * @param {object} [options] - Optional parameters for normalization.
   * @param {boolean} [options.approximate=false] - Whether to use approximate values for months and years.
   * @returns {DurationDefinition} The normalized duration.
   * @example
   * // Physics Simulation: Normalize a duration to seconds for calculations.
   * const duration = new Duration({ minutes: 2, seconds: 90 });
   * const normalized = duration.normalize('seconds', { approximate: true });
   * console.log(normalized); // { seconds: 210 }
   */
  normalize(
    targetUnit?: keyof DurationRecord,
    options?: { approximate: boolean },
  ): DurationDefinition;

  /**
   * Returns a human-readable string representation of the duration.
   * @param {object} [options] - Optional parameters for formatting.
   * @param {string} [options.locale='en'] - The locale to use for formatting.
   * @param {boolean} [options.concise=false] - Whether to use a concise format.
   * @returns {string} The human-readable string.
   * @example
   * // Game Development: Display a countdown timer to the player.
   * const duration = new Duration({ hours: 1, minutes: 30 });
   * const readable = duration.toHumanReadableString({ locale: 'en', concise: true });
   * console.log(readable); // "1h 30m"
   */
  toHumanReadableString(options?: { locale: string; concise: boolean }): string;

  /**
   * Rounds the duration to the nearest specified unit.
   * @param {keyof DurationRecord} unit - The unit to round to (e.g., "seconds", "minutes").
   * @returns {DurationDefinition} The rounded duration.
   * @example
   * // Physics Simulation: Round a duration to the nearest second for frame calculations.
   * const duration = new Duration({ milliseconds: 1234 });
   * const rounded = duration.roundTo('seconds');
   * console.log(rounded); // { seconds: 1 }
   */
  roundTo(unit: keyof DurationRecord): DurationDefinition;

  /**
   * Formats the duration using a custom pattern.
   * @param {string} pattern - The pattern to use for formatting (e.g., "Y years, M months, D days").
   * @returns {string} The formatted string.
   * @example
   * // Game Development: Display a duration in a custom format for a quest timer.
   * const duration = new Duration({ years: 1, months: 2, days: 3 });
   * const formatted = duration.format("Y years, M months, D days");
   * console.log(formatted); // "1 year, 2 months, 3 days"
   */
  format(pattern: string): string;

  /**
   * Splits the duration into smaller chunks based on a specified unit.
   * @param {keyof DurationRecord} unit - The unit to split by (e.g., "hours", "minutes").
   * @returns {DurationDefinition[]} An array of smaller durations.
   * @example
   * // Game Development: Split a duration into hourly chunks for a time-based event.
   * const duration = new Duration({ hours: 5 });
   * const chunks = duration.split('hours');
   * console.log(chunks); // [{ hours: 1 }, { hours: 1 }, { hours: 1 }, { hours: 1 }, { hours: 1 }]
   */
  split(unit: keyof DurationRecord): DurationDefinition[];

  /**
   * Adds another DurationLike to the current one and returns the resulting duration.
   * Fields are summed and then normalized.
   * @param other - Another duration to add
   */
  add(other: DurationLike): DurationDefinition;

  /**
   * Subtracts another DurationLike from the current one and returns the resulting duration.
   * Negative results are clamped to zero in each field.
   * @param other - The duration to subtract
   */
  subtract(other: DurationLike): DurationDefinition;

  /**
   * Checks if the current duration is equal to another duration (after normalization).
   * @param other - The duration to compare with
   */
  equals(other: DurationLike): boolean;

  /**
   * Returns a deep copy of this `DurationDefinition` object.
   */
  clone(): DurationDefinition;

  /**
   * Returns `true` if all duration fields are zero or undefined (i.e., the duration is effectively zero).
   */
  isZero(): boolean;

  /**
   * @summary Checks if the duration represents a negative time span.
   * @description
   * Determines whether this duration represents a negative time interval by examining
   * the sign of duration fields. A duration is considered negative if any of its
   * non-zero components have negative values. This method is useful for validation and
   * time-related calculations where the sign of the duration matters.
   *
   * Implementation recommendations:
   * - Return `true` if any time unit has a negative value
   * - Return `false` if all time units are positive or zero
   * - Return `false` if the duration has no defined properties (empty object)
   * - Implementations should examine all properties from milliseconds to millennia
   *
   * @returns {boolean} `true` if any component of the duration is negative, otherwise `false`
   *
   * @example
   * ```typescript
   * // Financial application: Validate that a payment term is not negative
   * function validatePaymentTerm(term: DurationDefinition): boolean {
   *   if (term.isNegative()) {
   *     console.error('Payment term cannot be negative');
   *     return false;
   *   }
   *   return true;
   * }
   *
   * const validTerm = new Duration({ days: 30 });
   * const invalidTerm = new Duration({ days: -5 });
   *
   * console.log(validatePaymentTerm(validTerm)); // true
   * console.log(validatePaymentTerm(invalidTerm)); // false
   * ```
   *
   * @example
   * ```typescript
   * // Time-tracking application: Calculate time difference
   * function getWorkTimeBalance(hoursWorked: DurationDefinition,
   *                            requiredHours: DurationDefinition): DurationDefinition {
   *   const difference = hoursWorked.subtract(requiredHours);
   *
   *   if (difference.isNegative()) {
   *     console.log('You have a time deficit');
   *   } else {
   *     console.log('You have fulfilled or exceeded your time requirement');
   *   }
   *
   *   return difference;
   * }
   *
   * const worked = new Duration({ hours: 35 });
   * const required = new Duration({ hours: 40 });
   * const balance = getWorkTimeBalance(worked, required);
   * // Output: "You have a time deficit"
   * ```
   *
   * @example
   * ```typescript
   * // Physics simulation: Ensure time deltas are forward-moving
   * function simulateParticleMotion(position: Vector,
   *                               timeStep: DurationDefinition): Vector {
   *   if (timeStep.isNegative()) {
   *     throw new Error('Cannot simulate with negative time step');
   *   }
   *
   *   // Calculate new position based on time step
   *   return calculateNewPosition(position, timeStep.getTotalSeconds());
   * }
   * ```
   *
   * Edge cases:
   * - Mixed signs: If some components are positive and others negative, the method
   *   should still return `true` as the duration contains negative components
   * - Zero values: Components with value 0 should be ignored when determining negativity
   * - Empty duration: If all components are undefined, the duration should not be
   *   considered negative
   *
   * Exceptions:
   * - This method should not throw exceptions
   *
   * @see {@link DurationRecord} For the structure of duration data
   * @see {@link normalize} For converting durations to a single unit
   * @see {@link isZero} For checking if a duration is zero
   */
  isNegative(): boolean;

  /**
   * @summary Checks if the duration represents a positive time span.
   * @description
   * Determines whether this duration represents a positive time interval by examining
   * the sign of duration fields. A duration is considered positive if at least one of its
   * components has a positive value and none have negative values. This method is useful for
   * validation and time-related calculations where the direction of time matters.
   *
   * Implementation recommendations:
   * - Return `true` if at least one time unit has a positive value and none are negative
   * - Return `false` if any time unit has a negative value
   * - Return `false` if the duration has no defined properties or all values are zero
   * - Implementations should examine all properties from milliseconds to millennia
   *
   * @returns {boolean} `true` if the duration is positive, otherwise `false`
   *
   * @example
   * ```typescript
   * // Project management: Check if a task has positive remaining time
   * function hasRemainingTime(task: { timeLeft: DurationDefinition }): boolean {
   *   if (task.timeLeft.isPositive()) {
   *     console.log('Task still has time remaining');
   *     return true;
   *   } else {
   *     console.log('Task time has expired or wasn\'t set');
   *     return false;
   *   }
   * }
   *
   * const activeTask = { timeLeft: new Duration({ hours: 2 }) };
   * const completedTask = { timeLeft: new Duration() };
   *
   * console.log(hasRemainingTime(activeTask)); // true
   * console.log(hasRemainingTime(completedTask)); // false
   * ```
   *
   * @example
   * ```typescript
   * // Financial application: Verify account balance changes
   * function analyzeTransaction(before: number, after: number): void {
   *   const change = new Duration({ cents: after - before });
   *
   *   if (change.isPositive()) {
   *     console.log('Deposit detected');
   *   } else if (change.isNegative()) {
   *     console.log('Withdrawal detected');
   *   } else {
   *     console.log('No balance change');
   *   }
   * }
   *
   * analyzeTransaction(5000, 5500); // "Deposit detected"
   * analyzeTransaction(5000, 4500); // "Withdrawal detected"
   * analyzeTransaction(5000, 5000); // "No balance change"
   * ```
   *
   * @example
   * ```typescript
   * // Healthcare application: Track patient recovery progress
   * function evaluateRecovery(measurements: {
   *   initialCapacity: number,
   *   currentCapacity: number
   * }): string {
   *   const difference = new Duration({
   *     percent: currentCapacity - initialCapacity
   *   });
   *
   *   if (difference.isPositive()) {
   *     return 'Patient showing improvement';
   *   } else if (difference.isNegative()) {
   *     return 'Patient condition declining';
   *   } else {
   *     return 'Patient condition stable';
   *   }
   * }
   * ```
   *
   * Edge cases:
   * - Mixed signs: If any component is negative, the method should return `false`
   *   even if there are also positive components
   * - Zero values: A duration with only zero values should return `false`
   * - Empty duration: If all components are undefined, the method should return `false`
   *
   * Exceptions:
   * - This method should not throw exceptions
   *
   * @see {@link DurationRecord} For the structure of duration data
   * @see {@link isNegative} For checking if a duration is negative
   * @see {@link isZero} For checking if a duration is zero
   */
  isPositive(): boolean;

  /**
   * Multiplies the entire duration by a scalar value.
   * @param factor - Number to multiply the duration by
   */
  multiply(factor: number): DurationDefinition;

  /**
   * Divides the duration by a scalar value and returns a new duration.
   * @param divisor - Number to divide the duration by
   */
  divide(divisor: number): DurationDefinition;

  /**
   * Compares the current duration to another duration.
   * Returns:
   *  -1 if this duration is less than the other,
   *   0 if they are equal,
   *   1 if this duration is greater than the other.
   * @param other - Another duration to compare against
   */
  compareTo(other: DurationLike): -1 | 0 | 1;

  /**
   * Converts this duration to an ISO 8601 duration string.
   * @param {object} [options] - Optional parameters for formatting.
   * @param {'RFC3339' | 'RFC9557'} [options.format='RFC3339'] - The format to use for the output string.
   * @returns {string} The ISO 8601 duration string.
   * @example
   * // Game Development: Serialize a duration for a save file.
   * const duration = new Duration({ hours: 2, minutes: 30 });
   * const isoString = duration.toISO8601({ format: 'RFC3339' });
   * console.log(isoString); // "PT2H30M"
   */
  toISO8601(options?: { format: 'RFC3339' | 'RFC9557' }): string;

  // Getters for Total Duration
  /**
   * Calculates the total duration expressed in milliseconds.
   * @returns {number} The total duration in milliseconds.
   */
  getTotalMilliseconds(): number;

  /**
   * Calculates the total duration expressed in seconds.
   * @returns {number} The total duration in seconds, including fractional parts.
   */
  getTotalSeconds(): number;

  /**
   * Calculates the total duration expressed in minutes.
   * @returns {number} The total duration in minutes, including fractional parts.
   */
  getTotalMinutes(): number;

  /**
   * Calculates the total duration expressed in hours.
   * @returns {number} The total duration in hours, including fractional parts.
   */
  getTotalHours(): number;

  // Comparison Helpers

  /**
   * Checks if the current duration is greater than another duration.
   * @param {DurationLike} other - The duration to compare against.
   * @returns {boolean} `true` if this duration is greater than the other, otherwise `false`.
   */
  isGreaterThan(other: DurationLike): boolean;

  /**
   * Checks if the current duration is less than another duration.
   * @param {DurationLike} other - The duration to compare against.
   * @returns {boolean} `true` if this duration is less than the other, otherwise `false`.
   */
  isLessThan(other: DurationLike): boolean;

  // Utility and Serialization Methods

  /**
   * Returns a serializable plain object representation of the duration's state.
   * This method is called automatically by `JSON.stringify()`.
   * @returns {DurationRecord} An object containing the duration's properties.
   */
  toJSON(): DurationRecord;

  /**
   * Rounds the duration down to the nearest specified unit, removing all smaller units.
   * @param {keyof DurationRecord} unit - The unit to round down to (e.g., 'hours', 'days').
   * @returns {DurationDefinition} A new `DurationDefinition` object with the rounded-down value.
   * @example
   * // Returns a duration of just { hours: 1 }
   * new Duration({ hours: 1, minutes: 45 }).floor('hours');
   */
  floor(unit: keyof DurationRecord): DurationDefinition;

  /**
   * @summary Truncates the duration to the specified unit or levels.
   * @description
   * This method truncates the duration by removing units smaller than the specified unit or by including a specified number of least significant units.
   *
   * When called with a unit (keyof DurationRecord), it truncates to that unit, removing all smaller units.
   * When called with a number (levels), it truncates to the most significant non-zero unit and includes the specified number of additional least significant units.
   * - Positive levels: Include the most significant unit plus that many lower units.
   * - Zero levels: Include only the most significant unit.
   * - Negative levels: Include units starting from a higher level (e.g., -1 includes the unit above the most significant).
   *
   * Implementation recommendations:
   * - If a unit is provided, remove all properties for units smaller than the specified unit.
   * - If levels is provided, find the most significant non-zero unit and include units from startIndex to endIndex based on levels.
   * - Return a new DurationDefinition instance (immutable operation).
   * - If all units are zero or undefined, return a zero duration.
   * - Units should be processed in order from most significant (millennia) to least significant (milliseconds).
   *
   * @param {keyof DurationRecord} [unit] - The unit to truncate to. If provided, removes all smaller units.
   * @param {number} [levels] - The number of least significant units to include. If provided, truncates relative to the most significant unit.
   * @returns {DurationDefinition} A new duration with truncated units.
   *
   * @example
   * ```typescript
   * // Truncate to a specific unit
   * const duration = new Duration({ hours: 2, minutes: 30, seconds: 45 });
   * const truncated = duration.trunc('hours');
   * console.log(truncated); // { hours: 2 }
   * ```
   *
   * @example
   * ```typescript
   * // Truncate with levels
   * const duration = new Duration({ milliseconds: 444, seconds: 50, minutes: 58, hours: 3, days: 5 });
   * console.log(duration.trunc(1)); // { days: 5, hours: 3 }
   * console.log(duration.trunc(0)); // { days: 5 }
   * console.log(duration.trunc()); // { days: 5 }
   * console.log(duration.trunc(-1)); // { weeks: 0, days: 5 }
   * console.log(duration.trunc(-2)); // { months: 0, weeks: 0, days: 5 }
   * ```
   *
   * Edge cases:
   * - Specified unit has zero value: Still truncates smaller units, keeping the specified unit even if zero.
   * - All units are zero: Returns a zero duration.
   * - Empty duration (all undefined): Returns an empty duration.
   * - Unit not in DurationRecord: Should throw an error or be validated.
   * - Levels result in out-of-bounds indices: Clamp to valid range.
   *
   * Exceptions:
   * - Invalid unit parameter: Throw TypeError if unit is not a valid keyof DurationRecord.
   * - This method should not throw for valid inputs.
   *
   * @see {@link DurationRecord} For the structure of duration data.
   * @see {@link floor} For similar flooring operation.
   * @see {@link normalize} For converting to a single unit.
   */
  trunc(unit?: keyof DurationRecord): DurationDefinition;
  trunc(levels?: number): DurationDefinition;

  /**
   * @summary Returns an array of keys from DurationRecord that have positive values.
   * @description
   * This method examines all duration fields and returns the keys of those that contain positive numeric values.
   * It's useful for identifying which time units contribute to the duration's positive magnitude, enabling
   * selective processing or display of relevant time components.
   *
   * The purpose is to provide insight into the composition of positive time intervals, supporting operations
   * like selective formatting, validation, or analysis of duration components. The method only considers
   * strictly positive values (> 0), ignoring zero or negative values.
   *
   * Implementation recommendations:
   * - Iterate through all properties of DurationRecord
   * - Include only keys where the value is a number greater than 0
   * - Return keys in their natural order (from most significant to least significant unit)
   * - Return an empty array if no positive values exist
   * - Do not modify the original duration (pure function)
   *
   * @returns {(keyof DurationRecord)[]} An array of keys with positive values, ordered from most to least significant.
   *
   * @example
   * ```typescript
   * // Analytics: Identify which time units are actively contributing to a duration
   * const sessionDuration = new Duration({ hours: 2, minutes: 30, seconds: 0, milliseconds: -100 });
   * const activeUnits = sessionDuration.getPositiveKeys();
   * console.log(activeUnits); // ['hours', 'minutes']
   * ```
   *
   * @example
   * ```typescript
   * // UI rendering: Dynamically show only relevant time units in a countdown
   * const countdown = new Duration({ days: 1, hours: 0, minutes: 45, seconds: 30 });
   * const displayUnits = countdown.getPositiveKeys();
   * // Render only days, minutes, and seconds in the UI
   * console.log(displayUnits); // ['days', 'minutes', 'seconds']
   * ```
   *
   * @example
   * ```typescript
   * // Validation: Check if a duration has any positive time components
   * const timeEntry = new Duration({ hours: -1, minutes: 30 });
   * const hasPositiveTime = timeEntry.getPositiveKeys().length > 0;
   * console.log(hasPositiveTime); // true (has minutes)
   * ```
   *
   * Edge cases:
   * - All values are zero or negative: Returns empty array
   * - All values are undefined: Returns empty array
   * - Mixed positive and negative values: Only includes positive keys
   * - Fractional positive values: Included as long as > 0
   *
   * Exceptions:
   * - This method should not throw exceptions under normal circumstances
   * - May throw if the duration object is malformed, but implementations should handle gracefully
   *
   * @see {@link DurationRecord} For the structure of duration data
   * @see {@link isPositive} For checking if the entire duration is positive
   * @see {@link isZero} For checking if all values are zero
   */
  getPositiveKeys(): (keyof DurationRecord)[];

  /**
   * @summary Returns an array of keys from DurationRecord that have null or undefined values.
   * @description
   * This method examines all duration fields and returns the keys of those that contain null or undefined values.
   * It's useful for identifying which time units are not set or are explicitly null, enabling
   * selective processing or validation of duration components.
   *
   * The purpose is to provide insight into the unset or null components of a duration, supporting operations
   * like selective formatting, validation, or analysis of duration components. The method only considers
   * null or undefined values, ignoring zero or negative values.
   *
   * Implementation recommendations:
   * - Iterate through all properties of DurationRecord
   * - Include only keys where the value is null or undefined
   * - Return keys in their natural order (from most significant to least significant unit)
   * - Return an empty array if no null/undefined values exist
   * - Do not modify the original duration (pure function)
   *
   * @returns {(keyof DurationRecord)[]} An array of keys with null or undefined values, ordered from most to least significant.
   *
   * @example
   * ```typescript
   * // Analytics: Identify which time units are not set in a duration
   * const sessionDuration = new Duration({ hours: 2, minutes: 30, seconds: null });
   * const unsetUnits = sessionDuration.getNilKeys();
   * console.log(unsetUnits); // ['seconds', 'milliseconds', ...] (depending on implementation)
   * ```
   *
   * @example
   * ```typescript
   * // Validation: Check if a duration has any unset components
   * const timeEntry = new Duration({ hours: 1, minutes: undefined });
   * const hasUnset = timeEntry.getNilKeys().length > 0;
   * console.log(hasUnset); // true (has minutes unset)
   * ```
   *
   * Edge cases:
   * - All values are set: Returns empty array
   * - All values are null/undefined: Returns all keys
   * - Mixed set and unset values: Only includes null/undefined keys
   *
   * Exceptions:
   * - This method should not throw exceptions under normal circumstances
   * - May throw if the duration object is malformed, but implementations should handle gracefully
   *
   * @see {@link DurationRecord} For the structure of duration data
   * @see {@link getPositiveKeys} For checking positive values
   * @see {@link getZeroKeys} For checking zero values
   */
  getNilKeys(): (keyof DurationRecord)[];

  /**
   * @summary Returns an array of keys from DurationRecord that have zero values.
   * @description
   * This method examines all duration fields and returns the keys of those that contain zero numeric values.
   * It's useful for identifying which time units are explicitly set to zero, enabling
   * selective processing or display of relevant time components.
   *
   * The purpose is to provide insight into the zero components of a duration, supporting operations
   * like selective formatting, validation, or analysis of duration components. The method only considers
   * strictly zero values (=== 0), ignoring null, undefined, or non-zero values.
   *
   * Implementation recommendations:
   * - Iterate through all properties of DurationRecord
   * - Include only keys where the value is exactly 0
   * - Return keys in their natural order (from most significant to least significant unit)
   * - Return an empty array if no zero values exist
   * - Do not modify the original duration (pure function)
   *
   * @returns {(keyof DurationRecord)[]} An array of keys with zero values, ordered from most to least significant.
   *
   * @example
   * ```typescript
   * // Analytics: Identify which time units are zero in a duration
   * const sessionDuration = new Duration({ hours: 2, minutes: 0, seconds: 30 });
   * const zeroUnits = sessionDuration.getZeroKeys();
   * console.log(zeroUnits); // ['minutes']
   * ```
   *
   * @example
   * ```typescript
   * // Validation: Check if a duration has any zero components
   * const timeEntry = new Duration({ hours: 1, minutes: 0 });
   * const hasZeros = timeEntry.getZeroKeys().length > 0;
   * console.log(hasZeros); // true (has minutes as zero)
   * ```
   *
   * Edge cases:
   * - All values are non-zero: Returns empty array
   * - All values are zero: Returns all keys
   * - Mixed zero and non-zero values: Only includes zero keys
   * - Null/undefined values: Not included
   *
   * Exceptions:
   * - This method should not throw exceptions under normal circumstances
   * - May throw if the duration object is malformed, but implementations should handle gracefully
   *
   * @see {@link DurationRecord} For the structure of duration data
   * @see {@link isZero} For checking if the entire duration is zero
   * @see {@link getPositiveKeys} For checking positive values
   */
  getZeroKeys(): (keyof DurationRecord)[];

  /**
   * @summary Returns an array of keys from DurationRecord that have negative values.
   * @description
   * This method examines all duration fields and returns the keys of those that contain negative numeric values.
   * It's useful for identifying which time units contribute to the duration's negative magnitude, enabling
   * selective processing or validation of duration components.
   *
   * The purpose is to provide insight into the negative components of a duration, supporting operations
   * like selective formatting, validation, or analysis of duration components. The method only considers
   * strictly negative values (< 0), ignoring zero, positive, null, or undefined values.
   *
   * Implementation recommendations:
   * - Iterate through all properties of DurationRecord
   * - Include only keys where the value is a number less than 0
   * - Return keys in their natural order (from most significant to least significant unit)
   * - Return an empty array if no negative values exist
   * - Do not modify the original duration (pure function)
   *
   * @returns {(keyof DurationRecord)[]} An array of keys with negative values, ordered from most to least significant.
   *
   * @example
   * ```typescript
   * // Analytics: Identify which time units are negative in a duration
   * const sessionDuration = new Duration({ hours: 2, minutes: -30, seconds: 45 });
   * const negativeUnits = sessionDuration.getNegativeKeys();
   * console.log(negativeUnits); // ['minutes']
   * ```
   *
   * @example
   * ```typescript
   * // Validation: Check if a duration has any negative components
   * const timeEntry = new Duration({ hours: 1, minutes: -5 });
   * const hasNegatives = timeEntry.getNegativeKeys().length > 0;
   * console.log(hasNegatives); // true (has minutes as negative)
   * ```
   *
   * Edge cases:
   * - All values are positive or zero: Returns empty array
   * - All values are negative: Returns all keys
   * - Mixed negative and positive values: Only includes negative keys
   * - Null/undefined values: Not included
   *
   * Exceptions:
   * - This method should not throw exceptions under normal circumstances
   * - May throw if the duration object is malformed, but implementations should handle gracefully
   *
   * @see {@link DurationRecord} For the structure of duration data
   * @see {@link isNegative} For checking if the entire duration is negative
   * @see {@link getPositiveKeys} For checking positive values
   */
  getNegativeKeys(): (keyof DurationRecord)[];
}

/**
 * @summary Type alias combining duration data and operations.
 * @description
 * This type represents a complete duration entity that includes both the data structure (DurationRecord)
 * and the operational interface (IDuration). It allows objects to be used both as data containers and
 * as functional units capable of performing duration-related computations.
 *
 * The "why" is to provide a unified type for durations that can be passed around as data but also
 * manipulated through methods. The "how" uses TypeScript's intersection types to merge the record
 * and interface, ensuring type safety and flexibility.
 *
 * @example
 * ```ts
 * // Function accepting a full duration
 * function processDuration(dur: DurationDefinition): string {
 *   return dur.toHumanReadableString();
 * }
 * const duration: DurationDefinition = new Duration({ hours: 1 });
 * console.log(processDuration(duration)); // "1 hour"
 * ```
 * @example
 * ```ts
 * // In API responses for time-based data
 * interface ApiResponse {
 *   duration: DurationDefinition;
 * }
 * ```
 * @example
 * ```ts
 * // Storing durations in state management
 * const state = { timer: new Duration({ seconds: 60 }) as DurationDefinition };
 * ```
 *
 * Edge cases include:
 * - Objects that implement IDuration but not DurationRecord: TypeScript will enforce both.
 * - Partial implementations: Compilation errors if methods are missing.
 * - Serialization: toJSON() returns DurationRecord for plain object conversion.
 *
 * Exceptions and errors: Type-level only; runtime depends on implementation.
 *
 * @see {@link DurationRecord} For the data part.
 * @see {@link IDuration} For the methods part.
 * @see {@link Duration} For the default implementation.
 */
export type DurationDefinition = DurationRecord & IDuration;

/**
 * @summary Union type for various duration representations.
 * @description
 * This type allows flexible input for duration-related functions, accepting multiple formats including
 * the full DurationDefinition, primitive types like numbers and strings, and Date objects. It enables
 * seamless conversion and interoperability between different duration representations.
 *
 * The "why" is to simplify APIs by accepting diverse inputs without requiring manual conversion.
 * The "how" uses a union type to include the comprehensive DurationDefinition, along with common
 * primitives and objects that can represent time intervals.
 *
 * @example
 * ```ts
 * // Function accepting flexible duration inputs
 * function addDuration(base: DurationDefinition, add: DurationLike): DurationDefinition {
 *   return base.add(add);
 * }
 * addDuration(new Duration({ hours: 1 }), 3600000); // Adds 1 hour (in ms)
 * addDuration(new Duration({ hours: 1 }), "PT1H"); // Adds 1 hour (ISO string)
 * ```
 * @example
 * ```ts
 * // In user interfaces for time inputs
 * function setTimer(input: DurationLike): void {
 *   const duration = Duration.fromDurationLike(input);
 *   // ... use duration
 * }
 * setTimer({ minutes: 5 }); // Object
 * setTimer("300000"); // String milliseconds
 * setTimer(new Date(Date.now() + 300000)); // Date
 * ```
 * @example
 * ```ts
 * // Parsing user input in forms
 * const userInput: DurationLike = "2h 30m"; // Custom string
 * const parsed = Duration.fromDurationLike(userInput);
 * ```
 *
 * Edge cases include:
 * - Unsupported types: Conversion methods may throw errors.
 * - Ambiguous strings: Parsing may fail if not RFC-compliant or not supported by the `Date` constructor.
 * - Date objects: Interpreted as milliseconds since epoch.
 * - Numbers: Assumed to be milliseconds unless specified otherwise.
 *
 * Exceptions and errors: Conversion methods like fromDurationLike may throw for invalid inputs.
 *
 * @see {@link DurationDefinition} For the primary duration type.
 * @see {@link Duration.fromDurationLike} For conversion implementation.
 * @see RFC 3339 and RFC 9557 for string formats.
 */
export type DurationLike = DurationDefinition | DateLike | DurationRecord | IDuration;
