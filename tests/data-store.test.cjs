const test = require('node:test');
const assert = require('node:assert/strict');
const data = require('../data-store.js');
const KEY = 'podhod-gym-log-v1';

function state() {
  return {
    exercises: [{ id: 'my-exercise-7', name: 'Жим' }],
    sessions: { '2026-09-30': { 'my-exercise-7': [{ weight: 57.5, reps: 10 }, { weight: 57.5, reps: 10 }] } },
    workoutPlans: { '2026-09-30': ['my-exercise-7'] },
    templates: [{ id: 'my-template-9', name: 'Основная', exerciseIds: ['my-exercise-7'] }],
    completedExercises: { '2026-09-30': [] },
    finishedWorkouts: { '2026-09-30': true },
    exerciseNotes: { 'my-exercise-7': 'Положение сиденья 4' },
    membership: { name: 'Годовой', purchasedAt: '2026-09-01', validUntil: '2027-09-01', gyms: ['Минск'], note: 'Бассейн включён', userId: 'membership-user-123' },
    settings: { restSeconds: 90 }, restTimer: { endAt: 1790000000000 }, input: { weight: 57.5, reps: 10 }, currentExercise: 0,
    userId: 'local-user-42'
  };
}

function storage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  const writes = [];
  return { entries, writes, getItem: key => entries.get(key) ?? null, setItem(key, value) { writes.push(key); entries.set(key, value); } };
}

test('raw legacy state round trips without changing IDs or history', () => {
  const original = state();
  const raw = JSON.stringify(original);
  assert.deepEqual(data.parseBackup(raw), original);
  assert.deepEqual(data.read(storage({ [KEY]: raw }), KEY), { state: original, status: 'saved', message: '' });
  const store = storage();
  assert.equal(data.write(store, KEY, original).ok, true);
  assert.deepEqual(JSON.parse(store.getItem(KEY)), original);
});

test('reading existing good data has no writes and writing unchanged data is a no-op', () => {
  const raw = JSON.stringify(state());
  const store = storage({ [KEY]: raw, [`${KEY}-recovery`]: 'older-copy' });
  const loaded = data.read(store, KEY);
  assert.equal(loaded.status, 'saved');
  assert.equal(store.getItem(KEY), raw);
  assert.deepEqual(store.writes, []);
  assert.equal(data.write(store, KEY, loaded.state).ok, true);
  assert.deepEqual(store.writes, []);
  assert.equal(store.getItem(`${KEY}-recovery`), 'older-copy');
});

test('write retains the exact previous valid primary before replacing it', () => {
  const original = state();
  const raw = JSON.stringify(original, null, 2);
  const store = storage({ [KEY]: raw });
  const next = state(); next.sessions['2026-09-30']['my-exercise-7'].push({ weight: 60, reps: 9 });
  assert.equal(data.write(store, KEY, next).ok, true);
  assert.deepEqual(store.writes, [`${KEY}-recovery`, KEY]);
  assert.equal(store.getItem(`${KEY}-recovery`), raw);
  assert.deepEqual(JSON.parse(store.getItem(KEY)), next);
});

test('malformed input never overwrites either saved copy', () => {
  const raw = JSON.stringify(state());
  const store = storage({ [KEY]: raw, [`${KEY}-recovery`]: raw });
  const invalid = state(); invalid.sessions['2026-09-30']['my-exercise-7'][0].reps = 0;
  const result = data.write(store, KEY, invalid);
  assert.equal(result.ok, false);
  assert.match(result.message, /целое число/);
  assert.deepEqual(store.writes, []);
  assert.equal(store.getItem(KEY), raw);
  assert.equal(store.getItem(`${KEY}-recovery`), raw);
});

test('corrupt primary recovers without changing any stored content', () => {
  const raw = JSON.stringify(state());
  const store = storage({ [KEY]: '{broken', [`${KEY}-recovery`]: raw });
  const result = data.read(store, KEY);
  assert.equal(result.status, 'recovered');
  assert.deepEqual(result.state, state());
  assert.equal(store.getItem(KEY), '{broken');
  assert.deepEqual(store.writes, []);
});

test('saving after a corrupt primary protects the existing valid recovery copy', () => {
  const raw = JSON.stringify(state());
  const store = storage({ [KEY]: '{broken', [`${KEY}-recovery`]: raw });
  const next = state(); next.input.weight = 60;
  assert.equal(data.write(store, KEY, next).ok, true);
  assert.deepEqual(store.writes, [KEY]);
  assert.equal(store.getItem(`${KEY}-recovery`), raw);
});

test('quota failure while backing up leaves the valid primary untouched', () => {
  const raw = JSON.stringify(state());
  const store = storage({ [KEY]: raw });
  store.setItem = () => { throw new Error('QuotaExceededError'); };
  const next = state(); next.input.weight = 60;
  assert.equal(data.write(store, KEY, next).ok, false);
  assert.equal(store.getItem(KEY), raw);
  assert.equal(store.getItem(`${KEY}-recovery`), null);
});

test('quota failure on primary keeps a valid recovery and reports failure', () => {
  const raw = JSON.stringify(state());
  const store = storage({ [KEY]: raw });
  const normalSet = store.setItem.bind(store);
  store.setItem = (key, value) => { if (key === KEY) throw new Error('QuotaExceededError'); normalSet(key, value); };
  const next = state(); next.input.weight = 60;
  assert.equal(data.write(store, KEY, next).ok, false);
  assert.equal(store.getItem(KEY), raw);
  assert.equal(store.getItem(`${KEY}-recovery`), raw);
});

test('inaccessible or silently failing storage never reports success', () => {
  const broken = { getItem() { throw new Error('SecurityError'); }, setItem() {} };
  assert.equal(data.read(broken, KEY).status, 'error');
  assert.equal(data.write(broken, KEY, state()).ok, false);
  assert.equal(data.write({ getItem: () => null, setItem() {} }, KEY, state()).ok, false);
  assert.equal(data.read(null, KEY).status, 'error');
});

test('empty storage and invalid copies are distinguishable', () => {
  assert.equal(data.read(storage(), KEY).status, 'empty');
  assert.equal(data.read(storage({ [KEY]: 'null' }), KEY).status, 'error');
  assert.equal(data.read(storage({ [`${KEY}-recovery`]: '{}' }), KEY).status, 'error');
});

test('backup preserves membership, duplicate sets, deleted exercises and safe extra fields', () => {
  const original = state();
  original.sessions['2024-02-29'] = { 'deleted-user-id': [{ weight: 0, reps: 15 }, { weight: 0, reps: 15 }] };
  original.workoutPlans['2024-02-29'] = ['deleted-user-id'];
  original.completedExercises['2024-02-29'] = ['deleted-user-id'];
  original.exercises.push({ id: 'second-user-id', name: 'Жим' });
  const backup = data.createBackup(original);
  assert.equal(backup.app, 'podhod');
  assert.equal(backup.version, 1);
  assert.equal(new Date(backup.exportedAt).toISOString(), backup.exportedAt);
  assert.deepEqual(data.parseBackup(JSON.stringify(backup)), original);
  backup.state.membership.gyms.push('Другой зал');
  assert.deepEqual(original.membership.gyms, ['Минск']);
  assert.equal(backup.state.sessions['2024-02-29']['deleted-user-id'].length, 2);
});

test('minimal legacy state receives UI defaults without mutating source', () => {
  const original = { exercises: [{ id: 'user-id', name: 'Упражнение' }], sessions: {} };
  const validated = data.validateState(original);
  assert.deepEqual(original, { exercises: [{ id: 'user-id', name: 'Упражнение' }], sessions: {} });
  assert.deepEqual(validated.input, { weight: 0, reps: 10 });
  assert.deepEqual(validated.membership, { name: '', purchasedAt: '', validUntil: '', gyms: [], note: '' });
  assert.deepEqual(validated.finishedWorkouts, {});
  assert.equal(validated.settings.restSeconds, 90);
});

test('invalid dates, numbers, IDs and optional structures reject rather than discard data', () => {
  const cases = [
    s => { s.sessions['2026-02-29'] = {}; },
    s => { s.sessions['2026-09-30']['my-exercise-7'][0].weight = Infinity; },
    s => { s.sessions['2026-09-30']['my-exercise-7'][0].weight = 1000.1; },
    s => { s.sessions['2026-09-30']['my-exercise-7'][0].reps = 1.5; },
    s => { s.exercises.push({ ...s.exercises[0] }); },
    s => { s.exercises[0].id = 'toString'; },
    s => { s.exercises[0].name = ' '; },
    s => { s.workoutPlans = []; },
    s => { s.templates[0].exerciseIds = 'my-exercise-7'; },
    s => { s.completedExercises['2026-09-30'] = {}; },
    s => { s.finishedWorkouts['2026-09-30'] = 'true'; },
    s => { s.exerciseNotes['my-exercise-7'] = 123; },
    s => { s.membership.gyms = 'Минск'; },
    s => { s.membership.validUntil = '2026-02-30'; },
    s => { s.settings.restSeconds = '90'; },
    s => { s.restTimer = {}; },
    s => { s.input.reps = 0; },
    s => { s.currentExercise = -1; }
  ];
  for (const mutate of cases) {
    const value = state(); mutate(value);
    assert.throws(() => data.validateState(value), /Некорректные данные/);
  }
});

test('prototype keys and non-JSON objects are rejected throughout the backup', () => {
  const value = state();
  value.extra = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => data.validateState(value), /служебное поле/);
  const backup = data.createBackup(state());
  backup.extra = JSON.parse('{"constructor":{}}');
  assert.throws(() => data.parseBackup(JSON.stringify(backup)), /служебное поле/);
  const sparse = state(); sparse.templates = new Array(1);
  assert.throws(() => data.validateState(sparse), /пропущенные/);
  const middleHole = state(); delete middleHole.sessions['2026-09-30']['my-exercise-7'][0];
  assert.throws(() => data.validateState(middleHole), /пропущенные/);
  const cycle = state(); cycle.extra = cycle;
  assert.throws(() => data.validateState(cycle), /циклическая/);
  const nonJson = state(); nonJson.extra = new Date();
  assert.throws(() => data.validateState(nonJson), /обычный объект/);
  assert.equal({}.polluted, undefined);
});

test('raw legacy metadata can contain app and state fields without becoming a wrapper', () => {
  const original = state(); original.app = 'user-metadata'; original.state = { extra: 'metadata' };
  assert.deepEqual(data.parseBackup(JSON.stringify(original)), original);
});

test('missing primary can recover a valid secondary copy without writing', () => {
  const store = storage({ [`${KEY}-recovery`]: JSON.stringify(state()) });
  assert.equal(data.read(store, KEY).status, 'recovered');
  assert.equal(store.getItem(KEY), null);
  assert.deepEqual(store.writes, []);
});

test('foreign or unsupported backup wrappers produce readable errors', () => {
  assert.throws(() => data.parseBackup('{broken'), /JSON/);
  const backup = data.createBackup(state());
  assert.throws(() => data.parseBackup(JSON.stringify({ ...backup, app: 'other' })), /другим приложением/);
  assert.throws(() => data.parseBackup(JSON.stringify({ ...backup, version: 2 })), /не поддерживается/);
  assert.throws(() => data.parseBackup(JSON.stringify({ ...backup, exportedAt: '2026-02-30T00:00:00.000Z' })), /формате ISO/);
});

test('five MiB limit counts UTF-8 bytes and refuses writes before mutation', () => {
  assert.throws(() => data.parseBackup(' '.repeat(data.MAX_BACKUP_BYTES + 1)), /5 МБ/);
  const oversized = state(); oversized.extra = 'я'.repeat(data.MAX_BACKUP_BYTES / 2);
  const store = storage({ [KEY]: JSON.stringify(state()) });
  assert.equal(data.write(store, KEY, oversized).ok, false);
  assert.deepEqual(store.writes, []);
  assert.throws(() => data.createBackup(oversized), /5 МБ/);
});
