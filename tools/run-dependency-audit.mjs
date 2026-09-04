#!/usr/bin/env node
/**
 * Dependency audit runner for the public CI Guardrails job.
 *
 * WHY THIS EXISTS
 * ---------------
 * `npm audit` exits non-zero for two completely different situations:
 *
 *   1. it found a high/critical advisory  -> a real security finding
 *   2. npm's advisory endpoint errored    -> we learned nothing
 *
 * The old inline shell step could not tell them apart, so on 2026-09-03/04 an
 * npm-side outage (`POST /-/npm/v1/security/advisories/bulk` returning 503 and
 * network timeouts for ~4 hours) turned the gate red on every pull request and
 * on main. Each failing root also burned npm's default 5-minute `fetch-timeout`
 * (verified: `npm config get fetch-timeout` -> 300000), so a single run could
 * waste ~25 minutes before failing on a randomly different root each time.
 *
 * HOW THE TWO CASES ARE TOLD APART
 * --------------------------------
 * Verified against real `npm audit --json` output on npm 11.6.2:
 *
 *   real result -> { auditReportVersion, metadata: { vulnerabilities: {...} }, vulnerabilities }
 *   endpoint error -> { message: "request to ... failed, reason: ...", error: { summary, detail } }
 *
 * The error payload has NO `metadata`. So `metadata.vulnerabilities` is the
 * discriminator, and the process exit code is deliberately NOT trusted for
 * classification (it is 1 in both cases).
 *
 * RETRY POLICY
 * ------------
 * Only an UNREACHABLE endpoint is retried. A real finding is deterministic —
 * retrying it would just burn the timeout again and delay the report.
 *
 * Each attempt gets its own wall-clock kill rather than relying on npm's
 * `--fetch-timeout` alone, because a blackholed TCP connect can outlive npm's
 * socket timeout (measured: 75s against an unroutable host with
 * `--fetch-timeout=8000`). The wall-clock bound is the only one we control.
 *
 * WHAT HAPPENS WHEN RETRIES ARE EXHAUSTED  (the deliberate decision)
 * -----------------------------------------------------------------
 * The gate FAILS by default, with exit code 75 (EX_TEMPFAIL) and an
 * unmistakable message saying npm's service is unavailable and that this is NOT
 * a security finding.
 *
 * It deliberately does not auto-pass. Batshit's house rule is no silent
 * fallbacks: "we could not check" must never render as "nothing found" on a
 * security gate, because that is exactly how an unaudited dependency ships.
 * A green audit has to mean the shipped tree was actually checked.
 *
 * Retries are what solve "an outage blocks every PR" in practice. Measured live
 * against the real 2026-09-03/04 outage: of five roots, two failed their first
 * attempt and recovered on a retry, one recovered on its third, and only one
 * stayed unreachable. The old step would have gone red on all three.
 *
 * For the rare sustained outage there is an explicit, loud escape hatch rather
 * than a permanent block: set `DEPENDENCY_AUDIT_ALLOW_UNREACHABLE=1` when
 * re-running the job. That downgrades exit 75 to a pass and still prints a
 * warning saying the audit did NOT run. It is a recorded human decision in the
 * run log, not a silent fallback — and the failure message names the knob, so
 * nobody has to remember it exists.
 *
 * The two failure modes are trivially distinguishable by a human:
 *   exit 1  -> real high/critical advisory. Fix the dependency.
 *   exit 75 -> npm was unreachable. Re-run the job. Nothing to fix here.
 *
 * The informational lane (`--mode informational`) never fails on findings and
 * says "endpoint unavailable" instead of falsely warning about advisories.
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateDependencyAuditRoots } from './validate-dependency-audit-roots.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Exit code for "npm's advisory endpoint was unreachable" (EX_TEMPFAIL). */
export const EXIT_ENDPOINT_UNAVAILABLE = 75;
/** Exit code for a real high/critical advisory. */
export const EXIT_FINDING = 1;

/** Severities that fail the blocking gate. Unchanged from the previous step. */
export const BLOCKING_SEVERITIES = ['high', 'critical'];

/**
 * Explicit, human-set override for a SUSTAINED outage. It passes the job while
 * still printing that the audit did not run — an accepted risk on the record,
 * never a silent pass. The failure message names it so it is discoverable.
 */
export const ALLOW_UNREACHABLE_ENV = 'DEPENDENCY_AUDIT_ALLOW_UNREACHABLE';

export function allowUnreachable(env = process.env) {
  return env?.[ALLOW_UNREACHABLE_ENV] === '1';
}

export const DEFAULT_RETRY_POLICY = {
  /** Total attempts per root, including the first. */
  attempts: 3,
  /** Wall-clock kill for one attempt. A healthy root audits in ~5-120s in CI. */
  attemptTimeoutMs: 150_000,
  /** Waits between attempts, in order. */
  backoffMs: [10_000, 30_000],
  /** No new attempt starts after this much total elapsed time. */
  totalBudgetMs: 900_000,
};

/**
 * Classifies one `npm audit --json` attempt.
 *
 * The exit code is intentionally ignored: npm returns 1 both for a real
 * advisory and for an endpoint error, which is the whole reason this exists.
 */
export function classifyAuditOutput({ stdout, stderr = '' }) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    // npm could not even produce JSON. Retrying will not help; fail loudly with
    // whatever npm said so the cause is visible instead of guessed at.
    const detail = (stderr || stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 400);
    return { kind: 'unparseable', reason: detail || 'npm produced no parseable JSON output.' };
  }

  const counts = payload?.metadata?.vulnerabilities;
  if (!counts || typeof counts !== 'object') {
    // Verified error shape: { message, error: { summary, detail } } and no metadata.
    const reason =
      (typeof payload?.message === 'string' && payload.message) ||
      (typeof payload?.error?.summary === 'string' && payload.error.summary) ||
      'npm audit returned no vulnerability metadata.';
    return { kind: 'unreachable', reason: String(reason).slice(0, 400) };
  }

  return { kind: 'result', counts };
}

/** Total advisories at a severity the gate blocks on. */
export function blockingCount(counts) {
  return BLOCKING_SEVERITIES.reduce(
    (total, severity) => total + (Number(counts?.[severity]) || 0),
    0,
  );
}

/** Compact human summary, e.g. "2 high, 1 critical" or "none". */
export function summarizeCounts(counts) {
  const parts = BLOCKING_SEVERITIES.filter((severity) => Number(counts?.[severity]) > 0).map(
    (severity) => `${counts[severity]} ${severity}`,
  );
  return parts.length > 0 ? parts.join(', ') : 'none';
}

/** GitHub Actions annotation; harmless plain text when run locally. */
function annotate(level, message) {
  process.stdout.write(`::${level}::${message}\n`);
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Runs `npm audit --json` once in `cwd`, killed after `timeoutMs`.
 * Never rejects: a timeout or spawn failure is returned as output to classify.
 */
export function runNpmAuditOnce({ cwd, omitDev, timeoutMs, spawnFn = spawn }) {
  return new Promise((done) => {
    const args = ['audit', '--json'];
    if (omitDev) args.push('--omit=dev');
    // Bounds npm's own socket wait (default 300000). The wall-clock kill below
    // is the real guarantee; this just lets npm give up on its own sooner.
    args.push(`--fetch-timeout=${Math.max(10_000, Math.floor(timeoutMs / 2))}`);

    const child = spawnFn('npm', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      done({
        stdout: '',
        stderr: `npm audit exceeded the ${Math.round(timeoutMs / 1000)}s wall-clock limit for this attempt.`,
        timedOut: true,
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ stdout: '', stderr: `Failed to run npm: ${error.message}`, timedOut: false });
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ stdout, stderr, timedOut: false });
    });
  });
}

/**
 * Audits one root, retrying ONLY while the endpoint looks unreachable.
 * Returns the final classification plus how many attempts it took.
 */
export async function auditRoot({
  root,
  omitDev,
  policy = DEFAULT_RETRY_POLICY,
  startedAt = Date.now(),
  runner = runNpmAuditOnce,
  onRetry = () => {},
}) {
  const cwd = join(repoRoot, root);
  let last = { kind: 'unreachable', reason: 'No audit attempt ran.' };

  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    const raw = await runner({ cwd, omitDev, timeoutMs: policy.attemptTimeoutMs });
    last = raw.timedOut
      ? { kind: 'unreachable', reason: raw.stderr }
      : classifyAuditOutput(raw);

    // A finding and an unparseable failure are both deterministic — do not retry.
    if (last.kind !== 'unreachable') return { ...last, attempts: attempt };
    if (attempt === policy.attempts) break;

    const wait = policy.backoffMs[attempt - 1] ?? policy.backoffMs.at(-1) ?? 0;
    if (Date.now() - startedAt + wait > policy.totalBudgetMs) {
      return { ...last, attempts: attempt, budgetExhausted: true };
    }
    onRetry({ root, attempt, wait, reason: last.reason });
    await sleep(wait);
  }

  return { ...last, attempts: policy.attempts };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const informational = argv.includes('--mode=informational');
  const omitDev = !informational;
  const label = informational ? 'full audit (informational)' : 'audit (prod deps)';

  const roots = await validateDependencyAuditRoots();
  log(JSON.stringify({ ok: true, mode: informational ? 'informational' : 'blocking', roots }));

  const startedAt = Date.now();
  const findings = [];
  const unreachable = [];
  const broken = [];

  for (const root of roots) {
    log(`=== ${label}: ${root} ===`);
    const outcome = await auditRoot({
      root,
      omitDev,
      startedAt,
      onRetry: ({ attempt, wait, reason }) => {
        log(
          `  npm's advisory endpoint did not answer (attempt ${attempt}): ${reason}\n` +
            `  Retrying in ${Math.round(wait / 1000)}s — this is a service problem, not a finding.`,
        );
      },
    });

    if (outcome.kind === 'result') {
      const blocking = blockingCount(outcome.counts);
      log(`  high/critical: ${summarizeCounts(outcome.counts)} (total ${outcome.counts.total ?? 0})`);
      if (blocking > 0) findings.push({ root, counts: outcome.counts });
      continue;
    }

    if (outcome.kind === 'unparseable') {
      log(`  npm audit produced no usable report: ${outcome.reason}`);
      broken.push({ root, reason: outcome.reason });
      continue;
    }

    const suffix = outcome.budgetExhausted ? ' (retry budget exhausted)' : '';
    log(`  ENDPOINT UNAVAILABLE after ${outcome.attempts} attempt(s)${suffix}: ${outcome.reason}`);
    unreachable.push({ root, reason: outcome.reason });
  }

  if (informational) {
    // This lane never blocks. It must still not claim advisories exist when the
    // truth is that npm never answered.
    for (const { root } of findings) {
      annotate(
        'warning',
        `High/critical advisories exist in the full dependency tree for ${root} (dev/build chain included). Non-blocking by design — review during dependency maintenance.`,
      );
    }
    for (const { root } of [...unreachable, ...broken]) {
      annotate(
        'warning',
        `npm's audit endpoint was unavailable for ${root}, so the informational full-tree audit did NOT run. This is not a clean audit and not a finding.`,
      );
    }
    return 0;
  }

  if (findings.length > 0) {
    for (const { root, counts } of findings) {
      annotate('error', `High/critical advisories in shipped dependencies for ${root}: ${summarizeCounts(counts)}.`);
    }
    log('\nRESULT: real high/critical advisories found in shipped dependencies. Fix or override deliberately.');
    return EXIT_FINDING;
  }

  if (broken.length > 0) {
    for (const { root, reason } of broken) {
      annotate('error', `npm audit could not produce a report for ${root}: ${reason}`);
    }
    log('\nRESULT: npm audit failed in a way retrying cannot fix. See the messages above.');
    return EXIT_FINDING;
  }

  if (unreachable.length > 0) {
    const names = unreachable.map(({ root }) => root).join(', ');

    if (allowUnreachable(env)) {
      // A maintainer set the override on this re-run. Still never green-washed:
      // the log says plainly that the audit did not run.
      annotate(
        'warning',
        `${ALLOW_UNREACHABLE_ENV}=1 was set, so an unreachable npm endpoint is being accepted for: ${names}. The shipped dependencies were NOT audited on this run.`,
      );
      log(
        `\nRESULT: npm was unreachable and ${ALLOW_UNREACHABLE_ENV} is set, so this job is passing WITHOUT a completed audit.\n` +
          'This is an accepted risk, not a clean result. Re-run without the override once npm recovers.',
      );
      return 0;
    }

    annotate(
      'error',
      `npm audit endpoint unavailable for: ${names}. This is NOT a security finding and NOT a clean audit — npm's advisory service did not answer. Re-run this job.`,
    );
    log(
      '\nRESULT: npm\'s advisory service was unreachable, so the dependency audit did not complete.\n' +
        'This is NOT a security finding. Nothing in this repository needs fixing.\n' +
        'Re-run this job once npm recovers (https://status.npmjs.org).\n' +
        `Exit code ${EXIT_ENDPOINT_UNAVAILABLE} means "could not check", never "nothing found".\n` +
        `If npm stays down and a merge genuinely cannot wait, re-run this job with\n` +
        `${ALLOW_UNREACHABLE_ENV}=1 to accept the risk deliberately — it passes the job but\n` +
        'records loudly that the shipped dependencies were never audited.',
    );
    return EXIT_ENDPOINT_UNAVAILABLE;
  }

  log('\nRESULT: no high/critical advisories in shipped dependencies across all roots.');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT_FINDING;
  }
}
