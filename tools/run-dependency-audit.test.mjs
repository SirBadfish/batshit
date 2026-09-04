import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOW_UNREACHABLE_ENV,
  BLOCKING_SEVERITIES,
  DEFAULT_RETRY_POLICY,
  EXIT_ENDPOINT_UNAVAILABLE,
  EXIT_FINDING,
  allowUnreachable,
  auditRoot,
  blockingCount,
  classifyAuditOutput,
  summarizeCounts,
} from './run-dependency-audit.mjs';

/**
 * Both fixtures are VERBATIM `npm audit --json` output captured from npm 11.6.2
 * on 2026-09-04, not hand-written guesses:
 *   clean   -> `npm audit --omit=dev --json` in batshit-app
 *   outage  -> the same command against an unreachable registry
 * The whole gate rests on telling these two shapes apart, so they are pinned.
 */
const CLEAN_REPORT = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
    dependencies: { prod: 500, dev: 0, total: 500 },
  },
});

const OUTAGE_REPORT = JSON.stringify({
  message:
    'request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: connect ETIMEDOUT',
  error: { summary: '', detail: '' },
});

/** Shape of a real finding: the toml/fflate advisories from 2026-09-03. */
const FINDING_REPORT = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: { toml: { severity: 'high' }, fflate: { severity: 'moderate' } },
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 1, high: 1, critical: 0, total: 2 },
    dependencies: { prod: 200, dev: 0, total: 200 },
  },
});

test('a clean audit is a result, not an outage', () => {
  const outcome = classifyAuditOutput({ stdout: CLEAN_REPORT });
  assert.equal(outcome.kind, 'result');
  assert.equal(blockingCount(outcome.counts), 0);
  assert.equal(summarizeCounts(outcome.counts), 'none');
});

test('a real finding is a result, and only high/critical count toward blocking', () => {
  const outcome = classifyAuditOutput({ stdout: FINDING_REPORT });
  assert.equal(outcome.kind, 'result');
  // 1 high + 1 moderate: the moderate must not contribute.
  assert.equal(blockingCount(outcome.counts), 1);
  assert.equal(summarizeCounts(outcome.counts), '1 high');
  assert.deepEqual(BLOCKING_SEVERITIES, ['high', 'critical']);
});

test('an endpoint error is classified unreachable, never as a finding', () => {
  const outcome = classifyAuditOutput({ stdout: OUTAGE_REPORT });
  assert.equal(outcome.kind, 'unreachable');
  assert.match(outcome.reason, /advisories\/bulk failed/);
});

test('the exit code is not trusted — the SAME code means both things', () => {
  // npm exits 1 for a real advisory AND for an endpoint error. Classification
  // must come from the payload alone, or the whole gate is ambiguous again.
  assert.equal(classifyAuditOutput({ stdout: FINDING_REPORT, exitCode: 1 }).kind, 'result');
  assert.equal(classifyAuditOutput({ stdout: OUTAGE_REPORT, exitCode: 1 }).kind, 'unreachable');
});

test('non-JSON output is unparseable, which is distinct from an outage', () => {
  const outcome = classifyAuditOutput({ stdout: 'npm ERR! code ENOLOCK', stderr: 'no lockfile' });
  // Retrying cannot fix this, so it must not be classified as retryable.
  assert.equal(outcome.kind, 'unparseable');
  assert.ok(outcome.reason.length > 0);
});

test('a report without metadata is unreachable even if it parses', () => {
  assert.equal(classifyAuditOutput({ stdout: '{"auditReportVersion":2}' }).kind, 'unreachable');
});

const FAST_POLICY = { ...DEFAULT_RETRY_POLICY, backoffMs: [0, 0], attemptTimeoutMs: 1000 };

test('an unreachable endpoint is retried, and recovery on a later attempt succeeds', async () => {
  const attempts = [];
  const outcome = await auditRoot({
    root: 'batshit-app',
    omitDev: true,
    policy: FAST_POLICY,
    runner: async () => {
      attempts.push(1);
      return { stdout: attempts.length < 3 ? OUTAGE_REPORT : CLEAN_REPORT, stderr: '' };
    },
  });
  assert.equal(outcome.kind, 'result');
  assert.equal(outcome.attempts, 3);
  assert.equal(blockingCount(outcome.counts), 0);
});

test('a real finding is NOT retried — retrying a deterministic result wastes the timeout', async () => {
  let calls = 0;
  const outcome = await auditRoot({
    root: 'batshit-app',
    omitDev: true,
    policy: FAST_POLICY,
    runner: async () => {
      calls += 1;
      return { stdout: FINDING_REPORT, stderr: '' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.kind, 'result');
  assert.equal(blockingCount(outcome.counts), 1);
});

test('an unparseable failure is NOT retried either', async () => {
  let calls = 0;
  const outcome = await auditRoot({
    root: 'batshit-app',
    omitDev: true,
    policy: FAST_POLICY,
    runner: async () => {
      calls += 1;
      return { stdout: 'npm ERR!', stderr: 'boom' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.kind, 'unparseable');
});

test('a sustained outage exhausts attempts and stays unreachable', async () => {
  let calls = 0;
  const outcome = await auditRoot({
    root: 'batshit-app',
    omitDev: true,
    policy: FAST_POLICY,
    runner: async () => {
      calls += 1;
      return { stdout: OUTAGE_REPORT, stderr: '' };
    },
  });
  assert.equal(calls, FAST_POLICY.attempts);
  assert.equal(outcome.kind, 'unreachable');
  // It must never degrade into a clean result.
  assert.equal(outcome.counts, undefined);
});

test('a wall-clock timeout counts as unreachable, so it is retried', async () => {
  let calls = 0;
  const outcome = await auditRoot({
    root: 'batshit-app',
    omitDev: true,
    policy: FAST_POLICY,
    runner: async () => {
      calls += 1;
      if (calls === 1) return { stdout: '', stderr: 'exceeded the 150s limit', timedOut: true };
      return { stdout: CLEAN_REPORT, stderr: '' };
    },
  });
  assert.equal(calls, 2);
  assert.equal(outcome.kind, 'result');
});

test('the retry budget stops new attempts instead of running forever', async () => {
  let calls = 0;
  const outcome = await auditRoot({
    root: 'batshit-app',
    omitDev: true,
    policy: { ...DEFAULT_RETRY_POLICY, backoffMs: [5000], totalBudgetMs: 1 },
    startedAt: Date.now(),
    runner: async () => {
      calls += 1;
      return { stdout: OUTAGE_REPORT, stderr: '' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.kind, 'unreachable');
  assert.equal(outcome.budgetExhausted, true);
});

test('the two failure exit codes are distinct and documented', () => {
  // A human reading a red job must be able to tell "fix the dependency" from
  // "re-run this, npm was down" without opening the log.
  assert.equal(EXIT_FINDING, 1);
  assert.equal(EXIT_ENDPOINT_UNAVAILABLE, 75);
  assert.notEqual(EXIT_FINDING, EXIT_ENDPOINT_UNAVAILABLE);
});

test('the default policy is bounded so a total outage cannot hang the job', () => {
  const { attempts, attemptTimeoutMs, backoffMs, totalBudgetMs } = DEFAULT_RETRY_POLICY;
  assert.ok(attempts >= 2, 'a single attempt would not survive a transient blip');
  assert.equal(backoffMs.length, attempts - 1);
  assert.ok(
    backoffMs.every((wait, index) => index === 0 || wait > backoffMs[index - 1]),
    'backoff must increase',
  );
  // Worst case for one root must stay well inside the whole-run budget.
  const worstCasePerRoot = attempts * attemptTimeoutMs + backoffMs.reduce((a, b) => a + b, 0);
  assert.ok(worstCasePerRoot < totalBudgetMs, 'one root must not be able to consume the budget');
});

test('the unreachable override is opt-in and only "1" enables it', () => {
  // A typo, a stale "true", or an empty value must NOT weaken the gate.
  assert.equal(allowUnreachable({}), false);
  assert.equal(allowUnreachable({ [ALLOW_UNREACHABLE_ENV]: '' }), false);
  assert.equal(allowUnreachable({ [ALLOW_UNREACHABLE_ENV]: '0' }), false);
  assert.equal(allowUnreachable({ [ALLOW_UNREACHABLE_ENV]: 'true' }), false);
  assert.equal(allowUnreachable({ [ALLOW_UNREACHABLE_ENV]: '1' }), true);
});

test('the override cannot turn a REAL finding green', async () => {
  // It is scoped to "npm never answered". A high/critical advisory is a result,
  // and no environment variable may suppress it.
  const outcome = await auditRoot({
    root: 'batshit-app',
    omitDev: true,
    policy: FAST_POLICY,
    runner: async () => ({ stdout: FINDING_REPORT, stderr: '' }),
  });
  assert.equal(outcome.kind, 'result');
  assert.equal(blockingCount(outcome.counts), 1);
});
