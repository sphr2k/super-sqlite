import superjson from "superjson";

export type ScalarKind = "string" | "number" | "boolean" | "date" | "string-array" | "other";
export interface FieldMeta {
  kind: ScalarKind;
  optional?: boolean;
  nullable?: boolean;
}
export type FieldMetadata<O> = Partial<Record<Extract<keyof O, string>, FieldMeta>>;
export interface DocumentSchema<I, O extends object> {
  /** TypeScript-only phantom members, never read at runtime. */
  readonly infer: O;
  readonly inferIn: I;
  readonly fields: Readonly<Record<string, FieldMeta>>;
  readonly provider?: "arktype" | "zod" | "standard";
  parseInput(value: unknown): O;
  parseOutput(value: unknown): O;
  parsePatch(value: Record<string, unknown>): Partial<O>;
  parseProjection(value: Record<string, unknown>, keys: readonly string[]): Partial<O>;
}

/** Canonicalize SuperJSON envelopes to detect *any* output validation mutation. */
function canonical(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, walk(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(walk(superjson.serialize(value)));
}
export function assertStableOutput<T>(original: unknown, parsed: T): T {
  if (canonical(original) !== canonical(parsed)) {
    throw new TypeError(
      "Persisted output validator modified data; supply a non-transforming outputSchema",
    );
  }
  return parsed;
}
export function validateProjectionMetadata(
  value: Record<string, unknown>,
  keys: readonly string[],
  fields: Readonly<Record<string, FieldMeta>>,
): void {
  for (const key of keys) {
    const meta = fields[key];
    if (!meta) throw new TypeError(`Unknown projection field: ${key}`);
    const v = value[key];
    if (v == null) {
      if ((v === undefined && meta.optional) || (v === null && meta.nullable)) continue;
      throw new TypeError(`Missing required projection field: ${key}`);
    }
    const valid =
      meta.kind === "string"
        ? typeof v === "string"
        : meta.kind === "number"
          ? typeof v === "number" && Number.isFinite(v)
          : meta.kind === "boolean"
            ? typeof v === "boolean"
            : meta.kind === "date"
              ? v instanceof Date && !Number.isNaN(v.getTime())
              : meta.kind === "string-array"
                ? Array.isArray(v) && v.every((x) => typeof x === "string")
                : false;
    if (!valid) throw new TypeError(`Invalid projected ${meta.kind} field: ${key}`);
  }
}
