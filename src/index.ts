/** Side-effect-free public entrypoint, safe to import in Cloudflare Workers. */
export { arktypeJsonTable, RevisionConflictError, DocumentNotFoundError } from './factory.js';
export { DocumentVersionError, serializeDocument, readDocument } from './document.js';
export type { DocumentEvolution } from './document.js';
export type { SQLiteAdapter, SqlStatement, SqlRow, BindValue } from './adapters/types.js';
export type { QueryBuilder, SqlScalar, QueryableKeys, FilterFields } from './query.js';
export type { IndexApplyOptions, IndexOperation } from './indexes.js';
export type { Repository, JoinBuilder, JoinFields, Entity } from './repository-types.js';
