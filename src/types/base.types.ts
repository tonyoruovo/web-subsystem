import type { DateLike } from './utils.type';

import type { NilEntries } from '@/modules/util.dto';

/**
 * An entity that represents an identity with an ID.
 *
 * @interface IIdentity
 */
export interface IIdentity {
  /**
   * The unique identifier of the entity.
   */
  id: string;
}
/**
 * A model type without the standard addons
 *
 * @template T the type of model to strip
 */
export type StrippedModel<T> = Omit<T, keyof BaseEntity>;
/**
 * Extracts all non-{@linkcode BaseEntity} properties that are not nullable or undefined
 *
 * @template T the type of the model
 */
export type RequiredStrippedModel<T> = Omit<T, keyof (BaseEntity & NilEntries<StrippedModel<T>>)>;

/**
 * A utility type that makes T nullable. The following rules apply:
 * 1. If T is null or undefined (if PURE is true), the result is null | undefined
 * 2. For all other types, the result is T | null | undefined
 * 3. If T is an array, applies rule 1 & 2 recursively to each element of the array
 * 4. If T is an object, applies rule 1 & 2 recursively to each property of the object
 *
 * @template T - The type to transform.
 * @template PURE - A marker type to indicate only `null` will represent nullability (default: false)
 */
export type Nullable<T, PURE extends boolean = false> = PURE extends false
  ? T extends null | undefined
    ? null | undefined
    : T extends Array<infer U>
      ? Array<Nullable<U, PURE>>
      : T extends object
        ? {
            [K in keyof T]: Nullable<T[K], PURE>;
          }
        : T | null | undefined
  : T extends null | undefined
    ? null
    : T extends Array<infer U>
      ? Array<Nullable<U, PURE>>
      : T extends object
        ? {
            [K in keyof T]: Nullable<T[K], PURE>;
          }
        : T | null;

/**
 * An entity that tracks creation and update timestamps.
 *
 * @interface IDated
 */
export interface IDated {
  /**
   * The creation timestamp of the entity.
   */
  createdAt: DateLike;
  /**
   * The last update timestamp of the entity.
   */
  updatedAt?: DateLike | null;
}

/**
 * An entity that tracks which users created and last updated it.
 *
 * @interface IDerived
 */
export interface IDerived {
  /** The foreign key ID of the user who created this entity */
  createdById: string | null;
  /** The foreign key ID of the user who last updated this entity */
  updatedById: string | null;
}

/**
 * An entity that can be soft-deleted, tracking deletion timestamp and user.
 *
 * @interface IRestorable
 */
export interface IRestorable {
  /** The timestamp when this entity was deleted */
  deletedAt: DateLike | null;
  /** The foreign key ID of the user who deleted this entity */
  deletedById: string | null;
}
/**
 * The entity that can be referenced by its {@link IIdentity.id unique id}, has it's
 * {@link IDated.createdAt creation} and last {@link IDated.updatedAt updated} dates
 * with the user-id of the account that submitted these changes ({@link IDerived.createdById created}
 * & {@link IDerived.updatedById updated} times) and can be
 * {@link IRestorable.deletedAt scheduled for deletion} or restored with a reference
 * (by setting the deleted time to `null`)
 * to the {@link IRestorable.deletedById user-id that has attempted the delete action}
 */
export type IBaseEntity = IIdentity & IDated & Nullable<IDerived> & Nullable<IRestorable>;

/**
 * Pagination metadata for paginated responses.
 */
export interface IPaginationMeta {
  /** Current page number (1-based) */
  page: number;

  /** Number of items per page */
  limit: number;

  /** Total number of items */
  total: number;

  /** Total number of pages */
  totalPages: number;

  /** Whether there is a next page */
  hasNext: boolean;

  /** Whether there is a previous page */
  hasPrev: boolean;
}

export type StripPaginationData<T> = Omit<T, 'page' | 'limit' | 'sortBy' | 'sortOrder'>;
/**
 * The type for db query operation
 */
export type IQuery<T extends IBaseEntity> = Record<
  keyof Omit<T, keyof IDated | 'deletedAt'>,
  unknown
>;

/** The implementation of {@linkcode IIdentity} that allows the filed name extraction for use in structural comparisons */
class Identity implements IIdentity {
  constructor(public id: string) {}
}
/** The implementation of {@linkcode IDated} that allows the filed name extraction for use in structural comparisons */
class Dated implements IDated {
  constructor(
    public createdAt: DateLike,
    public updatedAt?: DateLike | null,
  ) {}
}
/** The implementation of {@linkcode IDerived} that allows the filed name extraction for use in structural comparisons */
class Derived implements Nullable<IDerived> {
  constructor(
    public createdById: string | null = null,
    public updatedById: string | null = null,
  ) {}
}
/** The implementation of {@linkcode IRestorable} that allows the filed name extraction for use in structural comparisons */
class Restorable implements Nullable<IRestorable> {
  constructor(
    public deletedAt: DateLike | null = null,
    public deletedById: string | null = null,
  ) {}
}
/** The implementation of {@linkcode IBaseEntity} that allows the filed name extraction for use in structural comparisons */
class BaseEntity implements IBaseEntity {
  constructor(
    public id: string,
    public createdAt: DateLike,
    public updatedAt: DateLike | null = null,
    public createdById: string | null = null,
    public updatedById: string | null = null,
    public deletedAt: DateLike | null = null,
    public deletedById: string | null = null,
  ) {}
}

// WARNING: Not for public consumption
const __$identityDoppelganger__$ = new Identity('ae7acf1a-fe13-43d6-bb2b-a5a759ec60f7');
const __$datedDoppelganger__$ = new Dated('2026-02-28T07:43:55.227Z', new Date());
const __$derivedDoppelganger__$ = new Derived(
  'e2fc4884-83fe-4a42-a34f-a2c2f4a44110',
  'e2fc4884-83fe-4a42-a34f-a2c2f4a44110',
);
const __$restorableDoppelganger__$ = new Restorable(
  1772264989208,
  'e2fc4884-83fe-4a42-a34f-a2c2f4a44110',
);
const __$baseEntityDoppelganger__$ = new BaseEntity(
  'ae7acf1a-fe13-43d6-bb2b-a5a759ec60f7',
  '2026-02-28T07:43:55.227Z',
  new Date(),
  'e2fc4884-83fe-4a42-a34f-a2c2f4a44110',
  'e2fc4884-83fe-4a42-a34f-a2c2f4a44110',
  1772264989208,
  'e2fc4884-83fe-4a42-a34f-a2c2f4a44110',
);
/** Field names of {@linkcode IIdentity} for structural comparison */
export const IDENTITY_KEYS = Object.freeze(
  Object.keys(__$identityDoppelganger__$) as (keyof IIdentity)[],
);
/** Field names of {@linkcode IDated} for structural comparison */
export const DATED_KEYS = Object.freeze(Object.keys(__$datedDoppelganger__$) as (keyof IDated)[]);
/** Field names of {@linkcode IDerived} for structural comparison */
export const DERIVED_KEYS = Object.freeze(
  Object.keys(__$derivedDoppelganger__$) as (keyof IDerived)[],
);
/** Field names of {@linkcode IRestorable} for structural comparison */
export const RESTORABLE_KEYS = Object.freeze(
  Object.keys(__$restorableDoppelganger__$) as (keyof IRestorable)[],
);
/** Field names of {@linkcode IBaseEntity} for structural comparison */
export const BASE_ENTITY_KEYS = Object.freeze(
  Object.keys(__$baseEntityDoppelganger__$) as (keyof IBaseEntity)[],
);
