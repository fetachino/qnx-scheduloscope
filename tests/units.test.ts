import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, gcd, lcm, parseDuration } from '../src/core/units.js';

test('parseDuration understands every documented unit', () => {
  assert.equal(parseDuration('1ms'), 1000);
  assert.equal(parseDuration('250us'), 250);
  assert.equal(parseDuration('250 µs'), 250);
  assert.equal(parseDuration('2s'), 2_000_000);
  assert.equal(parseDuration('1.5ms'), 1500);
  assert.equal(parseDuration('1 ms'), 1000);
  assert.equal(parseDuration('500'), 500, 'a bare number is microseconds');
});

test('parseDuration keeps sub-microsecond values instead of rounding them to zero', () => {
  assert.equal(parseDuration('100ns'), 0.1);
  assert.equal(parseDuration('1ns'), 0.001);
});

test('parseDuration rejects text that is not a duration', () => {
  for (const text of ['', 'abc', '-1ms', '1 fortnights', 'ms', '1e3ms']) {
    assert.equal(parseDuration(text), undefined, text);
  }
});

test('formatDuration picks a readable unit', () => {
  assert.equal(formatDuration(0), '0ns');
  assert.equal(formatDuration(0.5), '500ns');
  assert.equal(formatDuration(250), '250us');
  assert.equal(formatDuration(1000), '1ms');
  assert.equal(formatDuration(1500), '1.5ms');
  assert.equal(formatDuration(2_000_000), '2s');
  assert.equal(formatDuration(1_234_567), '1.235s');
});

test('formatDuration and parseDuration round-trip common values', () => {
  for (const micros of [250, 1000, 1500, 4_000, 20_000]) {
    assert.equal(parseDuration(formatDuration(micros)), micros);
  }
});

test('gcd and lcm back the hyperperiod computation', () => {
  assert.equal(gcd(12, 18), 6);
  assert.equal(gcd(7, 13), 1);
  assert.equal(lcm(2, 5), 10);
  assert.equal(lcm(1000, 5000), 5000);
  assert.equal(lcm(0, 5), 0);
});
