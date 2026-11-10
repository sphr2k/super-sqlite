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
  readonly provider?: "arktype" | "zod";
  parseInput(value: unknown): O;
  parseOutput(value: unknown): O;
  parsePatch(value: Record<string, unknown>): Partial<O>;
  parseProjection(value: Record<string, unknown>, keys: readonly string[]): Partial<O>;
}
