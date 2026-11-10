import * as z from "zod";
import type { DocumentSchema, FieldMeta, FieldMetadata } from "./schema-port.js";

function zodParse<O>(schema: z.ZodType<O>, value: unknown): O {
  const result = schema.safeParse(value);
  if (!result.success) throw new TypeError(z.prettifyError(result.error));
  return result.data;
}

/** For input transforms, provide outputSchema describing already-transformed stored records. */
export function zodSchema<S extends z.ZodObject<z.ZodRawShape>>(
  schema: S,
  options: { outputSchema?: z.ZodType<z.output<S>>; fields: FieldMetadata<z.output<S>> },
): DocumentSchema<z.input<S>, z.output<S>> {
  const output = options.outputSchema ?? (schema as unknown as z.ZodType<z.output<S>>);
  const fields = options.fields as Record<string, FieldMeta>;
  return {
    fields,
    provider: "zod",
    parseInput(value) {
      return zodParse(schema, value);
    },
    parseOutput(value) {
      return zodParse(output, value);
    },
    parsePatch(value) {
      const result = schema.partial().safeParse(value);
      if (!result.success) throw new TypeError(z.prettifyError(result.error));
      return result.data as Partial<z.output<S>>;
    },
    parseProjection(value, keys) {
      const subset = Object.fromEntries(keys.map((k) => [k, value[k]]));
      const result = output.safeParse({ ...subset });
      // An output schema with required fields unrelated to the selection cannot
      // validate a projection. Validate selected scalar kinds at the query boundary.
      if (!result.success) return subset as Partial<z.output<S>>;
      return Object.fromEntries(
        keys.map((k) => [k, (result.data as Record<string, unknown>)[k]]),
      ) as Partial<z.output<S>>;
    },
  } as DocumentSchema<z.input<S>, z.output<S>>;
}
