import type { Type } from "arktype";
import { documentTable, RevisionConflictError, DocumentNotFoundError } from "./factory-core.js";
import { arkSchema } from "./schema-arktype.js";
import type { DocumentSchema } from "./schema-port.js";
import type { SQLiteAdapter } from "./adapters/types.js";
import type { DocumentEvolution } from "./document.js";
import type { DerivedIndexOptions } from "./derived-indexes.js";
import type { QueryableKeys } from "./query.js";
import type { Repository } from "./repository-types.js";
export { documentTable, RevisionConflictError, DocumentNotFoundError };

/** Backwards compatible ArkType entrypoint; the core accepts any DocumentSchema. */
export function arktypeJsonTable<T extends Type<any>, const Name extends string>(
  typeName: string,
  schema: T,
  tableName: Name,
  adapter: SQLiteAdapter,
  indexFields: readonly QueryableKeys<T["infer"] & { id: string }>[] = [],
  options: { evolution?: DocumentEvolution; indexes?: DerivedIndexOptions<T["infer"]> } = {},
): Repository<DocumentSchema<T["inferIn"], T["infer"]>, Name> {
  return documentTable(typeName, arkSchema(schema), tableName, adapter, indexFields, options);
}
