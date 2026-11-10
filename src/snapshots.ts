/** Backwards-compatible ArkType entrypoint, delegating to validator-neutral snapshot core. */
import type { Type } from "arktype";
import { arkSchema } from "./schema-arktype.js";
import type { SQLiteAdapter } from "./adapters/types.js";
import { createDocumentSnapshotStore } from "./snapshot-core.js";

export * from "./snapshot-core.js";
export function createSnapshotStore<T extends Type<any>>(
  name: string,
  schema: T,
  adapter: SQLiteAdapter,
) {
  return createDocumentSnapshotStore(name, arkSchema(schema), adapter);
}
