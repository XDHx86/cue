const assert = require('node:assert/strict');
const test = require('node:test');
const { parseDotenv, parseLine, applyEnv } = require('../src/env');

test('parseLine extracts KEY=value', () => {
  assert.deepEqual(parseLine('FOO=bar'), ['FOO', 'bar']);
  assert.deepEqual(parseLine('FOO=hello world'), ['FOO', 'hello world']);
  assert.deepEqual(parseLine('  FOO=bar  '), ['FOO', 'bar']); // trims whitespace
});

test('parseLine skips blank lines and # comments', () => {
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('   '), null);
  assert.equal(parseLine('# a comment'), null);
  assert.equal(parseLine('   # indented comment'), null);
});

test('parseLine strips a single surrounding quote pair only', () => {
  assert.equal(parseLine('FOO="bar"')[1], 'bar');
  assert.equal(parseLine("FOO='bar'")[1], 'bar');
  assert.equal(parseLine('FOO="bar"baz')[1], '"bar"baz', 'only a fully surrounding pair is stripped');
  assert.equal(parseLine('FOO="it\'s a test"')[1], "it's a test", 'internal quotes preserved');
});

test('parseLine rejects malformed lines', () => {
  assert.equal(parseLine('=novalue'), null, 'empty key rejected');
  assert.equal(parseLine('1FOO=bar'), null, 'key starting with digit rejected');
  assert.equal(parseLine('FOO BAR=baz'), null, 'key with space rejected');
  assert.equal(parseLine('noequalsign'), null, 'no = rejected');
});

test('parseDotenv parses a multi-line body', () => {
  const out = parseDotenv('# header\nFOO=1\n\nBAR="two"\nBAZ=\'three\'\n');
  assert.deepEqual(out, { FOO: '1', BAR: 'two', BAZ: 'three' });
});

test('applyEnv does not override vars already set by the shell', () => {
  const saved = process.env.CUE_TEST_PRESENT;
  const savedMissing = process.env.CUE_TEST_APPLIED;
  delete process.env.CUE_TEST_APPLIED;
  process.env.CUE_TEST_PRESENT = 'from-shell';
  try {
    const n = applyEnv({ CUE_TEST_PRESENT: 'from-file', CUE_TEST_APPLIED: 'new' });
    assert.equal(n, 1, 'only one var freshly applied (the one not already set)');
    assert.equal(process.env.CUE_TEST_PRESENT, 'from-shell', 'shell-set var wins');
    assert.equal(process.env.CUE_TEST_APPLIED, 'new', 'unset var applied');
  } finally {
    if (saved !== undefined) process.env.CUE_TEST_PRESENT = saved; else delete process.env.CUE_TEST_PRESENT;
    if (savedMissing !== undefined) process.env.CUE_TEST_APPLIED = savedMissing; else delete process.env.CUE_TEST_APPLIED;
  }
});
