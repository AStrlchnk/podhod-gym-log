const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const KEY = 'podhod-gym-log-v1';
const OLD_DAY = '2026-09-30';
const NEW_DAY = '2026-10-01';
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const appSource = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const dataSource = fs.readFileSync(path.join(__dirname, '../data-store.js'), 'utf8');

function journal() {
  return {
    exercises: [{ id: 'bench', name: 'Жим' }, { id: 'row', name: 'Тяга' }],
    currentExercise: 0,
    input: { weight: 20, reps: 10 },
    sessions: {
      [OLD_DAY]: { bench: [{ weight: 20, reps: 10 }, { weight: 19, reps: 9 }], row: [{ weight: 30, reps: 8 }] },
      [NEW_DAY]: { bench: [{ weight: 25, reps: 12 }, { weight: 24, reps: 11 }], row: [{ weight: 35, reps: 8 }] }
    },
    workoutPlans: { [OLD_DAY]: ['bench', 'row'], [NEW_DAY]: ['row', 'bench'] },
    completedExercises: { [OLD_DAY]: ['bench'], [NEW_DAY]: [] },
    finishedWorkouts: { [OLD_DAY]: true, [NEW_DAY]: false },
    templates: [{ id: 'main', name: 'Основная', exerciseIds: ['bench', 'row'] }]
  };
}

// Execute unmodified production scripts with a controllable clock and isolated
// DOM/storage doubles. Timer callbacks run only when a test explicitly fires one.
function boot(initial) {
  const entries = new Map(Object.entries(initial));
  const writes = [];
  const elements = new Map();
  const timers = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  let now = new Date(2026, 8, 30, 23, 59, 55).getTime();
  let timerId = 0;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  function element() {
    const listeners = new Map();
    const classes = new Set();
    return {
      value: '', textContent: '', innerHTML: '', hidden: false, open: false, style: {}, dataset: {},
      classList: {
        add: (...values) => values.forEach(value => classes.add(value)),
        remove: (...values) => values.forEach(value => classes.delete(value)),
        contains: value => classes.has(value),
        toggle(value, force) {
          const enabled = force === undefined ? !classes.has(value) : force;
          if (enabled) classes.add(value); else classes.delete(value);
          return enabled;
        }
      },
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
      setAttribute() {}, removeAttribute() {}, focus() {}, select() {}, blur() {}, click() {}, remove() {},
      showModal() { this.open = true; }, close() { this.open = false; }, matches() { return false; }
    };
  }
  function select(selector) {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  }
  function schedule(kind, callback, delay) {
    const id = ++timerId;
    timers.set(id, { kind, callback, delay });
    return id;
  }
  const sandbox = {
    Date: FixedDate, Intl, Blob, console,
    window: {
      localStorage: {
        getItem: key => entries.get(key) ?? null,
        setItem(key, value) { writes.push(key); entries.set(key, value); }
      },
      addEventListener(type, callback) { windowListeners.set(type, callback); }, scrollTo() {}
    },
    document: {
      querySelector: select, querySelectorAll: () => [], hidden: false,
      addEventListener(type, callback) { documentListeners.set(type, callback); },
      createElement: element, body: { append() {} }
    },
    navigator: {}, confirm: () => true,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    requestAnimationFrame: callback => callback(),
    setTimeout: (callback, delay) => schedule('timeout', callback, delay),
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => schedule('interval', callback, delay),
    clearInterval: id => timers.delete(id)
  };
  vm.createContext(sandbox);
  vm.runInContext(dataSource, sandbox, { filename: 'data-store.js' });
  vm.runInContext(appSource, sandbox, { filename: 'index.html' });
  return {
    select, entries, writes, timers, documentListeners, windowListeners,
    advanceToNextDay() { now = new Date(2026, 9, 1, 0, 0, 10).getTime(); },
    stored() { return JSON.parse(entries.get(KEY)); },
    runTimer(id) {
      const timer = timers.get(id);
      assert.ok(timer, `Timer ${id} must exist`);
      if (timer.kind === 'timeout') timers.delete(id);
      timer.callback();
    }
  };
}

function fromJournal(value = journal()) { return boot({ [KEY]: JSON.stringify(value) }); }
function delegatedTarget(selector, dataset = {}) {
  return { dataset, closest(value) { return value === selector ? this : null; } };
}

test('midnight timeout switches day, restores its plan and schedules the next midnight', () => {
  const app = fromJournal();
  assert.equal(app.select('#exercise-name').textContent, 'Жим');
  const [id, timer] = [...app.timers].find(([, value]) => value.kind === 'timeout' && value.delay === 5020);
  assert.equal(timer.delay, 5020);
  app.advanceToNextDay();
  app.runTimer(id);
  assert.equal(app.select('#exercise-name').textContent, 'Тяга');
  assert.match(app.select('#today-label').textContent, /1 октября/);
  const saved = app.stored();
  assert.deepEqual(saved.workoutPlans[NEW_DAY], ['row', 'bench']);
  assert.deepEqual(saved.input, { weight: 35, reps: 8 });
  assert.deepEqual(saved.sessions[OLD_DAY], journal().sessions[OLD_DAY]);
  assert.deepEqual(saved.completedExercises[OLD_DAY], ['bench']);
  assert.ok([...app.timers.values()].some(value => value.kind === 'timeout' && value.delay > 23 * 60 * 60 * 1000));
});

test('complete action after midnight synchronizes before saving the new day', async () => {
  const app = fromJournal();
  app.advanceToNextDay();
  // The midnight callback is deliberately suspended, as in a backgrounded tab.
  await app.select('#complete-exercise').dispatch('click');
  const saved = app.stored();
  assert.deepEqual(saved.completedExercises[NEW_DAY], ['row']);
  assert.deepEqual(saved.completedExercises[OLD_DAY], ['bench']);
  assert.equal(saved.finishedWorkouts[OLD_DAY], true);
  assert.equal(saved.finishedWorkouts[NEW_DAY], false);
});

test('finish action after midnight changes only the new day', async () => {
  const app = fromJournal();
  app.advanceToNextDay();
  await app.select('#workout-summary').dispatch('click', { target: delegatedTarget('#finish-workout') });
  const saved = app.stored();
  assert.equal(saved.finishedWorkouts[NEW_DAY], true);
  assert.equal(saved.finishedWorkouts[OLD_DAY], true);
  assert.deepEqual(saved.sessions[OLD_DAY], journal().sessions[OLD_DAY]);
  assert.match(app.select('#workout-summary').innerHTML, /Тренировка завершена/);
});

test('edit dialog retains the original day, exercise and set index across rollover', async () => {
  const original = journal();
  const app = fromJournal(original);
  await app.select('#sets-list').dispatch('click', { target: delegatedTarget('[data-edit-set]', { editSet: '1' }) });
  assert.equal(app.select('#edit-set-dialog').open, true);
  assert.equal(app.select('#edit-set-weight').value, '19');
  const [midnight] = [...app.timers].find(([, value]) => value.kind === 'timeout' && value.delay === 5020);
  app.advanceToNextDay();
  app.runTimer(midnight);
  assert.equal(app.select('#exercise-name').textContent, 'Тяга');
  app.select('#edit-set-weight').value = '99,25';
  app.select('#edit-set-reps').value = '7';
  await app.select('#edit-set-form').dispatch('submit');
  const expectedOld = original.sessions[OLD_DAY];
  expectedOld.bench[1] = { weight: 99.25, reps: 7 };
  assert.deepEqual(app.stored().sessions[OLD_DAY], expectedOld);
  assert.deepEqual(app.stored().sessions[NEW_DAY], original.sessions[NEW_DAY]);
  assert.equal(app.select('#edit-set-dialog').open, false);
});

test('visibility and focus resume the correct day while the midnight timer is suspended', () => {
  for (const event of ['visibilitychange', 'focus']) {
    const app = fromJournal();
    app.advanceToNextDay();
    const listeners = event === 'focus' ? app.windowListeners : app.documentListeners;
    listeners.get(event)();
    assert.equal(app.select('#exercise-name').textContent, 'Тяга');
    assert.deepEqual(app.stored().input, { weight: 35, reps: 8 });
  }
});

test('corrupt storage remains intact through rollover and user actions', async () => {
  const corrupt = { [KEY]: '{broken-primary', [`${KEY}-recovery`]: '{broken-recovery' };
  const app = boot(corrupt);
  assert.deepEqual(app.writes, []);
  const [midnight] = [...app.timers].find(([, value]) => value.kind === 'timeout' && value.delay === 5020);
  app.advanceToNextDay();
  app.runTimer(midnight);
  await app.select('#complete-exercise').dispatch('click');
  await app.select('#workout-summary').dispatch('click', { target: delegatedTarget('#finish-workout') });
  assert.deepEqual(app.writes, []);
  assert.deepEqual(Object.fromEntries(app.entries), corrupt);
  assert.equal(app.select('#storage-warning').hidden, false);
  assert.equal(app.select('#save-status').textContent, 'Сохранение остановлено');
});
