import type { Type } from 'arktype';
import type { SQL, SQLWrapper } from 'drizzle-orm';
import type { QueryBuilder, FieldNames, FilterFields, QueryableKeys, Projected, DateFields } from './query.js';
import type { IndexApplyOptions, IndexOperation } from './indexes.js';
import type { RawTable } from './table.js';

type EntityOf<T> = T extends { _entityType?: infer E } ? NonNullable<E> : never;
export type Entity<T extends Type<any>> = T['infer'] & { id: string };
export type JoinFields<Source, Target> = Partial<Record<FieldNames<Source>, FieldNames<Target>>>;
export type JoinedFilters<J> = { [K in keyof J]?: FilterFields<NonNullable<J[K]>> };
export type JoinedCondition<J, Base> = FilterFields<Base> | JoinedFilters<J>;

export interface JoinTarget {
  tableName: string;
  table: SQLWrapper & { id: SQLWrapper; data: SQLWrapper };
  proxy: Record<string, SQL>;
  _decodeStored(raw: string, id?: string): Record<string, unknown>;
  readonly _entityType?: Record<string, unknown>;
}

export interface JoinBuilder<J extends Record<string, unknown>, Base extends Record<string, unknown>> {
  join<O extends JoinTarget>(other: O, fields: JoinFields<Base, EntityOf<O>>): JoinBuilder<J & Record<O['tableName'], EntityOf<O>>, Base>;
  leftJoin<O extends JoinTarget>(other: O, fields: JoinFields<Base, EntityOf<O>>): JoinBuilder<J & Record<O['tableName'], EntityOf<O> | null>, Base>;
  select(): QueryBuilder<J, JoinedCondition<J, Base>>;
  select(selection: Record<string, SQL | SQLWrapper>): QueryBuilder<Record<string, unknown>, JoinedCondition<J, Base>>;
  where(condition: JoinedCondition<J, Base> | SQL): QueryBuilder<J, JoinedCondition<J, Base>>;
}

export interface Repository<T extends Type<any>, Name extends string> extends JoinTarget {
  readonly table: RawTable<Name>;
  readonly tableName: Name;
  readonly typeName: string;
  readonly _entityType?: Entity<T>;
  initialize(): Promise<void>;
  planIndexes(): Promise<IndexOperation[]>;
  applyIndexes(options?: IndexApplyOptions): Promise<IndexOperation[]>;
  insert: {
    (input: T['inferIn']): Promise<Entity<T>>;
    (inputs: T['inferIn'][]): Promise<Entity<T>[]>;
  };
  upgradeDocuments(options?: { batchSize?: number; dryRun?: boolean }): Promise<{ scanned: number; upgraded: number }>;
  findByIdWithRevision(id: string): Promise<{ value: Entity<T>; revision: number; version: number } | undefined>;
  update(id: string, patch: Partial<Omit<T['inferIn'], 'id'>>, options?: { expectedRevision?: number }): Promise<{ value: Entity<T>; revision: number }>;
  select: {
    (): QueryBuilder<Entity<T>, FilterFields<Entity<T>>>;
    <const S extends Partial<Record<FieldNames<Entity<T>>, boolean>>>(selection: S): QueryBuilder<Projected<Entity<T>, S>, FilterFields<Entity<T>>>;
  };
  selectScalar<const S extends Partial<Record<QueryableKeys<Entity<T>>, boolean>>>(selection: S): QueryBuilder<Projected<Entity<T>, S>, FilterFields<Entity<T>>>;
  join<O extends JoinTarget>(other: O, fields: JoinFields<Entity<T>, EntityOf<O>>): JoinBuilder<Record<Name, Entity<T>> & Record<O['tableName'], EntityOf<O>>, Entity<T>>;
  leftJoin<O extends JoinTarget>(other: O, fields: JoinFields<Entity<T>, EntityOf<O>>): JoinBuilder<Record<Name, Entity<T>> & Record<O['tableName'], EntityOf<O> | null>, Entity<T>>;
  findById(id: string): Promise<Entity<T> | undefined>;
  findByField<K extends QueryableKeys<Entity<T>>>(field: K, value: Entity<T>[K]): Promise<Entity<T>[]>;
  findDateRange<K extends DateFields<Entity<T>>>(field: K, options: { start?: Date; end?: Date }): Promise<Entity<T>[]>;
  getAll(): Promise<Entity<T>[]>;
}
