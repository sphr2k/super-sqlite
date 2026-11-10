/** Side-effect-free public entrypoint, safe to import in Cloudflare Workers. */
export {
  arktypeJsonTable,
  documentTable,
  RevisionConflictError,
  DocumentNotFoundError,
} from "./factory.js";
export { arkSchema } from "./schema-arktype.js";
export type { DocumentSchema, FieldMetadata, FieldMeta } from "./schema-port.js";
export { DocumentVersionError, serializeDocument, readDocument } from "./document.js";
export type { DocumentEvolution } from "./document.js";
export type { SQLiteAdapter, SqlStatement, SqlRow, BindValue } from "./adapters/types.js";
export type { QueryBuilder, SqlScalar, QueryableKeys, FilterFields } from "./query.js";
export type { IndexApplyOptions, IndexOperation } from "./indexes.js";
export type { Repository, JoinBuilder, JoinFields, Entity } from "./repository-types.js";
export {
  createSnapshotStore,
  SnapshotConflictError,
  SnapshotNotFoundError,
  IncompleteSnapshotError,
} from "./snapshots.js";
export type {
  SnapshotHead,
  SnapshotImport,
  SnapshotPage,
  SnapshotRecord,
  BeginResult,
} from "./snapshots.js";

export { DurableObjectAdapter } from "./adapters/durable-object.js";
export type { DurableObjectStorageLike } from "./adapters/durable-object.js";

export type {
  DerivedIndexOptions,
  DerivedIndexPlan,
  TextField,
  StringArrayField,
} from "./derived-indexes.js";
