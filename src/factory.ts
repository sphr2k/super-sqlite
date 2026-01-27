import { type, type Type } from 'arktype';
import superjson from 'superjson';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sql, eq, and } from 'drizzle-orm';
import { ulid } from 'ulid';

export function arktypeJsonTable<T extends Type<any>>(
    typeName: string,
    schema: T,
    tableName: string,
    db: BetterSQLite3Database,
    indexFields: string[] = []
) {
    type DataType = T['infer'];

    const rawTable = sqliteTable(tableName, {
        id: text('id').primaryKey(),
        data: text('data').notNull(),
    });

    const proxy: any = new Proxy({}, {
        get: (_, prop) => {
            if (prop === 'id') return rawTable.id;
            if (prop === '_raw') return rawTable.data;
            if (prop === '_rawTable') return rawTable;

            // Strictly block all non-string or internal keys
            if (typeof prop !== 'string' ||
                prop.startsWith('_') ||
                prop === 'then' ||
                prop === 'constructor' ||
                prop === 'toJSON' ||
                prop === 'toString' ||
                prop === 'decoder' ||
                prop === 'shouldInlineParams' ||
                prop === 'usedTables' ||
                prop === 'queryChunks'
            ) {
                return undefined;
            }
            return sql`json_extract(${rawTable.data}, ${sql.raw(`'$.json.${prop}'`)})`;
        }
    });

    const deserialize = (row: any): any => {
        if (!row) return null;
        // Handle JOINed results: { tableA: { id, data }, tableB: { id, data } }
        if (typeof row === 'object' && !row.data && row.constructor === Object) {
            const out: any = {};
            for (const [k, v] of Object.entries(row)) {
                if (v && typeof v === 'object' && (v as any).data) {
                    const base = superjson.parse<any>((v as any).data);
                    out[k] = { id: (v as any).id, ...base };
                } else {
                    out[k] = v;
                }
            }
            return out;
        }
        // Handle single table results: { id, data }
        if (row && typeof row === 'object' && row.data) {
            const base = superjson.parse<DataType>(row.data);
            return { id: row.id, ...base };
        }
        return row;
    };

    function isPlainObject(obj: any) {
        return obj && typeof obj === 'object' && obj.constructor === Object && !obj._isSql && !obj.params;
    }

    function wrapQuery(query: any) {
        const originalWhere = query.where.bind(query);
        const originalAll = query.all.bind(query);
        const originalGet = query.get.bind(query);

        query.where = (condition: any) => {
            if (isPlainObject(condition)) {
                const clauses = Object.entries(condition).map(([k, v]) => {
                    const column = proxy[k];
                    return eq(column, v);
                });
                const finalCondition = clauses.length > 1 ? and(...clauses) : clauses[0];
                return wrapQuery(originalWhere(finalCondition));
            }
            return wrapQuery(originalWhere(condition));
        };

        query.all = () => originalAll().map(deserialize);
        query.get = () => deserialize(originalGet());

        return query;
    }

    function createJoinBuilder(
        db: BetterSQLite3Database,
        baseTableName: string,
        baseProxy: any,
        baseTable: any
    ) {
        const joins: any[] = [];
        const involvedProxies: Record<string, any> = { [baseTableName]: baseProxy };

        const builder: any = {
            join(otherRepo: any, fieldMap: Record<string, string>, type: 'inner' | 'left' = 'inner') {
                joins.push({ otherRepo, fieldMap, type });
                involvedProxies[otherRepo.tableName] = otherRepo.proxy;
                return builder;
            },

            leftJoin(otherRepo: any, fieldMap: Record<string, string>) {
                return builder.join(otherRepo, fieldMap, 'left');
            },

            select(selection?: any) {
                let selectMap: any = selection;
                if (!selectMap) {
                    selectMap = {};
                    Object.entries(involvedProxies).forEach(([name, p]) => {
                        selectMap[name] = { id: p.id, data: p._raw };
                    });
                }

                let query = db.select(selectMap).from(baseTable);

                joins.forEach(j => {
                    const onClauses = Object.entries(j.fieldMap).map(([local, remote]) => {
                        return eq(baseProxy[local as any], j.otherRepo.proxy[remote as any]);
                    });
                    const joinFn = j.type === 'inner' ? query.innerJoin.bind(query) : query.leftJoin.bind(query);
                    (query as any) = joinFn(j.otherRepo.table, onClauses.length > 1 ? and(...onClauses) : onClauses[0]);
                });

                const wrapped = wrapQuery(query);

                const originalWhere = wrapped.where.bind(wrapped);
                wrapped.where = (condition: any) => {
                    if (isPlainObject(condition)) {
                        const clauses: any[] = [];

                        const buildClauses = (obj: any, currentProxy: any) => {
                            Object.entries(obj).forEach(([key, val]) => {
                                if (involvedProxies[key] && isPlainObject(val)) {
                                    buildClauses(val, involvedProxies[key]);
                                } else {
                                    const col = currentProxy[key];
                                    if (col && typeof col !== 'function' && !col.then) {
                                        clauses.push(eq(col, val));
                                    }
                                }
                            });
                        };

                        buildClauses(condition, baseProxy);

                        if (clauses.length === 0) return wrapped;
                        const finalCondition = clauses.length > 1 ? and(...clauses) : clauses[0];
                        return wrapQuery(originalWhere(finalCondition));
                    }
                    return wrapQuery(originalWhere(condition));
                };

                return wrapped;
            },

            where: (condition: any) => {
                return builder.select().where(condition);
            }
        };

        return builder;
    }

    return {
        table: rawTable,
        proxy,
        tableName,

        initialize: async () => {
            db.run(sql.raw(`
                CREATE TABLE IF NOT EXISTS ${tableName} (
                  id TEXT PRIMARY KEY,
                  data TEXT NOT NULL
                )
            `));

            for (const key of indexFields) {
                db.run(sql.raw(`
                    CREATE INDEX IF NOT EXISTS idx_${tableName}_${key} 
                    ON ${tableName}(json_extract(data, '$.json.${key}'))
                `));
            }
        },

        insert: (values: DataType | DataType[]): any => {
            const arr = Array.isArray(values) ? values : [values];
            const resultItems: any[] = [];
            const rows = arr.map(v => {
                const out = schema(v);
                if (out instanceof type.errors) throw new Error(`Validation Error: ${out.summary}`);
                const id = (v as any).id || ulid();
                resultItems.push({ id, ...v });
                return { id, data: superjson.stringify(v) };
            });
            if (rows.length === 0) return [];
            db.insert(rawTable).values(rows).run();
            return Array.isArray(values) ? resultItems : resultItems[0];
        },

        select: (selection?: Record<string, boolean>) => {
            let selectMap: any = { id: rawTable.id, data: rawTable.data };
            if (selection) {
                selectMap = { id: rawTable.id };
                Object.entries(selection).forEach(([k, v]) => {
                    if (v) selectMap[k] = proxy[k];
                });
            }
            return wrapQuery(db.select(selectMap).from(rawTable));
        },

        join(otherRepo: any, fieldMap: Record<string, string>) {
            return createJoinBuilder(db, tableName, proxy, rawTable).join(otherRepo, fieldMap, 'inner');
        },

        leftJoin(otherRepo: any, fieldMap: Record<string, string>) {
            return createJoinBuilder(db, tableName, proxy, rawTable).join(otherRepo, fieldMap, 'left');
        },

        findById: (id: string) => wrapQuery(db.select().from(rawTable)).where({ id }).get(),
        findByField: (field: string, value: any) => wrapQuery(db.select().from(rawTable)).where({ [field]: value }).all(),
        findDateRange: (field: string, options: { start?: Date; end?: Date }) => {
            const column = proxy[field];
            const conditions: any[] = [];
            if (options.start) conditions.push(sql`${column} >= ${options.start.toISOString()}`);
            if (options.end) conditions.push(sql`${column} <= ${options.end.toISOString()}`);
            return wrapQuery(db.select().from(rawTable).where(and(...conditions))).all();
        },
        getAll: () => wrapQuery(db.select().from(rawTable)).all()
    };
}
