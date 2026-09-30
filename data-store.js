(function (root) {
  'use strict';

  const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
  const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
  const unsafeIds = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

  function invalid(path, reason) {
    const location = path.length > 160 ? `${path.slice(0, 157)}…` : path;
    throw new Error(`Некорректные данные: ${location} — ${reason}.`);
  }

  function byteLength(text) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
    let bytes = 0;
    for (const character of text) {
      const code = character.codePointAt(0);
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
  }

  function bounded(text) {
    if (byteLength(text) > MAX_BACKUP_BYTES) throw new Error('Размер данных превышает 5 МБ.');
    return text;
  }

  // Copy every safe JSON field, including fields unknown to the current UI.
  function cloneJson(value, path = 'журнал', ancestors = new Set(), depth = 0) {
    if (depth > 64) invalid(path, 'слишком большая вложенность');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object') invalid(path, 'ожидалось значение JSON');
    if (ancestors.has(value)) invalid(path, 'циклическая ссылка');
    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!isArray && prototype !== Object.prototype && prototype !== null) invalid(path, 'ожидался обычный объект');
    if (Object.getOwnPropertySymbols(value).length) invalid(path, 'символьные поля не поддерживаются');
    const keys = Object.getOwnPropertyNames(value);
    if (isArray && keys.length !== value.length + 1) invalid(path, 'массив содержит пропущенные элементы или посторонние поля');
    const result = isArray ? [] : {};
    ancestors.add(value);
    for (const key of keys) {
      if (isArray && key === 'length') continue;
      if (forbiddenKeys.has(key)) invalid(path, 'недопустимое служебное поле');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !own(descriptor, 'value')) invalid(path, 'ожидалось обычное поле JSON');
      if (isArray && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) invalid(path, 'у массива есть посторонние поля');
      result[key] = cloneJson(descriptor.value, `${path}.${key}`, ancestors, depth + 1);
    }
    ancestors.delete(value);
    if (isArray && result.length !== value.length) invalid(path, 'массив содержит пропущенные элементы');
    return result;
  }

  function record(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'ожидался объект');
    return value;
  }

  function array(value, path) {
    if (!Array.isArray(value)) invalid(path, 'ожидался массив');
    return value;
  }

  function string(value, path, nonempty = false) {
    if (typeof value !== 'string' || (nonempty && !value.trim())) invalid(path, nonempty ? 'ожидалась непустая строка' : 'ожидалась строка');
    return value;
  }

  function id(value, path) {
    string(value, path, true);
    if (unsafeIds.has(value) || /[\u0000-\u001f\u007f]/.test(value)) invalid(path, 'недопустимый идентификатор');
    return value;
  }

  function date(value, path, allowEmpty = false) {
    if (allowEmpty && value === '') return value;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(path, 'ожидалась дата ГГГГ-ММ-ДД');
    const [year, month, day] = value.split('-').map(Number);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) invalid(path, 'несуществующая дата');
    return value;
  }

  function number(value, path, min, max, integer = false) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      invalid(path, `ожидалось ${integer ? 'целое число' : 'число'} от ${min} до ${max}`);
    }
  }

  function idArray(value, path) {
    array(value, path).forEach((value, index) => id(value, `${path}.${index}`));
  }

  function dateMap(value, path, check) {
    for (const [day, entry] of Object.entries(record(value, path))) {
      date(day, `${path}.${day}`);
      check(entry, `${path}.${day}`);
    }
  }

  function validateState(value) {
    const state = record(cloneJson(value), 'журнал');
    const exercises = array(state.exercises, 'упражнения');
    if (!exercises.length) invalid('упражнения', 'нужно хотя бы одно упражнение');
    const ids = new Set();
    exercises.forEach((exercise, index) => {
      const path = `упражнения.${index}`;
      record(exercise, path);
      id(exercise.id, `${path}.id`);
      string(exercise.name, `${path}.name`, true);
      if (ids.has(exercise.id)) invalid(path, 'идентификатор упражнения повторяется');
      ids.add(exercise.id);
    });
    dateMap(state.sessions, 'история', (session, path) => {
      for (const [exerciseId, sets] of Object.entries(record(session, path))) {
        id(exerciseId, `${path}.id`);
        array(sets, `${path}.${exerciseId}`).forEach((set, index) => {
          const setPath = `${path}.${exerciseId}.${index}`;
          record(set, setPath);
          number(set.weight, `${setPath}.weight`, 0, 1000);
          number(set.reps, `${setPath}.reps`, 1, 1000, true);
        });
      }
    });

    if (!own(state, 'workoutPlans')) state.workoutPlans = {};
    dateMap(state.workoutPlans, 'планы', idArray);
    if (!own(state, 'templates')) state.templates = [];
    const templateIds = new Set();
    array(state.templates, 'шаблоны').forEach((template, index) => {
      const path = `шаблоны.${index}`;
      record(template, path);
      id(template.id, `${path}.id`);
      string(template.name, `${path}.name`, true);
      idArray(template.exerciseIds, `${path}.exerciseIds`);
      if (templateIds.has(template.id)) invalid(path, 'идентификатор шаблона повторяется');
      templateIds.add(template.id);
    });
    if (!own(state, 'completedExercises')) state.completedExercises = {};
    dateMap(state.completedExercises, 'завершённые упражнения', idArray);
    if (!own(state, 'finishedWorkouts')) state.finishedWorkouts = {};
    dateMap(state.finishedWorkouts, 'завершённые тренировки', (finished, path) => {
      if (typeof finished !== 'boolean') invalid(path, 'ожидалось true или false');
    });
    if (!own(state, 'exerciseNotes')) state.exerciseNotes = {};
    for (const [exerciseId, note] of Object.entries(record(state.exerciseNotes, 'заметки'))) {
      id(exerciseId, 'заметки.id');
      string(note, `заметки.${exerciseId}`);
    }

    if (!own(state, 'membership')) state.membership = {};
    const membership = record(state.membership, 'абонемент');
    for (const [key, fallback] of Object.entries({ name: '', purchasedAt: '', validUntil: '', gyms: [], note: '' })) {
      if (!own(membership, key)) membership[key] = fallback;
    }
    string(membership.name, 'абонемент.name');
    string(membership.note, 'абонемент.note');
    date(membership.purchasedAt, 'абонемент.purchasedAt', true);
    date(membership.validUntil, 'абонемент.validUntil', true);
    if (membership.purchasedAt && membership.validUntil && membership.validUntil < membership.purchasedAt) {
      invalid('абонемент', 'окончание раньше даты покупки');
    }
    array(membership.gyms, 'абонемент.gyms').forEach((gym, index) => string(gym, `абонемент.gyms.${index}`, true));

    if (!own(state, 'settings')) state.settings = {};
    record(state.settings, 'настройки');
    if (!own(state.settings, 'restSeconds')) state.settings.restSeconds = 90;
    number(state.settings.restSeconds, 'настройки.restSeconds', 1, 86400, true);
    if (!own(state, 'restTimer')) state.restTimer = null;
    if (state.restTimer !== null) {
      record(state.restTimer, 'таймер');
      number(state.restTimer.endAt, 'таймер.endAt', 0, Number.MAX_SAFE_INTEGER, true);
    }
    if (!own(state, 'input')) state.input = {};
    record(state.input, 'ввод');
    if (!own(state.input, 'weight')) state.input.weight = 0;
    if (!own(state.input, 'reps')) state.input.reps = 10;
    number(state.input.weight, 'ввод.weight', 0, 1000);
    number(state.input.reps, 'ввод.reps', 1, 1000, true);
    if (!own(state, 'currentExercise')) state.currentExercise = 0;
    number(state.currentExercise, 'текущее упражнение', 0, Number.MAX_SAFE_INTEGER, true);
    bounded(JSON.stringify(state));
    return state;
  }

  function parseBackup(text) {
    if (typeof text !== 'string') throw new Error('Резервная копия должна быть текстовым JSON-файлом.');
    bounded(text);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (_) { throw new Error('Не удалось прочитать JSON резервной копии.'); }
    const value = record(cloneJson(parsed), 'резервная копия');
    if ((own(value, 'app') || own(value, 'state')) && !own(value, 'exercises')) {
      if (value.app !== 'podhod') throw new Error('Эта резервная копия создана другим приложением.');
      if (value.version !== 1) throw new Error('Версия резервной копии не поддерживается.');
      if (typeof value.exportedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.exportedAt)
          || !Number.isFinite(Date.parse(value.exportedAt)) || new Date(value.exportedAt).toISOString() !== value.exportedAt) {
        invalid('резервная копия.exportedAt', 'ожидалась дата экспорта в формате ISO');
      }
      return validateState(value.state);
    }
    return validateState(value);
  }

  function createBackup(state) {
    const backup = { app: 'podhod', version: 1, exportedAt: new Date().toISOString(), state: validateState(state) };
    bounded(JSON.stringify(backup));
    return backup;
  }

  function storedText(storage, key) {
    if (!storage || typeof storage.getItem !== 'function') throw new Error('storage');
    const text = storage.getItem(key);
    if (text !== null && typeof text !== 'string') throw new Error('storage');
    return text;
  }

  function read(storage, key) {
    let primary;
    try { primary = storedText(storage, key); }
    catch (_) { return { state: null, status: 'error', message: 'Хранилище недоступно. Данные не удалось прочитать.' }; }
    if (primary !== null) {
      try { return { state: parseBackup(primary), status: 'saved', message: '' }; }
      catch (_) { /* Keep corrupt content untouched and try the recovery copy. */ }
    }
    let recovery;
    try { recovery = storedText(storage, `${key}-recovery`); }
    catch (_) { return { state: null, status: 'error', message: 'Резервное хранилище недоступно. Данные не удалось прочитать.' }; }
    if (recovery !== null) {
      try {
        return { state: parseBackup(recovery), status: 'recovered', message: 'Журнал восстановлен из резервной записи. Основная запись пока не изменена.' };
      } catch (_) { /* Neither copy is valid. */ }
    }
    if (primary === null && recovery === null) return { state: null, status: 'empty', message: '' };
    return { state: null, status: 'error', message: 'Сохранённые данные повреждены. Сначала восстанови журнал из файла резервной копии.' };
  }

  function write(storage, key, state) {
    let next;
    try { next = bounded(JSON.stringify(validateState(state))); }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'Не удалось проверить данные журнала.' }; }
    try {
      const previous = storedText(storage, key);
      if (previous === next) return { ok: true, message: '' };
      if (typeof storage.setItem !== 'function') throw new Error('storage');
      let previousIsValid = false;
      if (previous !== null) {
        try { parseBackup(previous); previousIsValid = true; }
        catch (_) { /* Never replace a valid recovery copy with corrupt primary data. */ }
      }
      if (previousIsValid) {
        storage.setItem(`${key}-recovery`, previous);
        if (storedText(storage, `${key}-recovery`) !== previous) throw new Error('recovery');
      }
      storage.setItem(key, next);
      if (storedText(storage, key) !== next) throw new Error('storage');
      return { ok: true, message: '' };
    } catch (_) {
      return { ok: false, message: 'Не удалось сохранить журнал: хранилище недоступно или заполнено. Скачай резервную копию.' };
    }
  }

  const api = Object.freeze({ read, write, parseBackup, validateState, createBackup, MAX_BACKUP_BYTES });
  root.PodhodData = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'object' ? globalThis : window);
