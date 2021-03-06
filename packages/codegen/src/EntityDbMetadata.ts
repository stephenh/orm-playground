import { Column, M2MRelation, M2ORelation, O2MRelation, Table } from "@homebound/pg-structure";
import { camelCase } from "change-case";
import { plural, singular } from "pluralize";
import { imp } from "ts-poet";
import { SymbolSpec } from "ts-poet/build/SymbolSpecs";
import {
  Config,
  isAsyncDerived,
  isDerived,
  isFieldIgnored,
  isProtected,
  ormMaintainedFields,
  relationName,
} from "./config";
import { ColumnMetaData } from "./generateEntityCodegenFile";
import { isEnumTable, isJoinTable, mapSimpleDbTypeToTypescriptType, tableToEntityName } from "./utils";

// TODO Populate from config
const columnCustomizations: Record<string, ColumnMetaData> = {};

/** Codegen-time metadata about a given domain entity. */
export type Entity = {
  name: string;
  /** The symbol pointing to the entity itself. */
  type: SymbolSpec;
  /** The name of the entity's runtime metadata const. */
  metaName: string;
  /** The symbol pointing to the entity's runtime metadata const. */
  metaType: SymbolSpec;
  /** The symbol pointing to the entity's EntityId type. */
  idType: SymbolSpec;
  /** The symbol pointing to the entity's Order type. */
  orderType: SymbolSpec;
  /** The symbol pointing to the entity's config const. */
  configConst: SymbolSpec;
  optsType: SymbolSpec;
};

export type DatabaseColumnType =
  | "boolean"
  | "int"
  | "numeric"
  | "text"
  | "citext"
  | "character varying"
  | "varchar"
  | "timestamp with time zone"
  | "date";

interface Field {
  fieldName: string;
  ignore?: boolean;
}
export type PrimitiveTypescriptType = "boolean" | "string" | "number" | "Date";

export type PrimitiveField = Field & {
  columnName: string;
  columnType: DatabaseColumnType;
  columnDefault: number | boolean | string | null;
  fieldType: PrimitiveTypescriptType;
  notNull: boolean;
  derived: "orm" | "sync" | "async" | false;
  protected: boolean;
};

export type EnumField = Field & {
  columnName: string;
  enumName: string;
  enumType: SymbolSpec;
  enumDetailType: SymbolSpec;
  notNull: boolean;
};

/** I.e. a `Book.author` reference pointing to an `Author`. */
export type ManyToOneField = Field & {
  columnName: string;
  otherFieldName: string;
  otherEntity: Entity;
  notNull: boolean;
};

/** I.e. a `Author.books` collection. */
export type OneToManyField = Field & {
  singularName: string;
  otherEntity: Entity;
  otherFieldName: string;
  otherColumnName: string;
  otherColumnNotNull: boolean;
};

/** I.e. a `Author.image` reference when `image.author_id` is unique. */
export type OneToOneField = Field & {
  otherEntity: Entity;
  otherFieldName: string;
  otherColumnName: string;
  otherColumnNotNull: boolean;
};

export type ManyToManyField = Field & {
  joinTableName: string;
  singularName: string;
  columnName: string;
  otherEntity: Entity;
  otherFieldName: string;
  otherColumnName: string;
};

/** Adapts the generally-great pg-structure metadata into our specific ORM types. */
export class EntityDbMetadata {
  entity: Entity;
  primitives: PrimitiveField[];
  enums: EnumField[];
  manyToOnes: ManyToOneField[];
  oneToManys: OneToManyField[];
  oneToOnes: OneToOneField[];
  manyToManys: ManyToManyField[];
  tableName: string;

  constructor(config: Config, table: Table) {
    this.entity = makeEntity(tableToEntityName(config, table));
    this.primitives = table.columns
      .filter((c) => !c.isPrimaryKey && !c.isForeignKey)
      .map((column) => newPrimitive(config, this.entity, column, table))
      .filter((f) => !f.ignore);
    this.enums = table.m2oRelations
      .filter((r) => isEnumTable(r.targetTable))
      .map((r) => newEnumField(config, this.entity, r))
      .filter((f) => !f.ignore);
    this.manyToOnes = table.m2oRelations
      .filter((r) => !isEnumTable(r.targetTable))
      .filter((r) => !isMultiColumnForeignKey(r))
      .map((r) => newManyToOneField(config, this.entity, r))
      .filter((f) => !f.ignore);
    this.oneToManys = table.o2mRelations
      // ManyToMany join tables also show up as OneToMany tables in pg-structure
      .filter((r) => !isJoinTable(r.targetTable))
      .filter((r) => !isMultiColumnForeignKey(r))
      .filter((r) => !isOneToOneRelation(r))
      .map((r) => newOneToMany(config, this.entity, r))
      .filter((f) => !f.ignore);
    this.oneToOnes = table.o2mRelations
      // ManyToMany join tables also show up as OneToMany tables in pg-structure
      .filter((r) => !isJoinTable(r.targetTable))
      .filter((r) => !isMultiColumnForeignKey(r))
      .filter((r) => isOneToOneRelation(r))
      .map((r) => newOneToOne(config, this.entity, r))
      .filter((f) => !f.ignore);
    this.manyToManys = table.m2mRelations
      // pg-structure is really loose on what it considers a m2m relationship, i.e. any entity
      // that has a foreign key to us, and a foreign key to something else, is automatically
      // considered as a join table/m2m between "us" and "something else". Filter these out
      // by looking for only true join tables, i.e. tables with only id, fk1, and fk2.
      .filter((r) => isJoinTable(r.joinTable))
      .filter((r) => !isMultiColumnForeignKey(r))
      .map((r) => newManyToManyField(config, this.entity, r))
      .filter((f) => !f.ignore);
    this.tableName = table.name;
  }

  get name(): string {
    return this.entity.name;
  }
}

function isMultiColumnForeignKey(r: M2ORelation) {
  return r.foreignKey.columns.length > 1;
}

function isOneToOneRelation(r: O2MRelation) {
  // otherColumn will be the images.book_id in the other table
  const otherColumn = r.foreignKey.columns[0];
  // r.foreignKey.index is the index on _us_ (i.e. our Book primary key), so look up indexes in the target table
  const indexes = r.targetTable.columns.find((c) => c.name == otherColumn.name)?.uniqueIndexes || [];
  // If the column is the only column in an unique index, it's a one-to-one
  return indexes.find((i) => i.columns.length === 1) !== undefined;
}

function newPrimitive(config: Config, entity: Entity, column: Column, table: Table): PrimitiveField {
  const fieldName = primitiveFieldName(column.name);
  const columnName = column.name;
  const columnType = (column.type.shortName || column.type.name) as DatabaseColumnType;
  return {
    fieldName,
    columnName,
    columnType,
    fieldType: mapType(table.name, columnName, columnType).fieldType,
    notNull: column.notNull,
    columnDefault: column.default,
    derived: fieldDerived(config, entity, fieldName),
    protected: isProtected(config, entity, fieldName),
    ignore: isFieldIgnored(config, entity, fieldName, column.notNull),
  };
}

function fieldDerived(config: Config, entity: Entity, fieldName: string): PrimitiveField["derived"] {
  if (ormMaintainedFields.includes(fieldName)) {
    return "orm";
  } else if (isDerived(config, entity, fieldName)) {
    return "sync";
  } else if (isAsyncDerived(config, entity, fieldName)) {
    return "async";
  } else {
    return false;
  }
}

function newEnumField(config: Config, entity: Entity, r: M2ORelation): EnumField {
  const column = r.foreignKey.columns[0];
  const columnName = column.name;
  const fieldName = enumFieldName(column.name);
  const enumName = tableToEntityName(config, r.targetTable);
  const enumType = imp(`${enumName}@./entities`);
  const enumDetailType = imp(`${plural(enumName)}@./entities`);
  const notNull = column.notNull;
  const ignore = isFieldIgnored(config, entity, fieldName, notNull);
  return { fieldName, columnName, enumName, enumType, enumDetailType, notNull, ignore };
}

function newManyToOneField(config: Config, entity: Entity, r: M2ORelation): ManyToOneField {
  const column = r.foreignKey.columns[0];
  const columnName = column.name;
  const fieldName = referenceName(config, entity, r);
  const otherEntity = makeEntity(tableToEntityName(config, r.targetTable));
  const isOneToOne = column.uniqueIndexes.find((i) => i.columns.length === 1) !== undefined;
  const otherFieldName = isOneToOne
    ? oneToOneName(config, otherEntity, entity)
    : collectionName(config, otherEntity, entity, r).fieldName;
  const notNull = column.notNull;
  const ignore = isFieldIgnored(config, entity, fieldName, notNull);
  return { fieldName, columnName, otherEntity, otherFieldName, notNull, ignore };
}

function newOneToMany(config: Config, entity: Entity, r: O2MRelation): OneToManyField {
  const column = r.foreignKey.columns[0];
  // source == parent i.e. the reference of the foreign key column
  // target == child i.e. the table with the foreign key column in it
  const otherEntity = makeEntity(tableToEntityName(config, r.targetTable));
  const { singularName, fieldName } = collectionName(config, entity, otherEntity, r);
  const otherFieldName = referenceName(config, otherEntity, r);
  const otherColumnName = column.name;
  const otherColumnNotNull = column.notNull;
  const ignore = isFieldIgnored(config, entity, fieldName) || isFieldIgnored(config, otherEntity, otherFieldName);
  return { fieldName, singularName, otherEntity, otherFieldName, otherColumnName, otherColumnNotNull, ignore };
}

function newOneToOne(config: Config, entity: Entity, r: O2MRelation): OneToOneField {
  const column = r.foreignKey.columns[0];
  // source == parent i.e. the reference of the foreign key column
  // target == child i.e. the table with the foreign key column in it
  const otherEntity = makeEntity(tableToEntityName(config, r.targetTable));
  const fieldName = oneToOneName(config, entity, otherEntity);
  const otherFieldName = referenceName(config, otherEntity, r);
  const otherColumnName = column.name;
  const otherColumnNotNull = column.notNull;
  const ignore = isFieldIgnored(config, entity, fieldName) || isFieldIgnored(config, otherEntity, otherFieldName);
  return { fieldName, otherEntity, otherFieldName, otherColumnName, otherColumnNotNull, ignore };
}

function newManyToManyField(config: Config, entity: Entity, r: M2MRelation): ManyToManyField {
  const { foreignKey, targetForeignKey, targetTable } = r;
  const joinTableName = r.joinTable.name;
  const otherEntity = makeEntity(tableToEntityName(config, targetTable));
  const fieldName = relationName(
    config,
    entity,
    camelCase(plural(targetForeignKey.columns[0].name.replace("_id", ""))),
  );
  const otherFieldName = relationName(
    config,
    otherEntity,
    camelCase(plural(foreignKey.columns[0].name.replace("_id", ""))),
  );
  const columnName = foreignKey.columns[0].name;
  const otherColumnName = targetForeignKey.columns[0].name;
  const singularName = singular(fieldName);
  const ignore = isFieldIgnored(config, entity, fieldName) || isFieldIgnored(config, otherEntity, otherFieldName);
  return { joinTableName, fieldName, singularName, columnName, otherEntity, otherFieldName, otherColumnName, ignore };
}

export function oneToOneName(config: Config, entity: Entity, otherEntity: Entity): string {
  return relationName(config, entity, camelCase(otherEntity.name));
}

export function referenceName(config: Config, entity: Entity, r: M2ORelation | O2MRelation): string {
  const column = r.foreignKey.columns[0];
  const fieldName = camelCase(column.name.replace("_id", ""));
  return relationName(config, entity, fieldName);
}

function enumFieldName(columnName: string) {
  return camelCase(columnName.replace("_id", ""));
}

function primitiveFieldName(columnName: string) {
  return camelCase(columnName);
}

/** Returns the collection name to use on `entity` when referring to `otherEntity`s. */
export function collectionName(
  config: Config,
  entity: Entity,
  otherEntity: Entity,
  r: M2ORelation | O2MRelation,
): { fieldName: string; singularName: string } {
  // TODO Handle conflicts in names
  // I.e. if the other side is `child.project_id`, use `children`.
  let fieldName = otherEntity.name;
  // check if we have multiple FKs from otherEntity --> entity and prefix with FK name if so
  const sourceTable = r instanceof M2ORelation ? r.sourceTable : r.targetTable;
  const targetTable = r instanceof M2ORelation ? r.targetTable : r.sourceTable;
  if (sourceTable.m2oRelations.filter((r) => r.targetTable === targetTable).length > 1) {
    fieldName = `${r.foreignKey.columns[0].name.replace("_id", "")}_${fieldName}`;
  }
  // If the other side is `book_reviews.book_id`, use `reviews`.
  if (fieldName.length > entity.name.length) {
    fieldName = fieldName.replace(entity.name, "");
  }

  // camelize the name
  let singularName = camelCase(fieldName);
  fieldName = camelCase(plural(fieldName));

  // If the name is overridden, use that, but also singularize it
  const maybeOverriddenName = relationName(config, entity, fieldName);
  if (maybeOverriddenName !== fieldName) {
    singularName = singular(maybeOverriddenName);
    fieldName = maybeOverriddenName;
  }

  return { singularName, fieldName };
}

export function makeEntity(entityName: string): Entity {
  return {
    name: entityName,
    type: entityType(entityName),
    metaName: metaName(entityName),
    metaType: metaType(entityName),
    idType: imp(`${entityName}Id@./entities`, { definedIn: `./${entityName}Codegen` }),
    orderType: imp(`${entityName}Order@./entities`, { definedIn: `./${entityName}Codegen` }),
    optsType: imp(`${entityName}Opts@./entities`, { definedIn: `./${entityName}Codegen` }),
    configConst: imp(`${camelCase(entityName)}Config@./entities`, { definedIn: `./${entityName}Codegen` }),
  };
}

function metaName(entityName: string): string {
  return `${camelCase(entityName)}Meta`;
}

function metaType(entityName: string): SymbolSpec {
  return imp(`${metaName(entityName)}@./entities`);
}

function entityType(entityName: string): SymbolSpec {
  return imp(`${entityName}@./entities`);
}

function mapType(tableName: string, columnName: string, dbColumnType: DatabaseColumnType): ColumnMetaData {
  return (
    columnCustomizations[`${tableName}.${columnName}`] || {
      fieldType: mapSimpleDbTypeToTypescriptType(dbColumnType),
    }
  );
}
