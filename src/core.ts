/** Core API without ArkType or Zod runtime imports. */
export { documentTable, RevisionConflictError, DocumentNotFoundError } from "./factory-core.js";
export { serializeDocument, readDocument, DocumentVersionError } from "./document.js";
export type { DocumentSchema, FieldMetadata, FieldMeta } from "./schema-port.js";
export type { DerivedIndexOptions } from "./derived-indexes.js";
export type { SQLiteAdapter } from "./adapters/types.js";
