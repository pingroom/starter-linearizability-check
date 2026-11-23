import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkHistory, validateInput, historyPlan, previewInput, requestFor, hash, POLICY_HASH } from '../src/model.js';
import { CONFIG, PARTICIPANT, id } from '../src/mock.js';
const example = JSON.parse(await readFile(new URL('../examples/history.json', import.meta.url), 'utf8'));
const op = (id, kind, invoke, response, value) => ({ id, kind, invoke, response, value });
const inputFor = (operations, value = 0) => ({ historyId: 'fixture', title: 'Fixture', context: 'Use the reset record.', operations,
  initialPresets: [{ id: 'initial', label: 'Initial value', reference: 'reset record', value }] });
const check = (operations, value = 0) => checkHistory(inputFor(operations, value), 'initial');
const permutations = array => array.length === 0 ? [[]] : array.flatMap((item, index) => permutations(array.filter((_, other) => other !== index)).map(rest => [item, ...rest]));
// Independent oracle enumerates every total order, then separately checks all real-time pairs and replays it.
function oracle(input) {
  const valid = permutations(input.operations).filter(sequence => {
    for (let a = 0; a < sequence.length; a++) for (let b = a + 1; b < sequence.length; b++) if (sequence[b].response < sequence[a].invoke) return false;
    let current = input.initialPresets[0].value;
    for (const operation of sequence) {
      if (operation.kind === 'write') current = operation.value;
      else if (!Object.is(current, operation.value)) return false;
    }
    return true;
  });
  valid.sort((a, b) => a.map(x => x.id).join(',') < b.map(x => x.id).join(',') ? -1 : 1);
  return valid[0]?.map(operation => operation.id) ?? null;
}
function verifyWitness(input, result) {
  assert.ok(result.search.visitedStates <= result.search.stateBound);
  assert.equal(result.sourceHash, hash(validateInput(input))); assert.equal(result.policyHash, POLICY_HASH);
  if (!result.linearizable) { assert.equal(result.witness, null); assert.equal(result.witnessOperationIds, null); assert.equal(result.finalValue, null); assert.equal(result.search.exhausted, true); return; }
  assert.equal(result.witness.length, input.operations.length);
  assert.equal(new Set(result.witnessOperationIds).size, input.operations.length);
  let value = result.initialValue;
  for (const step of result.witness) {
    const source = input.operations.find(operation => operation.id === step.operationId);
    assert.equal(step.kind, source.kind); assert.equal(step.value, source.value); assert.equal(step.before, value);
    if (source.kind === 'read') assert.equal(source.value, value); else value = source.value;
    assert.equal(step.after, value);
  }
  assert.equal(result.finalValue, value);
  for (const a of input.operations) for (const b of input.operations) if (a.response < b.invoke) assert.ok(result.witnessOperationIds.indexOf(a.id) < result.witnessOperationIds.indexOf(b.id));
}

test('concurrent calls can linearize in a different order from invocation or response order', () => {
  const input = inputFor([op('a-read', 'read', 0, 3, 1), op('b-write', 'write', 1, 2, 1)]);
  const result = checkHistory(input, 'initial'); assert.equal(result.linearizable, true);
  assert.deepEqual(result.witnessOperationIds, ['b-write', 'a-read']); verifyWitness(input, result);
});
test('a stale read after a completed write cannot move before it', () => {
  const result = check([op('a-read', 'read', 2, 3, 0), op('b-write', 'write', 0, 1, 1)]);
  assert.equal(result.linearizable, false); assert.equal(result.search.exhausted, true);
  assert.deepEqual(result.realTimePrecedence, [{ before: 'b-write', after: 'a-read' }]);
  const overlap = check([op('a-read', 'read', 1, 3, 0), op('b-write', 'write', 0, 2, 1)]);
  assert.equal(overlap.linearizable, true); assert.deepEqual(overlap.witnessOperationIds, ['a-read', 'b-write']);
});
test('every scalar type remains distinct and writing null preserves a null final register', () => {
  for (const a of [null, false, true, 0, 1, '', '0', 'true', 'null', ' ']) for (const b of [null, false, true, 0, 1, '', '0', 'true', 'null', ' ']) {
    assert.equal(check([op('read', 'read', 0, 1, b)], a).linearizable, Object.is(a, b));
  }
  assert.equal(check([op('write', 'write', 0, 1, null)], 9).finalValue, null);
  assert.equal(check([op('write', 'write', 0, 1, false)], true).finalValue, false);
  assert.equal(check([op('write', 'write', 0, 1, '')], 'old').finalValue, '');
});
test('zero completed operations is valid but the CLI still needs a known initial value', () => {
  const input = inputFor([], null), result = checkHistory(input, 'initial');
  assert.equal(result.linearizable, true); assert.deepEqual(result.witness, []); assert.equal(result.finalValue, null);
  assert.equal(historyPlan(input, 'unknown').analysis, null); assert.equal(historyPlan(input, null).status, 'incomplete');
  assert.throws(() => checkHistory(input, 'unknown')); verifyWitness(input, result);
});
test('eight operations, extreme integer values and event bounds are supported', () => {
  const values = [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, null, false, true, '', 'a'.repeat(40), 0];
  const operations = values.map((value, index) => op(`op-${index}`, 'write', index, 1000000-index, value));
  const input = inputFor(operations), result = checkHistory(input, 'initial');
  assert.deepEqual(result.witnessOperationIds, operations.map(operation => operation.id)); verifyWitness(input, result);
  operations[7] = op('op-7', 'read', 7, 999993, 'absent');
  assert.equal(checkHistory(inputFor(operations), 'initial').linearizable, false);
});
test('canonical reorderings preserve hashes, prompts and the first witness', () => {
  const input = structuredClone(example), reverse = structuredClone(example); reverse.operations.reverse(); reverse.initialPresets.reverse();
  assert.deepEqual(validateInput(input), validateInput(reverse));
  assert.deepEqual(checkHistory(input, 'zero'), checkHistory(reverse, 'zero'));
  assert.deepEqual(requestFor(input, CONFIG, 'initial', id(1)), requestFor(reverse, CONFIG, 'initial', id(1)));
});
test('Question shows typed values and references while keeping operation values local', () => {
  const input = inputFor([op('read', 'read', 0, 1, 'PRIVATE_READ_VALUE')], '0');
  input.initialPresets.push({ id: 'numeric', label: 'Number zero', reference: 'numeric reset', value: 0 });
  const preview = previewInput(input, CONFIG), request = requestFor(input, CONFIG, 'initial', id(1));
  assert.match(preview.question.prompt, /string "0"; reset record/); assert.match(preview.question.prompt, /number 0; numeric reset/);
  assert.ok(!JSON.stringify(request).includes('PRIVATE_READ_VALUE')); assert.equal(request.target_user_id, PARTICIPANT);
  assert.equal(request.data.operations_hash, hash(validateInput(input).operations)); assert.equal(request.data.policy_hash, POLICY_HASH);
  assert.equal(request.options.at(-1).value, 'unknown'); assert.ok(request.prompt.length <= 500);
});
test('malformed histories, duplicate positions, unsupported scalars and ambiguous presets fail closed', () => {
  const mutations = [
    i => { i.extra = true; }, i => { i.historyId = 'bad\n'; }, i => { i.operations = Array(9).fill(i.operations[0]); }, i => { i.operations = Array(1); },
    i => { i.operations[0].kind = 'cas'; }, i => { i.operations[0].extra = null; }, i => { i.operations[0].id = 'unknown'; }, i => { i.operations[0].id = 'constructor'; },
    i => { i.operations[0].id += '\n'; }, i => { i.operations[1].id = i.operations[0].id; }, i => { i.operations[0].invoke = -1; }, i => { i.operations[0].invoke = -0; },
    i => { i.operations[0].invoke = 1.1; }, i => { i.operations[0].response = i.operations[0].invoke; }, i => { i.operations[0].response = 1000001; },
    i => { i.operations[1].invoke = i.operations[0].response; }, i => { i.operations[1].response = i.operations[0].response; },
    ...[{}, [], undefined, -0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER+1, 'x'.repeat(41), '\ud800', '\n', '\u202e'].map(value => i => { i.operations[0].value = value; }),
    i => { i.initialPresets = []; }, i => { i.initialPresets = Array(1); }, i => { i.initialPresets.push(...i.initialPresets); },
    i => { i.initialPresets[1].id = i.initialPresets[0].id; }, i => { i.initialPresets[1].label = i.initialPresets[0].label; },
    i => { i.initialPresets[1].value = i.initialPresets[0].value; }, i => { i.initialPresets[0].label = 'UNKNOWN'; }, i => { i.initialPresets[0].reference = ''; },
    i => { i.initialPresets[0].value = -0; }, i => { i.title = ' '; }, i => { i.context = 'x'.repeat(81); },
  ];
  for (const mutate of mutations) { const input = structuredClone(example); mutate(input); assert.throws(() => validateInput(input)); }
  const input = inputFor([], 0); input.title='x'.repeat(40); input.context='x'.repeat(80); input.historyId='x'.repeat(40);
  input.initialPresets = [0,1,2].map(n=>({id:`p${n}`,label:`${n}${'x'.repeat(23)}`,reference:'x'.repeat(40),value:'"'.repeat(40-n)}));
  assert.throws(() => validateInput(input), /500/);
});
test('full-permutation oracle checks every three-call endpoint order and binary read/write assignment', () => {
  const ids = ['a', 'b', 'c'], endpointPermutations = permutations([0,1,2,3,4,5]);
  let count = 0;
  for (const endpoints of endpointPermutations) {
    if (ids.some((_, index) => endpoints[2*index] >= endpoints[2*index+1])) continue;
    for (let choices = 0; choices < 64; choices++) for (const initial of [0,1]) {
      const operations = ids.map((name, index) => { const digit=(choices >> (2*index)) & 3; return op(name, digit & 2 ? 'write':'read', endpoints[2*index], endpoints[2*index+1], digit & 1); });
      const input = inputFor(operations, initial), result = checkHistory(input, 'initial'), expected = oracle(input);
      assert.deepEqual(result.witnessOperationIds, expected); assert.equal(result.linearizable, expected !== null); verifyWitness(input, result); count++;
    }
  }
  assert.equal(count, 11520);
});
test('independent oracle checks larger generated histories and multitype values', () => {
  let seed = 23923; const random = n => { seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed % n; };
  const values = [0, 1, false, true, null, '0'];
  for (let run = 0; run < 120; run++) {
    const n = 4 + run % 3, endpoints = Array.from({length:2*n},(_,i)=>i);
    for (let i=endpoints.length-1;i>0;i--) { const j=random(i+1); [endpoints[i],endpoints[j]]=[endpoints[j],endpoints[i]]; }
    const operations=Array.from({length:n},(_,i)=>op(`op-${i}`,random(2)?'write':'read',Math.min(endpoints[2*i],endpoints[2*i+1]),Math.max(endpoints[2*i],endpoints[2*i+1]),values[random(values.length)]));
    const input=inputFor(operations,values[random(values.length)]),result=checkHistory(input,'initial');
    assert.deepEqual(result.witnessOperationIds,oracle(input));verifyWitness(input,result);
  }
});
