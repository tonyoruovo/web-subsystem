/**
 * @summary A union type representing various forms of duration input.
 * @description This type can be used to represent dates and times in
 * different formats, providing flexibility in handling date-related data.
 * The "why" is to allow functions and methods to accept multiple types of
 * duration input, making the API more versatile and easier to use. The "how"
 * involves using type unions to define the accepted formats.
 *
 * @example
 * // Using a Date object
 * const date1: DateLike = new Date();
 *
 * @example
 * // Using a string representation
 * const date2: DateLike = "2023-03-15T12:00:00Z";
 *
 * @example
 * // Using a timestamp
 * const date3: DateLike = 1678886400000;
 */
export type DateLike = Date | number | string;

/** Parameters for computing a clamped value i.e {@linkcode computeClamp} */
export type ComputeClampParams = {
  /** The default {@linkcode Number.MAX_SAFE_INTEGER} */
  max?: number;
  /** The default {@linkcode Number.MIN_SAFE_INTEGER} */
  min?: number;
  /** The default is 0 */
  value?: number;
};
