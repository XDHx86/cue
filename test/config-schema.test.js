const assert = require('node:assert/strict');
const test = require('node:test');
const { SCHEMA, uiEntries, schemaDefaults, validate, getNested, setNested } = require('../src/config-schema');

// ---- schema integrity ----

test('every schema entry has required fields', () => {
  for (const e of SCHEMA) {
    assert.ok(e.path, `entry missing path: ${JSON.stringify(e)}`);
    assert.ok(e.type, `entry ${e.path} missing type`);
    assert.ok(typeof e.default === 'number' || typeof e.default === 'boolean' || typeof e.default === 'string',
      `entry ${e.path} default is not a primitive`);
    // min/max apply only to numeric types; string/bool entries legitimately have none.
    if (e.type === 'int' || e.type === 'float') {
      assert.ok(typeof e.min === 'number', `entry ${e.path} missing min`);
      assert.ok(typeof e.max === 'number', `entry ${e.path} missing max`);
    }
    assert.ok(e.tier === 'ui', `entry ${e.path} has invalid tier: ${e.tier}`);
  }
});

test('every default is within [min, max]', () => {
  for (const e of SCHEMA) {
    if (e.type === 'int' || e.type === 'float') {
      assert.ok(e.default >= e.min, `${e.path}: default ${e.default} < min ${e.min}`);
      assert.ok(e.default <= e.max, `${e.path}: default ${e.default} > max ${e.max}`);
    }
  }
});

test('ui-tier entries have tab, section, label, and hint', () => {
  for (const e of SCHEMA.filter((e) => e.tier === 'ui')) {
    assert.ok(e.tab, `${e.path} ui entry missing tab`);
    assert.ok(e.section, `${e.path} ui entry missing section`);
    assert.ok(e.label, `${e.path} ui entry missing label`);
    assert.ok(e.hint, `${e.path} ui entry missing hint`);
  }
});

test('no duplicate paths in schema', () => {
  const seen = new Set();
  for (const e of SCHEMA) {
    assert.ok(!seen.has(e.path), `duplicate path ${e.path} in schema`);
    seen.add(e.path);
  }
});

// ---- helpers ----

test('getNested reads nested values', () => {
  const obj = { a: { b: { c: 42 } } };
  assert.equal(getNested(obj, 'a.b.c'), 42);
  assert.equal(getNested(obj, 'a.b.d'), undefined);
  assert.equal(getNested(null, 'a'), undefined);
});

test('setNested creates intermediate objects and sets values', () => {
  const obj = {};
  setNested(obj, 'a.b.c', 99);
  assert.deepEqual(obj, { a: { b: { c: 99 } } });
});

// ---- validation ----

test('validate clamps out-of-range values to min/max', () => {
  const data = { llm: { maxTokens: -100 } };
  validate(data);
  assert.equal(data.llm.maxTokens, 256); // clamped to min
});

test('validate clamps above max', () => {
  const data = { llm: { maxTokens: 999999 } };
  validate(data);
  assert.equal(data.llm.maxTokens, 32768); // clamped to max
});

test('validate replaces NaN with default', () => {
  const data = { llm: { maxTokens: 'not-a-number' } };
  validate(data);
  assert.equal(data.llm.maxTokens, 4096); // default
});

test('validate handles missing keys gracefully (creates them with defaults)', () => {
  const data = {};
  validate(data);
  // After validation, the schema keys should exist with defaults
  assert.equal(getNested(data, 'llm.maxTokens'), 4096);
  assert.equal(getNested(data, 'memory.minNewTurns'), 10);
  assert.equal(getNested(data, 'ui.zoomMin'), 0.5);
});

test('validate leaves valid values unchanged', () => {
  const data = { llm: { maxTokens: 8192 } };
  validate(data);
  assert.equal(data.llm.maxTokens, 8192);
});

// ---- schemaDefaults ----

test('schemaDefaults produces an object with all schema paths', () => {
  const defaults = schemaDefaults();
  assert.equal(getNested(defaults, 'llm.maxTokens'), 4096);
  assert.equal(getNested(defaults, 'memory.minNewTurns'), 10);
  assert.equal(getNested(defaults, 'stt.maxSpawnFailures'), 3);
  assert.equal(getNested(defaults, 'ui.zoomMin'), 0.5);
  assert.equal(getNested(defaults, 'python.beamSize'), 1);
});

// ---- uiEntries ----

test('uiEntries returns only ui-tier entries with safe fields', () => {
  const ui = uiEntries();
  assert.ok(ui.length > 0, 'should have at least one ui entry');
  for (const e of ui) {
    assert.equal(e.tier, undefined, 'uiEntries should not include tier field');
    assert.ok(e.path, 'ui entry should have path');
    assert.ok(e.label, 'ui entry should have label');
  }
  // Verify some known ui entries exist
  const paths = ui.map((e) => e.path);
  assert.ok(paths.includes('llm.maxTokens'), 'should include llm.maxTokens');
  assert.ok(paths.includes('ui.zoomMin'), 'should include ui.zoomMin');
  assert.ok(paths.includes('stt.maxSpawnFailures'), 'should include stt.maxSpawnFailures');
});

test('uiEntries passes kind/type so the renderer renders strings, bools, and textareas', () => {
  const ui = uiEntries();
  const byPath = Object.fromEntries(ui.map((e) => [e.path, e]));
  // Textarea entries (preprompt templates) must carry kind:'textarea'.
  const concise = byPath['promptOverrides.prepromptTemplates.concise'];
  assert.ok(concise, 'preprompt concise template missing from uiEntries');
  assert.equal(concise.kind, 'textarea', 'textarea entries must pass kind through uiEntries');
  assert.equal(concise.type, 'string');
  // Logging fields: string and bool types must pass through.
  const lvl = byPath['stt.logging.level'];
  assert.ok(lvl, 'stt.logging.level missing from uiEntries');
  assert.equal(lvl.type, 'string', 'logging.level must be string type');
  const con = byPath['stt.logging.console'];
  assert.ok(con, 'stt.logging.console missing from uiEntries');
  assert.equal(con.type, 'bool', 'logging.console must be bool type');
});

test('screen.contentProtection exists and defaults to true (capture exclusion stays on)', () => {
  const defaults = schemaDefaults();
  assert.equal(getNested(defaults, 'screen.contentProtection'), true,
    'contentProtection must default true so existing users keep capture exclusion');
  const ui = uiEntries();
  const entry = ui.find((e) => e.path === 'screen.contentProtection');
  assert.ok(entry, 'contentProtection must be a ui entry');
  assert.equal(entry.type, 'bool');
  assert.equal(entry.default, true);
  assert.equal(entry.tab, 'advanced');
  assert.equal(entry.section, 'Screen Capture');
});

test('validate coerces screen.contentProtection to a bool', () => {
  // Missing key → !!undefined = false (validate only coerces, defaults come from deepMerge in store)
  const data = { screen: { contentProtection: 0 } };
  validate(data);
  assert.equal(data.screen.contentProtection, false);
  // Once filled by deepMerge(store.DEFAULTS), validate leaves true untouched
  const data2 = { screen: { contentProtection: true } };
  validate(data2);
  assert.equal(data2.screen.contentProtection, true);
  // Truthy string coerces to true
  const data3 = { screen: { contentProtection: 'yes' } };
  validate(data3);
  assert.equal(data3.screen.contentProtection, true);
});

// (buildEnvMap removed — .env system eliminated)
