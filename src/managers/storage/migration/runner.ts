import type { ZodType } from 'zod';

import type { StorageSchema } from '../storage.types';

import type { IMigrationRunner } from './types';

export class MigrationRunner implements IMigrationRunner {
  needsMigration<TSchema extends ZodType>(
    storedVersion: number,
    schema: StorageSchema<TSchema>,
  ): boolean {
    return storedVersion < schema.version;
  }

  migrate<TSchema extends ZodType>(
    data: unknown,
    storedVersion: number,
    schema: StorageSchema<TSchema>,
  ): unknown {
    if (!this.needsMigration(storedVersion, schema)) return data;
    if (!schema.migrations || schema.migrations.length === 0) {
      throw new Error(
        `[MigrationRunner] Stored data is at version ${storedVersion} but ` +
          `schema is at version ${schema.version} and no migrations are registered.`,
      );
    }

    // Build a sorted map: fromVersion => transform
    const steps = new Map(schema.migrations.map((s) => [s.fromVersion, s.transform]));

    let current = data;
    for (let v = storedVersion; v < schema.version; v++) {
      const transform = steps.get(v);
      if (!transform) {
        throw new Error(
          `[MigrationRunner] Missing migration step for version ${v} => ${v + 1}. ` +
            `Cannot migrate from stored version ${storedVersion} to current version ${schema.version}.`,
        );
      }
      try {
        current = transform(current);
      } catch (cause) {
        throw new Error(`[MigrationRunner] Migration step ${v} => ${v + 1} threw an error.`, {
          cause,
        });
      }
    }

    return current;
  }
}
