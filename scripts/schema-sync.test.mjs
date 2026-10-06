// This planner decides what SQL to run against the only copy of somebody's inventory.
// The tests that matter are the ones proving what it REFUSES to do.
import test from "node:test";
import assert from "node:assert/strict";
import { planSchemaSync, addColumnSql, q, indexTable } from "./schema-sync.mjs";

const col = (name, over = {}) => ({ name, type: "TEXT", notnull: false, dflt: null, pk: false, ...over });

const expected = {
  tables: {
    Item: {
      sql: 'CREATE TABLE "Item" ("id" INTEGER PRIMARY KEY, "sku" TEXT NOT NULL)',
      columns: [
        col("id", { type: "INTEGER", pk: true, notnull: true }),
        col("sku", { notnull: true }),
        col("niftyDescription"),
        col("editCount", { type: "INTEGER", notnull: true, dflt: "0" }),
      ],
    },
    ItemValuation: {
      sql: 'CREATE TABLE "ItemValuation" ("id" INTEGER PRIMARY KEY, "itemId" INTEGER NOT NULL)',
      columns: [col("id", { type: "INTEGER", pk: true, notnull: true }), col("itemId", { type: "INTEGER", notnull: true })],
    },
  },
  indexes: [
    { name: "ItemValuation_itemId_key", sql: 'CREATE UNIQUE INDEX "ItemValuation_itemId_key" ON "ItemValuation"("itemId")' },
    { name: "Item_status_idx", sql: 'CREATE INDEX "Item_status_idx" ON "Item"("status")' },
  ],
};

test("a database that already matches produces no work", () => {
  const live = {
    tables: {
      Item: { columns: expected.tables.Item.columns },
      ItemValuation: { columns: expected.tables.ItemValuation.columns },
    },
  };
  const plan = planSchemaSync(expected, live);
  assert.deepEqual(plan.statements, []);
  assert.deepEqual(plan.refusals, []);
});

test("the real case: columns added since the user's build are ALTERed in", () => {
  // Exactly what a tester on v1.2 hits after the Listings work added four columns.
  const live = { tables: { Item: { columns: [col("id", { pk: true }), col("sku")] }, ItemValuation: { columns: expected.tables.ItemValuation.columns } } };
  const plan = planSchemaSync(expected, live);
  assert.equal(plan.refusals.length, 0);
  assert.deepEqual(plan.statements.map((s) => s.column), ["niftyDescription", "editCount"]);
  assert.equal(plan.statements[0].sql, 'ALTER TABLE "Item" ADD COLUMN "niftyDescription" TEXT');
  assert.equal(plan.statements[1].sql, 'ALTER TABLE "Item" ADD COLUMN "editCount" INTEGER NOT NULL DEFAULT 0');
});

test("a whole new table is created from the template's own DDL, with its indexes", () => {
  const live = { tables: { Item: { columns: expected.tables.Item.columns } } };
  const plan = planSchemaSync(expected, live);
  const kinds = plan.statements.map((s) => s.kind);
  assert.deepEqual(kinds, ["create-table", "create-index"]);
  assert.equal(plan.statements[0].sql, expected.tables.ItemValuation.sql);
  // Only the index that belongs to the new table — Item's index is not re-created.
  assert.match(plan.statements[1].sql, /ItemValuation_itemId_key/);
});

test("a NOT NULL column with no default is REFUSED, not guessed at", () => {
  // There is no value to put in the existing rows. Inventing one is how a beta
  // quietly corrupts a year of records.
  const strict = {
    tables: { Item: { sql: expected.tables.Item.sql, columns: [col("id", { pk: true }), col("sku"), col("mustHave", { notnull: true })] } },
    indexes: [],
  };
  const live = { tables: { Item: { columns: [col("id", { pk: true }), col("sku")] } } };
  const plan = planSchemaSync(strict, live);
  assert.deepEqual(plan.statements, []);
  assert.equal(plan.refusals.length, 1);
  assert.match(plan.refusals[0].reason, /NOT NULL with no default/);
});

test("a column the user has and the shipped schema does not is LEFT ALONE", () => {
  // Dropping it would destroy data, and SQLite would have to rebuild the table to
  // do it. Downgrading a build must never be destructive.
  const live = {
    tables: {
      Item: { columns: [...expected.tables.Item.columns, col("someOldField")] },
      ItemValuation: { columns: expected.tables.ItemValuation.columns },
    },
  };
  const plan = planSchemaSync(expected, live);
  assert.deepEqual(plan.statements, []);
  assert.deepEqual(plan.refusals, []);
  assert.ok(plan.notes.some((n) => /someOldField/.test(n)), plan.notes.join("; "));
});

test("an existing column is never re-added or retyped", () => {
  // The live column disagrees on type. Rewriting it would mean rebuilding the table.
  const live = {
    tables: {
      Item: { columns: [col("id", { pk: true }), col("sku"), col("niftyDescription", { type: "BLOB" }), col("editCount", { type: "INTEGER", notnull: true, dflt: "0" })] },
      ItemValuation: { columns: expected.tables.ItemValuation.columns },
    },
  };
  assert.deepEqual(planSchemaSync(expected, live).statements, []);
});

test("a missing manifest entry for a table's DDL is refused, not improvised", () => {
  const broken = { tables: { Newish: { sql: "", columns: [col("id")] } }, indexes: [] };
  const plan = planSchemaSync(broken, { tables: {} });
  assert.deepEqual(plan.statements, []);
  assert.match(plan.refusals[0].reason, /no CREATE statement/);
});

test("identifiers are quoted so a column named after a keyword still works", () => {
  assert.equal(q("order"), '"order"');
  assert.equal(q('we"ird'), '"we""ird"');
  assert.equal(addColumnSql("Item", col("group")), 'ALTER TABLE "Item" ADD COLUMN "group" TEXT');
});

test("a default is pasted through verbatim, including strings and functions", () => {
  assert.equal(addColumnSql("Item", col("brand", { notnull: true, dflt: "'Unknown'" })),
    `ALTER TABLE "Item" ADD COLUMN "brand" TEXT NOT NULL DEFAULT 'Unknown'`);
  assert.equal(addColumnSql("Item", col("createdAt", { type: "DATETIME", notnull: true, dflt: "CURRENT_TIMESTAMP" })),
    'ALTER TABLE "Item" ADD COLUMN "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
});

test("index-to-table matching handles every quoting style SQLite emits", () => {
  assert.equal(indexTable('CREATE INDEX "x" ON "Item"("status")'), "Item");
  assert.equal(indexTable("CREATE INDEX x ON Item(status)"), "Item");
  assert.equal(indexTable("CREATE INDEX x ON `Item`(status)"), "Item");
  assert.equal(indexTable(""), null);
});

test("an empty expected schema asks for nothing", () => {
  assert.deepEqual(planSchemaSync({}, { tables: { Item: { columns: [col("id")] } } }).statements, []);
});
