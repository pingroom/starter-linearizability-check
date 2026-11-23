# Register linearizability check with PingRoom

Check whether a captured concurrent register history has a legal sequential explanation. The history owner identifies the documented initial value through PingRoom; code searches operation orders and exports a replay witness or a result showing that no legal order exists for the supplied history.

Use this with a small retained read/write trace from a test harness. The starter writes local JSON only. It never contacts the register, repeats operations or changes a deployment.

## Try it offline

Choose **Use this template**, clone your copy, and use Node.js 22 or newer:

```sh
npm ci
npm test
npm run demo
```

The demo covers a concurrent read that sees a write, an incompatible initial value, an empty history and Unknown. Tests and demos use published `@pingroom/sdk` 0.8.0 through local mock transports. After installation they need no credentials or network and send no live pings. Dependencies are pinned in the lockfile; `.npmrc` requests a 14-day release age where supported by npm.

## Prepare a completed history

```sh
cp examples/history.json history.json
cp config.example.json config.json
npm run preview
```

Map your retained trace into `history.json`:

| Field | Contract |
| --- | --- |
| `historyId` | 1–40 characters: lowercase letter first, then lowercase letters, digits, `_` or `-`. |
| `title`, `context` | Nonempty, trimmed single lines, at most 40 and 80 UTF-16 code units. Identify the capture and its reset evidence. |
| `operations` | Zero to eight `{id, kind, invoke, response, value}` entries. `kind` is `read` or `write`. |
| `invoke`, `response` | Integer positions from 0 to 1,000,000 in one known event order, with `invoke < response`. All positions across all calls must be unique. |
| `value` | Observed return value for a read; assigned value for a successful write. Supported scalars: safe integer, boolean, `null`, or well-formed single-line string of at most 40 UTF-16 units. Negative zero is rejected. Empty strings and ordinary spaces are valid values. |
| `initialPresets` | One to three `{id, label, reference, value}` entries from documented possible initial states. Values use the same scalar contract. |
| Operation/preset `id` | Unique within its list, at most 12 characters using the `historyId` alphabet. `unknown`, `constructor`, `prototype` and `__proto__` are reserved. |
| Preset `label`, `reference` | Nonempty trimmed single lines, at most 24 and 40 UTF-16 units. Labels are unique and cannot be `Unknown`, ignoring case. |

Preset IDs and typed values must be unique. Number `0`, string `"0"`, boolean `false` and `null` are different values. Operations and presets are sorted by ID, preserving equivalent input reorderings. Extra fields, sparse arrays, malformed Unicode and control/format characters are rejected. Input is limited to 64 KiB; the full Question must fit 500 UTF-16 units. `preview` validates these limits without a connection.

Use an event order your harness can establish. Do not invent an ordering for equal or uncertain wall-clock timestamps. Include every relevant operation since the documented initial state. All calls must have completed successfully against **one read/write register**; the checker tests whether their behavior matches an atomic register. A write's return is assumed to be a success acknowledgement. Pending calls, timeouts, failed writes, compare-and-swap, multiple keys and missing events need another model. The checker cannot verify capture completeness or the owner's evidence.

## Connect and identify the initial value

Install [PingRoom](https://pingroom.io/i), then:

```sh
npm run connect
npm run inspect
```

Approve pairing and grant a standard private room containing the history owner, with room-list and Question create/read permissions. Verify the person in the app and enter their exact member UUID and a descriptive label in `config.json`. Names alone do not establish identity.

For an existing granted connection, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM`. Blank or partial pairs are rejected; credential sources cannot be mixed.

```sh
npm run preview
npm start
# After the owner answers:
npm start
npm run export
```

Each run creates at most one direct, 15-minute Question or reads the original Question once. It asks which documented value applied before the history, displaying each label, JSON value, type and evidence reference. The owner selects a preset or **Unknown**. Even an empty history requires this declaration before export.

PingRoom receives the history ID, title/context, preset labels/references/typed values, owner UUID and input/operations/policy hashes. Individual operation IDs, intervals and values remain local. Unknown, missing, expired, cancelled, invalid or misattributed answers block export. There is no background polling or automatic replacement Question.

## Read the result

```sh
npm run status
npm run report
npm run export
```

These commands are local and need no credentials. `report` writes `.linearizability/report.json`, including incomplete answer evidence. A completed `export` writes private `.linearizability/check.json`, containing the canonical source, attributed owner declaration and analysis. Repeating an export produces identical bytes. A refused export preserves any older output; consume a file only after successful export for the expected source and policy hashes.

`linearizable: true` means at least one operation order satisfies both rules:

1. If A's response precedes B's invocation, A precedes B in the witness.
2. A write replaces the register value; a read returns exactly its current typed value.

`witnessOperationIds` gives the lexicographically first valid order by ASCII ID. `witness` adds the operation kind, observed/written value and register value before and after each step. `finalValue` is the last register state. The empty history has an empty witness and retains the initial value.

`linearizable: false` means exhaustive search found no legal order for this snapshot and initial value. Both witness fields and `finalValue` are null; `search.exhausted` is true. A legitimate null final register value is distinguished by `linearizable: true`. Negative results are complete diagnostics and export normally.

Code explores eligible operations in ID order and memoizes failed states by completed-operation set and typed register value. Future possibilities depend only on those two values. With eight calls, at most 256 subsets and nine register values are possible. `search` reports visited states, attempted transitions, read mismatches, memo hits, dead ends and the state bound. These are search diagnostics, not counts of every legal order. `realTimePrecedence` lists all required before/after pairs.

This specializes the sequential-explanation condition described by [Herlihy and Wing](https://www.cs.columbia.edu/~wing/publications/HerlihyWing90.pdf) to completed single-register calls. A positive result covers this captured history only; it does not certify an implementation, other executions or future behavior.

## Adapt and resume

Write a harness adapter that preserves exact completed call intervals and typed values, plus reset/restore references. Call `checkHistory(rawInput, presetId)` in `src/model.js` for the pure calculation; CLI export also requires the attributed owner declaration. Consume the exported witness in your test report. No deployment or external-action adapter is included.

Real input, configuration, credentials, state and outputs are ignored by Git. Keep `.linearizability/` and `.pingroom/` private on persistent storage. Writes are atomic under a local lock; changed input, owner, room or credentials cannot reuse a session.

A lost creation response leaves `create_unknown` and never triggers an automatic resend:

```sh
npm run status
npm run find-id
npm run recover -- EXACT-QUESTION-UUID
```

Recover only the original Question. An empty bounded search does not prove creation failed. Resolve or revoke uncertain/expired pairing in Connected Agents before archiving its pending record. Remove a stale `.lock` only after confirming its process stopped. Keep the original input and session while resolving uncertainty.

Run commands serially. Exit codes: `0` complete/local result, including a negative check; `1` invalid setup/evidence or refused export; `2` incomplete/Unknown/failed answer; `3` ready/pending/interrupted; `4` uncertain creation. Local status/report return 0 even for incomplete states; inspect their JSON status.

Tests compare results with independent full-permutation enumeration across 11,520 exhaustive three-call histories and 120 larger histories, plus type equality, boundary inputs, provenance, recovery, pairing and real CLI subprocesses. GitHub Actions checks Node.js 22 and 24. Live phone delivery is not tested. MIT licensed.
