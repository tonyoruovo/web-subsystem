import type { ZodType } from 'zod';

import type { StorageSchema } from '../storage.types';

/**
 * Runs schema migrations, both bulk (at boot) and lazy (per read).
 */
export interface IMigrationRunner {
  /**
   * Migrate `data` from `storedVersion` up to `schema.version` by replaying
   * every registered `MigrationStep` in order.
   *
   * Returns the migrated data (un-validated; the pipeline validates after).
   * Throws if any step fails - caller is responsible for rollback.
   *
   * @param data          - Raw data at `storedVersion`.
   * @param storedVersion - The `schema_version` stamped on the stored entry.
   * @param schema        - The target schema (provides `migrations` and `version`).
   */
  migrate<TSchema extends ZodType>(
    data: unknown,
    storedVersion: number,
    schema: StorageSchema<TSchema>,
  ): unknown;

  /**
   * Returns `true` if the stored version is behind the schema version and
   * migrations are needed.
   */
  needsMigration<TSchema extends ZodType>(
    storedVersion: number,
    schema: StorageSchema<TSchema>,
  ): boolean;
}
