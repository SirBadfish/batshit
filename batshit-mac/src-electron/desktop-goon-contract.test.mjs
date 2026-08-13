import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DESKTOP_GOON_COMMANDS,
  DESKTOP_GOON_SCHEMA_VERSION,
  DESKTOP_GOON_WINDOW_ROLES,
  validateDesktopGoonCommandEnvelope,
  validateDesktopGoonPortEnvelope
} from './desktop-goon-contract.mjs';

function command(command, payload = {}, sequence = 1) {
  return { schemaVersion: DESKTOP_GOON_SCHEMA_VERSION, sequence, command, payload };
}

test('Desktop Goon commands are role-scoped and sequence-checked', () => {
  assert.equal(
    validateDesktopGoonCommandEnvelope(command(DESKTOP_GOON_COMMANDS.open), {
      role: DESKTOP_GOON_WINDOW_ROLES.main
    }).command,
    DESKTOP_GOON_COMMANDS.open
  );
  assert.throws(
    () =>
      validateDesktopGoonCommandEnvelope(command(DESKTOP_GOON_COMMANDS.open), {
        role: DESKTOP_GOON_WINDOW_ROLES.desktop
      }),
    /not allowed/
  );
  assert.throws(
    () =>
      validateDesktopGoonCommandEnvelope(command(DESKTOP_GOON_COMMANDS.getStatus, {}, 3), {
        role: DESKTOP_GOON_WINDOW_ROLES.main,
        lastSequence: 3
      }),
    /stale/
  );
});

test('Desktop Goon commands reject schema, shape, and size expansion', () => {
  assert.throws(
    () =>
      validateDesktopGoonCommandEnvelope(
        { ...command(DESKTOP_GOON_COMMANDS.getStatus), schemaVersion: 'desktop-goon/v2' },
        { role: DESKTOP_GOON_WINDOW_ROLES.main }
      ),
    /schema mismatch/
  );
  assert.throws(
    () =>
      validateDesktopGoonCommandEnvelope(
        command(DESKTOP_GOON_COMMANDS.setBounds, { bounds: {}, nativeCommand: 'open' }),
        { role: DESKTOP_GOON_WINDOW_ROLES.main }
      ),
    /Unsupported.*payload field/
  );
  assert.throws(
    () =>
      validateDesktopGoonCommandEnvelope(command(DESKTOP_GOON_COMMANDS.close, {
        reason: 'x'.repeat(1000)
      }), { role: DESKTOP_GOON_WINDOW_ROLES.main }),
    /bounded string/
  );
  assert.throws(
    () =>
      validateDesktopGoonCommandEnvelope(command(DESKTOP_GOON_COMMANDS.open, {
        preferences: { padding: 'x'.repeat(200) }
      }), { role: DESKTOP_GOON_WINDOW_ROLES.main, maximumBytes: 100 }),
    /byte limit/
  );
});

test('Desktop Goon state-port messages enforce version, order, kind, and size', () => {
  const message = {
    schemaVersion: DESKTOP_GOON_SCHEMA_VERSION,
    sequence: 2,
    kind: 'delta',
    payload: { speaking: true }
  };
  assert.equal(validateDesktopGoonPortEnvelope(message, { lastSequence: 1 }), message);
  assert.throws(() => validateDesktopGoonPortEnvelope(message, { lastSequence: 2 }), /stale/);
  assert.throws(
    () => validateDesktopGoonPortEnvelope({ ...message, kind: 'electron-command' }),
    /Unsupported/
  );
});
