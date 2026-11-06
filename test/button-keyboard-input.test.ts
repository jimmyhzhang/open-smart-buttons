import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonKeyboardInput, isButtonActivationKey } from '../ui/src/lib/button-keyboard-input.ts';
import { decodeInput, encodeKeysInput } from '../src/protocol/reports.ts';

function fixture() {
  const states = new Array<boolean>(10).fill(false);
  const reports: number[][] = [];
  const input = new ButtonKeyboardInput(states, (current) => {
    const decoded = decodeInput(encodeKeysInput(current), 10, 0);
    assert.equal(decoded.kind, 'keys');
    if (decoded.kind === 'keys') reports.push(decoded.states.map(Number));
  });
  return { states, reports, input };
}

test('keyboard button holds emit one raw down/up pair and ignore repeated presses', () => {
  const { input, reports } = fixture();
  input.press(2);
  input.press(2);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]![2], 1);
  input.release(2);
  input.release(2);
  assert.equal(reports.length, 2);
  assert.equal(reports[1]![2], 0);
  assert.ok(isButtonActivationKey('Enter'));
  assert.ok(isButtonActivationKey(' '));
  assert.equal(isButtonActivationKey('ArrowDown'), false);
});

test('Neo assistive touchpoint activation emits a short pair and preserves other held inputs', () => {
  const { states, input, reports } = fixture();
  states[0] = true; // Existing pointer press belongs to the pointer handlers.
  input.activate(9);
  assert.equal(reports.length, 2);
  assert.deepEqual(reports.map((report) => [report[0], report[9]]), [[1, 1], [1, 0]]);
  input.activate(0);
  assert.equal(reports.length, 2, 'an assistive click never releases a pointer-owned hold');
});

test('lost keyboard focus releases its presses without releasing pointer-owned keys', () => {
  const { states, input, reports } = fixture();
  states[1] = true;
  input.press(0);
  input.press(8);
  input.releaseAll();
  assert.deepEqual(states.slice(0, 2), [false, true]);
  assert.equal(states[8], false);
  assert.equal(reports.length, 3);
  input.releaseAll();
  input.release(8);
  assert.equal(reports.length, 3, 'late keyups after blur do not create extra reports');
});
