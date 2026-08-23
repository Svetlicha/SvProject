import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [inputPath, ownerId, outputDirectory = 'migration_output'] = process.argv.slice(2);
if (!inputPath || !ownerId) {
  throw new Error('Usage: node scripts/build-supabase-import.mjs <backup.json> <owner-uuid> [output-dir]');
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerId)) {
  throw new Error('The owner ID is not a valid UUID.');
}

globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
  }
};
globalThis.dispatchEvent = () => true;

await import(pathToFileURL(path.resolve('assets/supabase-state-store.js')));

const source = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
const state = source.state || source;
const parts = globalThis.SVStateStore.decomposeState(state, ownerId);
const output = path.resolve(outputDirectory);
fs.mkdirSync(output, { recursive: true });
for (const fileName of fs.readdirSync(output)) {
  if (fileName.endsWith('.sql') || fileName === 'manifest.json') {
    fs.unlinkSync(path.join(output, fileName));
  }
}

function textLiteral(value) {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function jsonLiteral(value) {
  return `${textLiteral(JSON.stringify(value))}::jsonb`;
}

function splitText(value, maximumLength = 180000) {
  const chunks = [];
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + maximumLength, value.length);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end -= 1;
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function writeChunk(index, name, statements) {
  const sql = [
    'begin;',
    "set local statement_timeout = '120s';",
    ...statements,
    'commit;',
    ''
  ].join('\n');
  const fileName = `${String(index).padStart(2, '0')}_${name}.sql`;
  const filePath = path.join(output, fileName);
  fs.writeFileSync(filePath, sql, 'utf8');
  return {
    file: fileName,
    bytes: Buffer.byteLength(sql),
    sha256: crypto.createHash('sha256').update(sql).digest('hex')
  };
}

function upsertStatement(table, columns, conflictColumns, rows) {
  const values = rows.map(row => `(${columns.map(column => {
    const value = row[column];
    if (column === 'payload' || column === 'extra_root') return jsonLiteral(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return String(value);
    return textLiteral(value);
  }).join(',')})`).join(',\n');
  const updates = columns
    .filter(column => !conflictColumns.includes(column))
    .map(column => `${column}=excluded.${column}`)
    .join(',');
  return `insert into public.${table} (${columns.join(',')}) values\n${values}\non conflict (${conflictColumns.join(',')}) do update set ${updates};`;
}

const files = [];
let index = 1;

files.push(writeChunk(index++, 'documents', [
  upsertStatement(
    'app_documents',
    ['owner_id', 'document_key', 'payload'],
    ['owner_id', 'document_key'],
    parts.documents
  )
]));

files.push(writeChunk(index++, 'import_buffer', [
  'create schema if not exists private;',
  `create table if not exists private.sv_import_buffer (
    owner_id uuid not null,
    record_key text not null,
    part_no integer not null,
    payload_fragment text not null,
    primary key (owner_id, record_key, part_no)
  );`
]));

for (let offset = 0; offset < parts.weeks.length; offset += 1) {
  const row = parts.weeks[offset];
  const fragments = splitText(JSON.stringify(row.payload));
  for (let partNo = 0; partNo < fragments.length; partNo += 1) {
    files.push(writeChunk(index++, `week_${offset + 1}_part_${partNo + 1}`, [
      `insert into private.sv_import_buffer (owner_id,record_key,part_no,payload_fragment)
values (${textLiteral(row.owner_id)},${textLiteral(row.week_id)},${partNo},${textLiteral(fragments[partNo])})
on conflict (owner_id,record_key,part_no) do update set payload_fragment=excluded.payload_fragment;`
    ]));
  }
  files.push(writeChunk(index++, `week_${offset + 1}_finalize`, [
    `insert into public.app_weeks (owner_id,week_id,position,start_date,end_date,payload)
select ${textLiteral(row.owner_id)},${textLiteral(row.week_id)},${row.position},${textLiteral(row.start_date)},${textLiteral(row.end_date)},
  string_agg(payload_fragment,'' order by part_no)::jsonb
from private.sv_import_buffer
where owner_id=${textLiteral(row.owner_id)} and record_key=${textLiteral(row.week_id)}
on conflict (owner_id,week_id) do update set position=excluded.position,start_date=excluded.start_date,end_date=excluded.end_date,payload=excluded.payload;`,
    `delete from private.sv_import_buffer where owner_id=${textLiteral(row.owner_id)} and record_key=${textLiteral(row.week_id)};`
  ]));
}

files.push(writeChunk(index++, 'tasks', [
  upsertStatement(
    'app_tasks',
    ['owner_id', 'task_key', 'task_date', 'position', 'payload'],
    ['owner_id', 'task_key'],
    parts.tasks
  )
]));

files.push(writeChunk(index++, 'reservations', [
  upsertStatement(
    'app_discount_reservations',
    ['owner_id', 'reservation_id', 'position', 'payload'],
    ['owner_id', 'reservation_id'],
    parts.reservations
  )
]));

files.push(writeChunk(index++, 'attendance', [
  upsertStatement(
    'app_attendance_records',
    ['owner_id', 'record_key', 'payload'],
    ['owner_id', 'record_key'],
    parts.attendanceRecords
  )
]));

files.push(writeChunk(index++, 'workspace', [
  upsertStatement(
    'app_workspaces',
    ['owner_id', 'schema_version', 'revision', 'active_week_id', 'to_mappings_locked', 'extra_root'],
    ['owner_id'],
    [{ ...parts.workspace, revision: 1 }]
  )
]));

const manifest = {
  generatedAt: new Date().toISOString(),
  sourceUpdatedAt: source.updatedAt || null,
  counts: {
    weeks: parts.weeks.length,
    tasks: parts.tasks.length,
    discountReservations: parts.reservations.length,
    attendanceRecords: parts.attendanceRecords.length,
    documents: parts.documents.length
  },
  files
};
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify(manifest, null, 2));
