import { type, type Type } from "arktype";
import type { DocumentSchema, ScalarKind, FieldMeta } from "./schema-port.js";

function assertParsed<T>(value: T | type.errors): T {
  if (value instanceof type.errors) throw new TypeError(`Validation Error: ${value.summary}`);
  return value;
}
function arkFieldMeta(prop: {
  optional?: boolean;
  value: { expression: string; json: unknown };
}): FieldMeta {
  const expression = prop.value.expression;
  const sqlKind = (value: unknown): ScalarKind => {
    if (typeof value === "string")
      return value === "Date"
        ? "date"
        : ["string", "number", "boolean"].includes(value)
          ? (value as ScalarKind)
          : "other";
    if (Array.isArray(value)) {
      const kinds = value
        .filter(
          (v) =>
            v !== "null" &&
            !(v && typeof v === "object" && "unit" in v && (v as { unit: unknown }).unit === null),
        )
        .map(sqlKind);
      return kinds.length > 0 && kinds.every((v) => v === kinds[0]) ? kinds[0] : "other";
    }
    if (value && typeof value === "object") {
      if (
        "proto" in value &&
        (value as { proto: unknown }).proto === "Array" &&
        "sequence" in value &&
        (value as { sequence: unknown }).sequence === "string"
      )
        return "string-array";
      if ("proto" in value && (value as { proto: unknown }).proto === "Date") return "date";
      if ("domain" in value) return sqlKind((value as { domain: unknown }).domain);
      if ("unit" in value) {
        const unit = (value as { unit: unknown }).unit;
        return unit === null ? "other" : sqlKind(typeof unit);
      }
    }
    return "other";
  };
  const kind = sqlKind(prop.value.json);
  return { kind, optional: prop.optional, nullable: expression.includes("null") };
}

export function arkSchema<T extends Type<any>>(
  schema: T,
): DocumentSchema<T["inferIn"], T["infer"]> {
  const props =
    (
      schema.out as unknown as {
        props?: readonly {
          key: string;
          optional?: boolean;
          value: { expression: string; json: unknown };
        }[];
      }
    ).props ?? [];
  const fields = Object.fromEntries(props.map((p) => [String(p.key), arkFieldMeta(p)]));
  return {
    fields,
    provider: "arktype",
    parseInput(value) {
      return assertParsed(schema(value));
    },
    parseOutput(value) {
      return assertParsed(schema.out(value));
    },
    parsePatch(value) {
      if (Object.keys(value).length === 0) return {};
      const picked = (
        schema as unknown as {
          pick(...names: string[]): (value: unknown) => T["infer"] | type.errors;
        }
      ).pick(...Object.keys(value));
      return assertParsed(picked(value)) as Partial<T["infer"]>;
    },
    parseProjection(value, keys) {
      if (keys.length === 0) return {};
      const picked = (
        schema.out as unknown as {
          pick(...names: string[]): (value: unknown) => T["infer"] | type.errors;
        }
      ).pick(...keys);
      return assertParsed(picked(value)) as Partial<T["infer"]>;
    },
  } as DocumentSchema<T["inferIn"], T["infer"]>;
}
