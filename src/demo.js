import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, exportAnalysis } from './engine.js';
import { readJson } from './storage.js';
import { mockApi, CONFIG, ROOM_CODE, id } from './mock.js';
const example = await readJson(new URL('../examples/history.json', import.meta.url), 65536);
for (const scenario of [
  { name: 'concurrent read sees the write', choice: 'zero', input: example, expected: true },
  { name: 'earlier read contradicts initial value', choice: 'one', input: example, expected: false },
  { name: 'empty completed history', choice: 'zero', input: { ...example, operations: [] }, expected: true },
  { name: 'initial value unverified', choice: 'unknown', input: example, expected: null },
]) {
  const directory = await mkdtemp(join(tmpdir(), 'linearizability-demo-'));
  try {
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input: scenario.input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    assert.equal((await step(options)).status, 'pending');
    api.answer(id(1), scenario.choice); const result = await step(options);
    if (scenario.expected === null) { assert.equal(result.analysis, null); await assert.rejects(exportAnalysis(directory, scenario.input)); }
    else { const exported = await exportAnalysis(directory, scenario.input); assert.equal(exported.analysis.linearizable, scenario.expected); }
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 1);
    console.log(JSON.stringify({ scenario: scenario.name, choice: scenario.choice, status: result.status, analysis: result.analysis }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
