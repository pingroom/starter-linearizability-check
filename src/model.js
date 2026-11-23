import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}



const safeId = value => word(value) && value.length <= 12 && !['constructor', 'prototype', '__proto__', 'unknown'].includes(value);
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const scalar = value => value === null || typeof value === 'boolean'
  || typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)
  || typeof value === 'string' && value.length <= 40 && value.isWellFormed() && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
const scalarKey = value => JSON.stringify([value === null ? 'null' : typeof value, value]);
const position = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000 && !Object.is(value, -0);
export const POLICY = Object.freeze({ name: 'completed-register-linearizability-v1',
  model: 'one atomic read/write register; zero to eight completed successful operations and a documented initial scalar value',
  precedence: 'operation A must precede B when A.response < B.invoke; all invocation/response positions are globally unique',
  semantics: 'a write sets the register; a read must return its current value with type-sensitive equality',
  search: 'depth-first search in ascending ASCII operation ID order; memoize failed (completed-set, register-value) states',
  witness: 'the lexicographically first legal operation-ID order, or null when exhaustive finite search finds none',
  selection: 'one owner identifies the documented initial value; Unknown withholds analysis, including an empty history',
  excluded: 'pending or failed calls, multiple objects, compare-and-swap, clock uncertainty, missing events, live changes and implementation-wide guarantees' });
export const POLICY_HASH = hash(POLICY);
const promptFor = input => `${input.title}\n${input.context}\nWhich documented initial register value applies before ${input.historyId}?\n${input.initialPresets.map(p => `${p.label}: ${p.value === null ? 'null' : typeof p.value} ${JSON.stringify(p.value)}; ${p.reference}`).join('\n')}\nChoose Unknown if unverified. Operation values remain local.`;
export function validateInput(input) {
  if (!keys(input, ['historyId', 'title', 'context', 'operations', 'initialPresets']) || !word(input.historyId)
    || !line(input.title, 40) || !line(input.context, 80) || !Array.isArray(input.operations) || input.operations.length > 8
    || !Array.isArray(input.initialPresets) || input.initialPresets.length < 1 || input.initialPresets.length > 3) throw new Error('Supply history metadata, zero to eight completed operations and one to three documented initial-value presets.');
  const ids = new Set(), positions = new Set();
  const operations = Array.from(input.operations, operation => {
    if (!keys(operation, ['id', 'kind', 'invoke', 'response', 'value']) || !safeId(operation.id) || ids.has(operation.id)
      || !['read', 'write'].includes(operation.kind) || !position(operation.invoke) || !position(operation.response)
      || operation.invoke >= operation.response || positions.has(operation.invoke) || positions.has(operation.response) || !scalar(operation.value)) throw new Error('Operations need unique safe IDs, read/write kind, globally unique ordered event positions from 0 to 1000000 and a supported scalar value.');
    ids.add(operation.id); positions.add(operation.invoke); positions.add(operation.response); return { ...operation };
  }).sort((a, b) => order(a.id, b.id));
  const presetIds = new Set(), labels = new Set(), values = new Set();
  const initialPresets = Array.from(input.initialPresets, preset => {
    if (!keys(preset, ['id', 'label', 'reference', 'value']) || !safeId(preset.id) || presetIds.has(preset.id)
      || !line(preset.label, 24) || labels.has(preset.label) || preset.label.toLowerCase() === 'unknown' || !line(preset.reference, 40)
      || !scalar(preset.value) || values.has(scalarKey(preset.value))) throw new Error('Initial presets need unique IDs, labels and typed scalar values, plus a reference.');
    presetIds.add(preset.id); labels.add(preset.label); values.add(scalarKey(preset.value)); return { ...preset };
  }).sort((a, b) => order(a.id, b.id));
  const result = { historyId: input.historyId, title: input.title, context: input.context, operations, initialPresets };
  if (promptFor(result).length > 500) throw new Error('Initial-value Question exceeds 500 UTF-16 units; shorten metadata or preset descriptions.');
  return result;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact history owner UUID and label.');
  return structuredClone(config);
}
export const itemsFor = input => { validateInput(input); return [{ id: 'initial' }]; };
export function requestFor(rawInput, config, itemId, attemptId) {
  const input = validateInput(rawInput); validateConfig(config);
  if (itemId !== 'initial' || !isId(attemptId)) throw new Error('Invalid initial-value selection or attempt.');
  const key = `linear-${attemptId}`;
  return { prompt: promptFor(input), context: `To ${config.participant.id}`,
    options: [...input.initialPresets.map(preset => ({ value: preset.id, label: preset.label, style: 'default' })), { value: 'unknown', label: 'Unknown', style: 'default' }],
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), operations_hash: hash(input.operations), policy_hash: POLICY_HASH, item_id: itemId, attempt_id: attemptId }, idempotencyKey: key };
}
export function previewInput(rawInput, config) {
  const input = validateInput(rawInput), request = requestFor(input, config, 'initial', '01990000-0000-7000-8000-000000000001');
  const { correlation_id, idempotencyKey, data, ...question } = request;
  return { source: input, sourceHash: hash(input), policy: POLICY, policyHash: POLICY_HASH, question,
    note: 'The attempt UUID, correlation ID and input/operations/policy hashes are added when the session creates its Question.' };
}

/** Pure bounded check. Export additionally requires an attributed initial-value selection. */
export function checkHistory(rawInput, presetId) {
  const input = validateInput(rawInput), preset = input.initialPresets.find(item => item.id === presetId);
  if (!preset) throw new Error('Select a declared initial-value preset before checking.');
  const operations = input.operations, fullMask = (1 << operations.length) - 1;
  const predecessors = operations.map(operation => operations.reduce((mask, previous, index) => previous.response < operation.invoke ? mask | (1 << index) : mask, 0));
  const realTimePrecedence = operations.flatMap((operation, index) => operations.filter((_, other) => predecessors[index] & (1 << other)).map(previous => ({ before: previous.id, after: operation.id })));
  const failed = new Set();
  const search = { visitedStates: 0, attemptedTransitions: 0, readMismatches: 0, memoHits: 0, deadEndStates: 0, exhausted: false };
  function visit(mask, value) {
    const key = `${mask}:${scalarKey(value)}`;
    if (failed.has(key)) { search.memoHits++; return null; }
    search.visitedStates++;
    if (mask === fullMask) return [];
    for (let index = 0; index < operations.length; index++) {
      const bit = 1 << index, operation = operations[index];
      if (mask & bit || (mask & predecessors[index]) !== predecessors[index]) continue;
      search.attemptedTransitions++;
      if (operation.kind === 'read' && !Object.is(value, operation.value)) { search.readMismatches++; continue; }
      const after = operation.kind === 'write' ? operation.value : value;
      const suffix = visit(mask | bit, after);
      if (suffix !== null) return [{ operationId: operation.id, kind: operation.kind, value: operation.value, before: value, after }, ...suffix];
    }
    failed.add(key); search.deadEndStates++; return null;
  }
  const witness = visit(0, preset.value), linearizable = witness !== null;
  search.exhausted = !linearizable;
  const possibleValues = new Set([scalarKey(preset.value), ...operations.filter(operation => operation.kind === 'write').map(operation => scalarKey(operation.value))]);
  return { preset, initialValue: preset.value, operationCount: operations.length, linearizable,
    witnessOperationIds: witness === null ? null : witness.map(step => step.operationId), witness,
    finalValue: witness === null ? null : (witness.length === 0 ? preset.value : witness.at(-1).after),
    realTimePrecedence, search: { ...search, stateBound: (fullMask + 1) * possibleValues.size },
    sourceHash: hash(input), policyHash: POLICY_HASH, externalActionsPerformed: false,
    note: 'Exact result for this completed single-register history and selected initial value only; incomplete capture or uncertain endpoint order invalidates the model.' };
}
export function historyPlan(rawInput, choice) {
  const input = validateInput(rawInput);
  if (choice !== null && choice !== 'unknown' && !input.initialPresets.some(preset => preset.id === choice)) throw new Error('Supply a declared initial preset, Unknown or a missing selection.');
  return { status: choice === null ? 'incomplete' : choice === 'unknown' ? 'unknown' : 'complete', analysis: choice === null || choice === 'unknown' ? null : checkHistory(input, choice) };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > itemsFor(input).length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed register history. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = itemsFor(input), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved initial-value selection or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last confirmation may have an active Question.');
  }
  return state;
}




export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const attempt = state.attempts[0], answer = attempt?.observation?.answer;
  const answers = [{ itemId: 'initial', status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
    choice: answer?.value ?? null, label: answer?.label ?? null, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
    responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null, askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null }];
  const calculation = historyPlan(input, answers[0].choice);
  const status = ['create_unknown', 'pending'].includes(answers[0].status) ? answers[0].status : answers[0].status === 'unasked' ? 'ready' : calculation.status;
  return { version: 1, historyId: input.historyId, sourceHash: hash(input), source: input, policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, configHash: hash(state.config), answers, ...calculation, status };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved initial-value selection evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered initial-value selections must not contain initial-value selection evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || (q.is_handoff !== undefined && q.is_handoff !== false)
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || (q.results !== undefined && q.results !== null) || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || Array.from(q.options).some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || (option?.primary !== undefined && option.primary !== false) || (option?.destructive !== undefined && option.destructive !== false))) throw new Error('Question does not match the saved configuration, room, or reviewer.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
