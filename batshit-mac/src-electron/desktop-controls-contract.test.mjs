import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DESKTOP_CONTROLS_COMMANDS,
  DESKTOP_CONTROLS_SCHEMA_VERSION,
  validateDesktopControlsCommandEnvelope
} from './desktop-controls-contract.mjs';

function envelope(command, payload = {}, sequence = 1) {
  return { schemaVersion: DESKTOP_CONTROLS_SCHEMA_VERSION, sequence, command, payload };
}

test('Desktop Controls commands are exact and role-scoped', () => {
  assert.equal(
    validateDesktopControlsCommandEnvelope(
      envelope(DESKTOP_CONTROLS_COMMANDS.updateState, { state: { sessionId: 'session-1' } }),
      { role: 'main' }
    ).command,
    DESKTOP_CONTROLS_COMMANDS.updateState
  );
  assert.equal(
    validateDesktopControlsCommandEnvelope(
      envelope(DESKTOP_CONTROLS_COMMANDS.setAdjust, { enabled: true }),
      { role: 'controls' }
    ).command,
    DESKTOP_CONTROLS_COMMANDS.setAdjust
  );
  assert.equal(
    validateDesktopControlsCommandEnvelope(
      envelope(DESKTOP_CONTROLS_COMMANDS.sendIntent, {
        intent: 'voice.start',
        payload: { source: 'desktop-controls' }
      }),
      { role: 'controls' }
    ).command,
    DESKTOP_CONTROLS_COMMANDS.sendIntent
  );
  assert.throws(
    () => validateDesktopControlsCommandEnvelope(
      envelope(DESKTOP_CONTROLS_COMMANDS.setAdjust, { enabled: true }),
      { role: 'main' }
    ),
    /not allowed/
  );
  assert.throws(
    () => validateDesktopControlsCommandEnvelope(
      envelope(DESKTOP_CONTROLS_COMMANDS.show),
      { role: 'controls' }
    ),
    /not allowed/
  );
});

test('Desktop Controls projection rejects raw or oversized state', () => {
  assert.throws(
    () => validateDesktopControlsCommandEnvelope(
      envelope(DESKTOP_CONTROLS_COMMANDS.updateState, { state: [] }),
      { role: 'main' }
    ),
    /clone-safe plain JSON/
  );
  assert.throws(
    () => validateDesktopControlsCommandEnvelope(
      envelope(DESKTOP_CONTROLS_COMMANDS.updateState, { state: new Date() }),
      { role: 'main' }
    ),
    /clone-safe plain JSON/
  );
  assert.throws(
    () => validateDesktopControlsCommandEnvelope(
      envelope(DESKTOP_CONTROLS_COMMANDS.updateState, {
        state: { clipsSummary: 'x'.repeat(70 * 1024) }
      }),
      { role: 'main' }
    ),
    /projected state exceeds/
  );
  assert.throws(
    () => validateDesktopControlsCommandEnvelope(
      { ...envelope(DESKTOP_CONTROLS_COMMANDS.getState), sequence: 2 },
      { role: 'main', lastSequence: 2 }
    ),
    /stale/
  );
});

test('Desktop Controls renderer intents require a stable name and plain bounded payload', () => {
  assert.throws(
    () => validateDesktopControlsCommandEnvelope(
      envelope(DESKTOP_CONTROLS_COMMANDS.sendIntent, {
        intent: '../voice',
        payload: {}
      }),
      { role: 'controls' }
    ),
    /stable name/
  );
  assert.throws(
    () => validateDesktopControlsCommandEnvelope(
      envelope(DESKTOP_CONTROLS_COMMANDS.sendIntent, {
        intent: 'clips.attach',
        payload: new Date()
      }),
      { role: 'controls' }
    ),
    /clone-safe plain JSON/
  );
});
