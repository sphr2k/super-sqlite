import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { DocumentSchema, FieldMeta, FieldMetadata } from "./schema-port.js";
import { assertStableOutput, validateProjectionMetadata } from "./schema-port.js";

type Input<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S>;
type Output<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>;

function parse<S extends StandardSchemaV1>(schema: S, input: unknown): Output<S> {
  const result = schema["~standard"].validate(input);
  if (result && typeof result === "object" && "then" in result) {
    throw new TypeError("SuperSQLite requires synchronous Standard Schema validators");
  }
  if (result.issues) {
    const message = result.issues
      .map((issue) => {
        const path =
          issue.path
            ?.map((part) => (typeof part === "object" ? String(part.key) : String(part)))
            .join(".") ?? "";
        return `${path ? path + ": " : ""}${issue.message}`;
      })
      .join("; ");
    throw new TypeError(`Validation Error: ${message}`);
  }
  return result.value;
}

/**
 * Generic Standard Schema v1 adapter.
 * The output validator MUST validate the already-persisted shape without mutation.
 * An optional explicit patch schema is required for transforms on partial updates.
 */
export function standardSchema<S extends StandardSchemaV1<unknown, object>>(
  inputSchema: S,
  options: {
    outputSchema?: StandardSchemaV1<unknown, Output<S>>;
    patchSchema?: StandardSchemaV1<unknown, Partial<Output<S>>>;
    fields: FieldMetadata<Output<S>>;
  },
): DocumentSchema<Input<S>, Output<S>> {
  const outputSchema = options.outputSchema ?? inputSchema;
  const fields = options.fields as Record<string, FieldMeta>;
  function checkKeys(input: Record<string, unknown>): void {
    for (const key of Object.keys(input)) {
      if (key === "id" || !Object.hasOwn(fields, key))
        throw new TypeError(`Unknown or immutable patch field: ${key}`);
    }
  }
  return {
    fields,
    provider: "standard",
    parseInput(value) {
      return parse(inputSchema, value);
    },
    parseOutput(value) {
      return assertStableOutput(value, parse(outputSchema, value));
    },
    parsePatch(value) {
      checkKeys(value);
      if (!options.patchSchema) return value as Partial<Output<S>>;
      const parsed = parse(options.patchSchema, value);
      for (const key of Object.keys(parsed)) {
        if (!Object.hasOwn(value, key))
          throw new TypeError(`Patch validator added an unexpected field: ${key}`);
      }
      return parsed;
    },
    parseProjection(value, keys) {
      validateProjectionMetadata(value, keys, fields);
      return Object.fromEntries(keys.map((key) => [key, value[key]])) as Partial<Output<S>>;
    },
  } as DocumentSchema<Input<S>, Output<S>>;
}
