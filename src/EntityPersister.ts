import { Entity, EntityMetadata } from "./EntityManager";
import Knex from "knex";

interface Todo {
  metadata: EntityMetadata<any>;
  inserts: Entity[];
  updates: Entity[];
}

export async function flushEntities(knex: Knex, entities: Entity[]): Promise<void> {
  const todos = sortEntities(entities);
  for await (const todo of todos) {
    if (todo) {
      const meta = todo.metadata;
      if (todo.inserts.length > 0) {
        await batchInsert(knex, meta, todo.inserts);
      }
      if (todo.updates.length > 0) {
        await batchUpdate(knex, meta, todo.updates);
      }
    }
  }
}

async function batchInsert(knex: Knex, meta: EntityMetadata<any>, entities: Entity[]): Promise<void> {
  const rows = entities.map(entity => {
    const row = {};
    meta.columns.forEach(c => c.serde.setOnRow(entity.__orm.data, row));
    return row;
  });
  const ids = await knex.batchInsert(meta.tableName, rows).returning("id");
  for (let i = 0; i < entities.length; i++) {
    entities[i].__orm.data["id"] = ids[i];
    entities[i].__orm.dirty = false;
  }
  console.log("Inserted", ids);
}

// Uses a pg-specific syntax to issue a bulk update
async function batchUpdate(knex: Knex, meta: EntityMetadata<any>, entities: Entity[]): Promise<void> {
  const bindings: any[][] = meta.columns.map(() => []);
  for (const entity of entities) {
    meta.columns.forEach((c, i) => bindings[i].push(c.serde.getFromEntity(entity)));
  }
  await knex.raw(
    cleanSql(`
      UPDATE ${meta.tableName}
      SET ${meta.columns.map(c => `${c.columnName} = data.${c.columnName}`).join(", ")}
      FROM (select ${meta.columns.map(c => `unnest(?::${c.dbType}[]) as ${c.columnName}`).join(", ")}) as data
      WHERE ${meta.tableName}.id = data.id
   `),
    bindings,
  );
  entities.forEach(entity => entity.__orm.dirty = false);
}

function cleanSql(sql: string): string {
  return sql
    .trim()
    .replace("\n", "")
    .replace(/  +/, " ");
}

/** Scans `entities` for new/updated entities and arranges them per-entity in entity order. */
function sortEntities(entities: Entity[]): Todo[] {
  const todos: Todo[] = [];
  for (const entity of entities) {
    const order = entity.__orm.metadata.order;
    const isNew = entity.id === undefined;
    const isDirty = !isNew && entity.__orm.dirty;
    if (isNew || isDirty) {
      let todo = todos[order];
      if (!todo) {
        todo = { metadata: entity.__orm.metadata, inserts: [], updates: [] };
        todos[order] = todo;
      }
      if (isNew) {
        todo.inserts.push(entity);
      } else {
        todo.updates.push(entity);
      }
    }
  }
  return todos;
}
