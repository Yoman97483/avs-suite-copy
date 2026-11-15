const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web-admin/admin.js'), 'utf8');

function section(start, end) {
  const offset = source.indexOf(start);
  assert.ok(offset >= 0);
  const limit = source.indexOf(end, offset + start.length);
  assert.ok(limit > offset);
  return source.slice(offset, limit);
}

for (const [table, singular, nextSection] of [
  ['employees', 'employee', '// --------- Gestion Clients'],
  ['clients', 'client', '// --------- Gestion Interventions'],
]) {
  const loadName = `load${table[0].toUpperCase()}${table.slice(1)}`;
  const resetName = `reset${singular[0].toUpperCase()}${singular.slice(1)}Form`;

  test(`${table}: list applies only the visibility filter`, async () => {
    const calls = [];
    const query = {
      select(...args) { calls.push(['select', ...args]); return this; },
      eq(...args) { calls.push(['eq', ...args]); return this; },
      order() { return this; },
      then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); },
    };
    const context = vm.createContext({
      [`${table}TableBody`]: { innerHTML: '' },
      supabase: { from(name) { assert.equal(name, table); return query; } },
    });
    vm.runInContext(section(`async function ${loadName}()`, `if (${singular}Form)`), context);
    await context[loadName]();
    assert.deepEqual(calls.filter(([method]) => method === 'eq'), [['eq', 'hidden_from_admin_list', false]]);
  });

  for (const failed of [false, true]) {
    test(`${table}: visual delete ${failed ? 'keeps the list on failure' : 'updates only the visibility flag'}`, async () => {
      const calls = [];
      let listener;
      let reloads = 0;
      let resets = 0;
      const alerts = [];
      class Element {
        dataset = { action: 'delete' };
        closest() { return { dataset: { id: 'existing-record-with-history' } }; }
      }
      const query = {
        update(value) { calls.push(['update', JSON.parse(JSON.stringify(value))]); return this; },
        eq(...args) { calls.push(['eq', ...args]); return this; },
        select(...args) { calls.push(['select', ...args]); return this; },
        single() { return Promise.resolve({ error: failed ? { message: 'Denied' } : null }); },
        delete() { throw new Error('Physical deletion must never be called'); },
      };
      const context = vm.createContext({
        HTMLElement: Element,
        [`${table}TableBody`]: { addEventListener(event, callback) { assert.equal(event, 'click'); listener = callback; } },
        [`${singular}IdInput`]: { value: 'existing-record-with-history' },
        [loadName]: async () => { reloads++; },
        [resetName]: () => { resets++; },
        alert: message => alerts.push(message),
        supabase: { from(name) { assert.equal(name, table); return query; } },
      });
      vm.runInContext(section(`if (${table}TableBody)`, nextSection), context);
      await listener({ target: new Element() });
      assert.deepEqual(calls, [
        ['update', { hidden_from_admin_list: true }],
        ['eq', 'id', 'existing-record-with-history'],
        ['select', 'id'],
      ]);
      assert.equal(reloads, failed ? 0 : 1);
      assert.equal(resets, failed ? 0 : 1);
      assert.deepEqual(alerts, failed ? ['Denied'] : []);
    });
  }
}

test('visibility filtering is limited to the two management lists', () => {
  assert.equal((source.match(/\.eq\('hidden_from_admin_list', false\)/g) || []).length, 2);
  assert.equal((source.match(/hidden_from_admin_list/g) || []).length, 4);
});

test('employee creation does not automatically request a password reset', () => {
  const creation = section('if (employeeForm)', 'if (employeeResetBtn)');
  assert.doesNotMatch(creation, /resetPasswordForEmail/);
  assert.match(
    creation,
    /Utilisez le bouton Envoyer reset mot de passe/
  );
});

test('password reset is requested only by the employee list button', () => {
  const listActions = section('if (employeesTableBody)', '// --------- Gestion Clients');
  assert.equal((listActions.match(/resetPasswordForEmail/g) || []).length, 1);
});
