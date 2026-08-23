import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error('Usage: node scripts/validate-state-roundtrip.mjs <backup.json>');
}

globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
  }
};
globalThis.dispatchEvent = () => true;

const storePath = path.resolve('assets/supabase-state-store.js');
await import(pathToFileURL(storePath));

const source = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
const state = source.state || source;
const ownerId = '00000000-0000-0000-0000-000000000001';
const parts = globalThis.SVStateStore.decomposeState(state, ownerId);
const restored = globalThis.SVStateStore.composeState(
  parts.workspace,
  parts.documents,
  parts.weeks,
  parts.tasks,
  parts.reservations,
  parts.attendanceRecords
);

assert.deepStrictEqual(restored, state);

console.log(JSON.stringify({
  ok: true,
  weeks: parts.weeks.length,
  tasks: parts.tasks.length,
  discountReservations: parts.reservations.length,
  attendanceRecords: parts.attendanceRecords.length,
  documents: parts.documents.length
}, null, 2));
