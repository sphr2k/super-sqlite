/** Optional Zod 4 provider; use import {documentTable,zodSchema} from 'supersqlite/zod'. */
export { documentTable } from "./factory-core.js";
export { zodSchema } from "./schema-zod.js";
export type { DocumentSchema, FieldMetadata, FieldMeta } from "./schema-port.js";

export { standardSchema } from "./schema-standard.js";

export { createDocumentSnapshotStore } from "./snapshot-core.js";
export type {
  SnapshotHead,
  SnapshotImport,
  SnapshotPage,
  SnapshotRecord,
  BeginResult,
} from "./snapshot-core.js";
export {
  SnapshotConflictError,
  SnapshotNotFoundError,
  IncompleteSnapshotError,
} from "./snapshot-core.js";
