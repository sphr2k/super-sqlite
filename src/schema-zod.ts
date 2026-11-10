import * as z from "zod";
import { assertStableOutput, validateProjectionMetadata } from "./schema-port.js";
import type { DocumentSchema, FieldMeta, FieldMetadata } from "./schema-port.js";

function zodParse<O>(schema: z.ZodType<O>, value: unknown): O {
  const result = schema.safeParse(value);
  if (!result.success) throw new TypeError(z.prettifyError(result.error));
  return result.data;
}

/**
 * Zod 4 adapter. For codecs/transforms supply a non-transforming outputSchema.
 * A transformed schema can additionally supply patchSchema for partial updates.
 */
export function zodSchema<S extends z.ZodType<object>>(
  schema: S,
  options: {
    outputSchema?: z.ZodType<z.output<S>>;
    patchSchema?: z.ZodType<Partial<z.output<S>>>;
    fields: FieldMetadata<z.output<S>>;
  },
): DocumentSchema<z.input<S>, z.output<S>> {
  const output = options.outputSchema ?? schema;
  const fields = options.fields as Record<string, FieldMeta>;

  if (!(schema instanceof z.ZodObject) && !options.outputSchema)
    throw new TypeError("Transformed/pipeline Zod schemas require an explicit outputSchema");
  function checkPatchKeys(value: Record<string, unknown>): void {
    for (const key of Object.keys(value)) {
      if (key === "id" || !Object.hasOwn(fields, key))
        throw new TypeError(`Unknown or immutable patch field: ${key}`);
    }
  }
  return {
    fields,
    provider: "zod",
    parseInput(value) {
      return zodParse(schema, value);
    },
    parseOutput(value) {
      return assertStableOutput(value, zodParse(output, value));
    },
    parsePatch(value) {
      checkPatchKeys(value);
      const patchValidator =
        options.patchSchema ?? (schema instanceof z.ZodObject ? schema.partial() : undefined);
      if (!patchValidator)
        throw new TypeError("Transformed/pipeline Zod schemas require an explicit patchSchema");
      const parsed = zodParse(patchValidator, value) as Partial<z.output<S>>;
      for (const key of Object.keys(parsed)) {
        if (!Object.hasOwn(value, key))
          throw new TypeError(`Patch validator added an unexpected field: ${key}`);
      }
      return parsed;
    },
    parseProjection(value, keys) {
      validateProjectionMetadata(value, keys, fields);
      if (!(output instanceof z.ZodObject))
        throw new TypeError("Scalar projections require an object outputSchema");
      const projection: Record<string, unknown> = {};
      for (const key of keys) {
        const field = output.shape[key];
        if (!field) throw new TypeError(`Unknown projected Zod field: ${key}`);
        const parsed = zodParse(field, value[key]);
        projection[key] = assertStableOutput(value[key], parsed);
      }
      return projection as Partial<z.output<S>>;
    },
  } as DocumentSchema<z.input<S>, z.output<S>>;
}
