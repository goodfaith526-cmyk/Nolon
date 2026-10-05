import { Injectable } from '@nestjs/common';
import type { ImportKind } from '@nolon/shared';
import type { ImportedRecordLookups, ImportedRecordsInRange } from './import-commit.js';

/**
 * Where each kind of import writes. The module that owns a kind registers its lookup at start-up,
 * so the import commit can tell a requestId reused for another kind without reaching into that
 * module's tables.
 */
@Injectable()
export class ImportRecordsRegistry {
  private readonly byKind = new Map<ImportKind, ImportedRecordsInRange>();

  register(kind: ImportKind, lookup: ImportedRecordsInRange): void {
    this.byKind.set(kind, lookup);
  }

  lookups(): ImportedRecordLookups {
    const get = (kind: ImportKind): ImportedRecordsInRange => {
      const lookup = this.byKind.get(kind);
      if (!lookup) throw new Error(`No import record lookup registered for ${kind}`);
      return lookup;
    };
    return { customers: get('customers'), rates: get('rates') };
  }
}
