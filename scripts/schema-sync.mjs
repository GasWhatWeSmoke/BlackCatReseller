// Bring an EXISTING user database up to the shipped schema, additively.
//
// THE PROBLEM THIS SOLVES. A packaged install copies config/template.db on first run
// and then never touches the schema again — there is no Prisma CLI in the package, so
// no `prisma db push`. A tester who installs v1.2, uses it for a week, and updates to
// v1.3 keeps their v1.2 database, and every query touching a new column dies with
// "no such column". The app looks catastrophically broken and their data looks lost,
// when in fact nothing is wrong but four missing nullable columns.
//
// WHY ADDITIVE-ONLY IS SAFE HERE. This schema has always evolved by adding nullable
// columns and new tables — that is the documented rule, and `prisma db push` is what
// enforced it on the developer's machine. So the migration a tester needs is never
// "rewrite this table", it is "add the columns and tables that appeared since".
// Anything that would DROP or RETYPE is refused and reported, never guessed at:
// silently rebuilding a table is how a beta eats somebody's inventory.
//
// Usage: node scripts/schema-sync.mjs           (uses DATABASE_URL)
//        node scripts/schema-sync.mjs --dry-run
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A column definition, as `PRAGMA table_info` reports it. */
/** @typedef {{name: string, type: string, notnull: boolean, dflt: string|null, pk: boolean}} Col */

/**
 * Work out what to run to bring `live` up to `expected`.
 *
 * Pure: returns additive statements, refusals and observed definition drift. Callers
 * must not apply the plan when refusals or drift are present. Every decision this
 * makes is testable without a database, which matters because the thing it operates on
 * is the only copy of somebody's inventory.
 */
export function planSchemaSync(expected, live) {
  const statements = [];
  const refusals = [];
  const notes = [];
  const drift = [];

  for (const [table, spec] of Object.entries(expected.tables ?? {})) {
    const liveTable = live.tables?.[table];
    if (!liveTable) {
      // A table that did not exist is created from the template's own DDL, verbatim.
      if (spec.sql) {
        statements.push({ kind: "create-table", table, sql: spec.sql });
        for (const idx of (expected.indexes ?? []).filter((i) => indexTable(i.sql) === table)) {
          statements.push({ kind: "create-index", table, sql: idx.sql });
        }
      } else {
        refusals.push({ table, reason: "the manifest has no CREATE statement for this table" });
      }
      continue;
    }
    const have = new Map(liveTable.columns.map((c) => [c.name,c]));
    for (const col of spec.columns) {
      const previous=have.get(col.name);
      if (previous) {
        const changed=[];
        if(String(previous.type).trim().replace(/\s+/g,' ').toUpperCase()!==String(col.type).trim().replace(/\s+/g,' ').toUpperCase())changed.push('declared type');
        if(previous.notnull!==col.notnull)changed.push('NOT NULL constraint');
        if(previous.pk!==col.pk)changed.push('primary-key flag');
        if(sqlKey(previous.dflt)!==sqlKey(col.dflt))changed.push('default');
        if(changed.length)drift.push({table,column:col.name,reason:`${changed.join(', ')} differs; requires reviewed migration`});
        continue;
      }
      if(col.pk){refusals.push({table,column:col.name,reason:'PRIMARY KEY cannot be added with ADD COLUMN'});continue;}
      if(col.dflt!=null && (/^CURRENT_(?:TIME|DATE|TIMESTAMP)$/i.test(col.dflt.trim())||col.dflt.trim().startsWith('('))){
        refusals.push({table,column:col.name,reason:'non-constant default cannot be added with ADD COLUMN'});continue;
      }
      // SQLite cannot add a NOT NULL column without a default — there is no value to
      // put in the existing rows. That can only happen if the schema stopped being
      // additive, so say so loudly instead of inventing a value.
      if (col.notnull && (col.dflt == null || /^NULL$/i.test(col.dflt.trim()))) {
        refusals.push({
          table, column: col.name,
          reason: "NOT NULL with no default — cannot be added to a table that already has rows",
        });
        continue;
      }
      if(columnHasOtherConstraints(spec.sql,col.name)){
        refusals.push({table,column:col.name,reason:'column participates in a constraint that this additive updater cannot preserve; requires reviewed migration'});continue;
      }
      statements.push({ kind: "add-column", table, column: col.name, sql: addColumnSql(table, col) });
    }
    // Columns the user's database has and the shipped schema does not. Harmless to
    // leave (SQLite ignores them), and dropping one would destroy data.
    const want = new Set(spec.columns.map((c) => c.name));
    for (const col of liveTable.columns) {
      if (!want.has(col.name)) notes.push(`${table}.${col.name} exists here but not in the shipped schema — left alone`);
    }
  }
  for(const index of expected.indexes??[]){
    const table=indexTable(index.sql);if(!live.tables?.[table])continue;
    if(!Array.isArray(live.indexes)){drift.push({table,index:index.name,reason:'existing index definitions are unavailable'});continue;}
    const previous=live.indexes.find(row=>row.name===index.name);
    if(!previous)drift.push({table,index:index.name,reason:'required index is missing; requires reviewed migration'});
    else if(sqlKey(previous.sql)!==sqlKey(index.sql))drift.push({table,index:index.name,reason:'index definition differs; requires reviewed migration'});
  }
  return { statements, refusals, notes, drift };
}

// Normalize formatting/keywords, but preserve quoted identifiers and string values.
function sqlTokens(value){
  return (String(value??'').trim().replace(/;+\s*$/,'').match(/"(?:[^\"]|"")*"|'(?:[^']|'')*'|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z_0-9$]*|[^\s]/g)??[])
    .filter(token=>!token.startsWith('--')&&!token.startsWith('/*'));
}
function sqlKey(value){
  return value==null?null:JSON.stringify(sqlTokens(value).map(token=>/^[A-Za-z_]/.test(token)?token.toUpperCase():token));
}
function columnHasOtherConstraints(sql,name){
  const identifier=token=>token==null?null:token.startsWith('"')?token.slice(1,-1).replaceAll('""','"').toLowerCase()
    :token.startsWith('`')?token.slice(1,-1).replaceAll('``','`').toLowerCase():token.startsWith('[')?token.slice(1,-1).toLowerCase():/^[A-Za-z_][A-Za-z_0-9$]*$/.test(token)?token.toLowerCase():null;
  const tokens=sqlTokens(sql),parts=[];let depth=0,part=[];
  for(const token of tokens.slice(tokens.indexOf('('))){
    if(token==='('){depth++;if(depth===1)continue;}
    if(token===')'){depth--;if(depth===0){parts.push(part);break;}}
    if(token===','&&depth===1){parts.push(part);part=[];}else part.push(token);
  }
  const column=name.toLowerCase(),declaration=parts.find(tokens=>identifier(tokens[0])===column);
  if(declaration?.slice(1).some(token=>['REFERENCES','UNIQUE','CHECK','COLLATE','GENERATED'].includes(token.toUpperCase())))return true;
  for(const tokens of parts){
    if(!['CONSTRAINT','FOREIGN','PRIMARY','UNIQUE','CHECK'].includes(tokens[0]?.toUpperCase()))continue;
    const start=tokens.indexOf('(');if(start<0)continue;
    const checked=tokens.some(token=>token.toUpperCase()==='CHECK')?tokens.slice(start+1):tokens.slice(start+1,tokens.indexOf(')',start));
    if(checked.some(token=>identifier(token)===column))return true;
  }
  return false;
}

export function validateSchemaManifest(expected){
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
  if(!object(expected)||!object(expected.tables)||!Object.keys(expected.tables).length||!Array.isArray(expected.indexes))throw Error('Schema manifest is incomplete; no changes applied.');
  if(expected.tableCount!==undefined&&expected.tableCount!==Object.keys(expected.tables).length)throw Error('Schema manifest table count is inconsistent; no changes applied.');
  for(const [name,table] of Object.entries(expected.tables)){
    if(!name||!object(table)||typeof table.sql!=='string'||!/^CREATE\s+TABLE\b/i.test(table.sql.trim())||!Array.isArray(table.columns)||!table.columns.length
      ||table.columns.some(col=>!object(col)||typeof col.name!=='string'||!col.name||typeof col.type!=='string'||typeof col.notnull!=='boolean'||typeof col.pk!=='boolean'||!(col.dflt===null||typeof col.dflt==='string'))
      ||new Set(table.columns.map(col=>col.name.toLowerCase())).size!==table.columns.length)throw Error(`Schema manifest table ${name} is incomplete; no changes applied.`);
  }
  if(expected.indexes.some(index=>!object(index)||typeof index.name!=='string'||!index.name||typeof index.sql!=='string'||!/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(index.sql.trim())||!expected.tables[indexTable(index.sql)])
    ||new Set(expected.indexes.map(index=>index.name.toLowerCase())).size!==expected.indexes.length)throw Error('Schema manifest indexes are incomplete; no changes applied.');
}

/** `ALTER TABLE "Item" ADD COLUMN "editCount" INTEGER NOT NULL DEFAULT 0` */
export function addColumnSql(table, col) {
  const parts = [`ALTER TABLE ${q(table)} ADD COLUMN ${q(col.name)}`];
  if (col.type) parts.push(col.type);
  if (col.notnull) parts.push("NOT NULL");
  if (col.dflt != null) parts.push(`DEFAULT ${col.dflt}`);
  return parts.join(" ");
}

/** Double-quoted SQLite identifier; an embedded quote is doubled. */
export function q(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** The table an index belongs to, read out of its CREATE INDEX statement. */
export function indexTable(sql) {
  const m = /\bON\s+(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\w+))/i.exec(String(sql || ""));
  return m ? (m[1] ?? m[2] ?? m[3] ?? m[4]) : null;
}

// ---------------------------------------------------------------------------
// Runtime half — reads the live database through Prisma, because the packaged app
// has @prisma/client but no sqlite CLI and Electron's Node predates node:sqlite.
// ---------------------------------------------------------------------------

async function readLiveSchema(prisma) {
  const tableRows = await prisma.$queryRawUnsafe(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  );
  const tables = {};
  for (const { name } of tableRows) {
    const info = await prisma.$queryRawUnsafe(`PRAGMA table_info(${q(name)})`);
    tables[name] = {
      columns: info.map((c) => ({
        name: c.name, type: c.type, notnull: Number(c.notnull) === 1,
        dflt: c.dflt_value == null ? null : String(c.dflt_value), pk: Number(c.pk) > 0,
      })),
    };
  }
  const indexes=await prisma.$queryRawUnsafe("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name");
  return { tables,indexes };
}

export async function reconcileSchema(prisma,expected,{dryRun=false,logger=console}={}){
  validateSchemaManifest(expected);
  // BEGIN/COMMIT can initialize a zero-byte SQLite file even without DDL.
  // Reject incomplete setup through a read before opening the write transaction.
  const tables=await prisma.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1");
  if(!tables.length){logger.error('schema-sync: database is empty; initial setup is incomplete. No schema changes applied.');return 2;}
  const result=await prisma.$transaction(async tx=>{
    const live=await readLiveSchema(tx);
    if(Object.keys(live.tables).length===0){logger.error('schema-sync: database is empty; initial setup is incomplete. No schema changes applied.');return {code:2,applied:[]};}
    const {statements,refusals,notes,drift}=planSchemaSync(expected,live);
    for(const note of notes)logger.log(`schema-sync: note — ${note}`);
    for(const issue of [...refusals,...drift])logger.error(`schema-sync: REVIEW ${issue.table}${issue.column?'.'+issue.column:issue.index?' index '+issue.index:''} — ${issue.reason}`);
    if(refusals.length||drift.length){logger.error('schema-sync: review required; no schema changes applied');return {code:2,applied:[]};}
    if(!statements.length){logger.log('schema-sync: required column and explicit index definitions match; no additive work');return {code:0,applied:[]};}
    if(dryRun){for(const statement of statements)logger.log(`schema-sync: WOULD RUN ${statement.sql}`);return {code:0,applied:[]};}
    for(const statement of statements)await tx.$executeRawUnsafe(statement.sql);
    return {code:0,applied:statements};
  });
  // Only report applied work after the transaction committed successfully.
  for(const statement of result.applied)logger.log(`schema-sync: applied ${statement.kind} ${statement.table}${statement.column?'.'+statement.column:''}`);
  return result.code;
}

export async function main(argv = process.argv.slice(2)) {
  if(argv.length>1||argv.some(arg=>arg!=='--dry-run')){console.error('Usage: node scripts/schema-sync.mjs [--dry-run]. No changes applied.');return 2;}
  const dryRun = argv.includes("--dry-run");
  const manifestPath = path.join(root, "config", "schema-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error("schema-sync: required config/schema-manifest.json is missing; no changes applied");
    return 2;
  }
  const expected = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  validateSchemaManifest(expected);

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    return await reconcileSchema(prisma,expected,{dryRun});
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (process.argv[1]?.endsWith("schema-sync.mjs")) {
  main().then((code) => {process.exitCode=code;}).catch((e) => {
    console.error(`schema-sync: ${e instanceof Error ? e.stack : e}`);
    // Electron decides whether startup can continue; this command must report failure.
    process.exitCode=2;
  });
}
