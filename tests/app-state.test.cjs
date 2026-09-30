const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const KEY = 'podhod-gym-log-v1';
const DAY = '2026-09-30';
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const appSource = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const dataSource = fs.readFileSync(path.join(__dirname, '../data-store.js'), 'utf8');

function journal() {
  return {
    exercises: [{ id: 'a', name: 'Первое' }, { id: 'b', name: 'Второе' }],
    sessions: { [DAY]: { a: [{ weight: 10, reps: 10 }] } },
    workoutPlans: { [DAY]: ['a'] },
    templates: [{ id: 'main', name: 'Основная', exerciseIds: ['a'] }],
    completedExercises: { [DAY]: ['a'] },
    finishedWorkouts: { [DAY]: true }
  };
}

// Run the real application against an isolated DOM/storage double. No browser
// or user storage is involved, and production code needs no test-only hooks.
function boot(initial = {}, options = {}) {
  const entries = new Map(Object.entries(initial));
  const writes = [];
  const elements = new Map();
  const downloads = [];
  const now = new Date(2026, 8, 30, 12).getTime();
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  function element() {
    const listeners = new Map();
    return {
      value: '', textContent: '', innerHTML: '', hidden: false, open: false,
      style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, callback) {
        const handlers = listeners.get(type) || [];
        handlers.push(callback);
        listeners.set(type, handlers);
      },
      dispatch(type, event = {}) {
        event.target ||= this;
        event.currentTarget ||= this;
        event.preventDefault ||= () => {};
        return Promise.all((listeners.get(type) || []).map(callback => callback(event)));
      },
      setAttribute() {}, removeAttribute() {}, focus() {}, select() {}, blur() {},
      showModal() { this.open = true; }, close() { this.open = false; },
      click() {}, remove() {}, matches() { return false; }
    };
  }
  function select(selector) {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  }
  const storage = {
    getItem: key => entries.get(key) ?? null,
    setItem(key, value) {
      if (options.failWrites) throw new Error('QuotaExceededError');
      writes.push(key);
      entries.set(key, value);
    }
  };
  const sandbox = {
    Date: FixedDate, Intl, Blob, console,
    window: { localStorage: storage, addEventListener() {}, scrollTo() {} },
    document: {
      querySelector: select, querySelectorAll: () => [], addEventListener() {},
      createElement: element, body: { append() {} }
    },
    navigator: {}, confirm: () => true,
    URL: { createObjectURL(blob) { downloads.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
    requestAnimationFrame: callback => callback(),
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(dataSource, sandbox);
  const testSource = appSource.replace('      registerModelTools();',
    '      globalThis.appTest = { state: () => state, today: () => today, normalizeState, todayExerciseIds, completedToday, renderAll };\n      registerModelTools();');
  vm.runInContext(testSource, sandbox);
  return { api: sandbox.appTest, data: sandbox.PodhodData, entries, writes, select, downloads, evaluate: source => vm.runInContext(source, sandbox) };
}

function fromJournal(state) { return boot({ [KEY]: JSON.stringify(state) }); }
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('fresh load verifies its initial save and quota failure reports unsaved data', () => {
  const app = boot();
  assert.ok(app.entries.has(KEY));
  assert.equal(app.select('#save-status').textContent, 'Сохранено на устройстве');
  assert.equal(app.select('#storage-warning').hidden, true);
  const failed = boot({}, { failWrites: true });
  assert.equal(failed.entries.has(KEY), false);
  assert.match(failed.select('#save-status').textContent, /Не сохранено/);
  assert.equal(failed.select('#storage-warning').hidden, false);
});

test('unreadable saved copies are never replaced by initial demonstration data', () => {
  const initial = { [KEY]: '{broken', [`${KEY}-recovery`]: '{also-broken' };
  const app = boot(initial);
  assert.deepEqual(app.writes, []);
  assert.deepEqual(Object.fromEntries(app.entries), initial);
  assert.equal(app.select('#storage-warning').hidden, false);
});

test('a recovered journal is shown without replacing the damaged primary on startup', () => {
  const initial = { [KEY]: '{broken', [`${KEY}-recovery`]: JSON.stringify(journal()) };
  const app = boot(initial);
  assert.deepEqual(app.writes, []);
  assert.deepEqual(Object.fromEntries(app.entries), initial);
  assert.equal(app.select('#save-status').textContent, 'Восстановлена локальная копия');
  assert.equal(app.api.state().sessions[DAY].a.length, 1);
});

test('restored IDs remain intact in storage and escaped in every HTML attribute', () => {
  const id = 'x"><img src=x onerror=alert(1)>';
  const state = journal();
  state.exercises[0].id = id;
  state.sessions = { [DAY]: { [id]: [{ weight: 10, reps: 10 }] } };
  state.workoutPlans[DAY] = [id];
  state.completedExercises[DAY] = [id];
  state.templates[0].id = id;
  state.templates[0].exerciseIds = [id];
  const app = fromJournal(state);
  const escaped = 'x&quot;&gt;&lt;img src=x onerror=alert(1)&gt;';
  const editors = app.select('#exercise-editors').innerHTML;
  for (const attribute of ['data-today-exercise', 'data-exercise-name', 'data-delete-exercise']) {
    assert.ok(editors.includes(`${attribute}="${escaped}"`));
  }
  for (const selector of ['#exercise-editors', '#template-select', '#progress-exercise']) {
    assert.ok(!app.select(selector).innerHTML.includes('<img'));
  }
  assert.ok(app.select('#template-select').innerHTML.includes(`value="${escaped}"`));
  assert.ok(app.select('#progress-exercise').innerHTML.includes(`value="${escaped}"`));
  assert.equal(JSON.parse(app.entries.get(KEY)).exercises[0].id, id);
});

test('duplicate plans and completion IDs normalize to one entry per exercise', () => {
  const state = journal();
  state.workoutPlans[DAY] = ['a', 'a', 'b'];
  state.completedExercises[DAY] = ['a', 'a', 'b', 'missing'];
  const app = fromJournal(state);
  assert.deepEqual(plain(app.api.state().workoutPlans[DAY]), ['a', 'b']);
  assert.deepEqual(plain(app.api.completedToday()), ['a', 'b']);
  assert.equal(app.select('#workout-progress-fill').style.width, '100%');
  app.api.state().workoutPlans[DAY] = ['b', 'b', 'a'];
  assert.deepEqual(plain(app.api.todayExerciseIds()), ['b', 'a']);
});

test('a plan derived from a previous day also removes duplicate IDs', () => {
  const state = journal();
  state.workoutPlans = { '2026-09-29': ['b', 'b', 'a'] };
  const app = fromJournal(state);
  assert.deepEqual(plain(app.api.state().workoutPlans[DAY]), ['b', 'a']);
});

test('applying a template with a new exercise deduplicates it and reopens the workout', async () => {
  const state = journal();
  state.templates = [{ id: 'more', name: 'Больше', exerciseIds: ['a', 'b', 'b'] }];
  const app = fromJournal(state);
  app.select('#template-select').value = 'more';
  await app.select('#apply-template').dispatch('click');
  assert.deepEqual(plain(app.api.state().workoutPlans[DAY]), ['a', 'b']);
  assert.equal(app.api.state().finishedWorkouts[DAY], false);
});

test('selecting or creating another exercise reopens a finished workout', async () => {
  const selected = fromJournal(journal());
  await selected.select('#exercise-editors').dispatch('change', {
    target: { dataset: { todayExercise: 'b' }, checked: true }
  });
  assert.equal(selected.api.state().finishedWorkouts[DAY], false);
  const created = fromJournal(journal());
  await created.select('#add-exercise').dispatch('click');
  assert.equal(created.api.state().finishedWorkouts[DAY], false);
  assert.equal(created.api.state().workoutPlans[DAY].length, 2);
});

test('large valid exports fit the import limit and can be restored', async () => {
  const app = fromJournal(journal());
  app.evaluate('appTest.state().extraHistory = Array.from({ length: 100000 }, () => ({ weight: 10, reps: 10 }))');
  const backup = app.data.createBackup(app.api.state());
  assert.ok(Buffer.byteLength(JSON.stringify(backup, null, 2)) > app.data.MAX_BACKUP_BYTES);
  await app.select('#export-data').dispatch('click');
  assert.equal(app.downloads.length, 1);
  assert.ok(app.downloads[0].size <= app.data.MAX_BACKUP_BYTES);
  const restored = app.data.parseBackup(await app.downloads[0].text());
  assert.equal(restored.extraHistory.length, 100000);
});

test('export validation errors show a useful message without an uncaught exception', async () => {
  const app = fromJournal(journal());
  app.api.state().input.reps = 0;
  await assert.doesNotReject(app.select('#export-data').dispatch('click'));
  assert.equal(app.downloads.length, 0);
  assert.match(app.select('#toast').textContent, /Некорректные данные/);
});

async function selectBackup(app, source) {
  await app.select('#import-file').dispatch('change', {
    target: { value: 'test-backup.json', files: [{ size: Buffer.byteLength(source), text: async () => source }] }
  });
}

test('restoring previews a validated backup before replacing state and retains the old copy', async () => {
  const original = journal();
  const raw = JSON.stringify(original);
  const app = boot({ [KEY]: raw });
  const before = plain(app.api.state());
  const imported = journal();
  imported.sessions[DAY].a = [{ weight: 60, reps: 8 }];
  await selectBackup(app, JSON.stringify(imported));
  assert.equal(app.select('#restore-dialog').open, true);
  assert.deepEqual(plain(app.api.state()), before);
  assert.equal(app.entries.get(KEY), raw);
  await app.select('#confirm-restore').dispatch('click');
  assert.equal(app.api.state().sessions[DAY].a[0].weight, 60);
  assert.equal(JSON.parse(app.entries.get(KEY)).sessions[DAY].a[0].weight, 60);
  assert.equal(app.entries.get(`${KEY}-recovery`), raw);
  assert.equal(app.select('#restore-dialog').open, false);
});

test('failed restore leaves current state and storage unchanged and keeps the preview open', async () => {
  const raw = JSON.stringify(journal());
  const app = boot({ [KEY]: raw }, { failWrites: true });
  const before = plain(app.api.state());
  const imported = journal();
  imported.sessions[DAY].a = [{ weight: 60, reps: 8 }];
  await selectBackup(app, JSON.stringify(imported));
  await app.select('#confirm-restore').dispatch('click');
  assert.deepEqual(plain(app.api.state()), before);
  assert.equal(app.entries.get(KEY), raw);
  assert.equal(app.select('#restore-dialog').open, true);
  assert.match(app.select('#toast').textContent, /Не удалось сохранить/);
});

test('invalid imported data never opens confirmation or changes the existing journal', async () => {
  const app = fromJournal(journal());
  const before = plain(app.api.state());
  await selectBackup(app, '{broken');
  assert.equal(app.select('#restore-dialog').open, false);
  await app.select('#confirm-restore').dispatch('click');
  assert.deepEqual(plain(app.api.state()), before);
  assert.deepEqual(app.writes, []);
});
