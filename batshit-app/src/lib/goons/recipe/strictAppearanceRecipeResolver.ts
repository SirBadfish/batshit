import {
  APPEARANCE_DIAL_VALUES_CONTRACT,
  type AppearanceDialValueState,
  type AppearanceDialsManifest,
  type ReconciledAppearanceDialValues,
  type ResolvedAppearanceDialState,
} from "../appearanceDials.contracts";
import {
  appearanceDialValuesEqual,
  reconcileAppearanceDialValues,
  resolveAppearanceDialState,
} from "../appearanceDials.values";
import {
  hasOwn,
  isFiniteNumber,
  isRecord,
  isStableId,
} from "../appearanceDials.validation";
import {
  snapshotAppearanceRecipePhysicalOutput,
  type AppearanceRecipePhysicalSnapshot,
} from "./appearanceRecipeSnapshot";

const STATE_KEYS = [
  "contract",
  "definitionSha256",
  "neutralId",
  "neutralRecipeSha256",
  "values",
  "unlockedDialIds",
] as const;

type ControlSpec = {
  range: [number, number];
  sideOwner?: string;
};

export type AppearanceRecipeControlInventory = {
  ranges: Record<string, [number, number]>;
  unlockDialIds: string[];
  sideOwnerByControlId: Record<string, string>;
};

/**
 * Strict, package-independent Recipe resolution result.
 *
 * This is the shared logical/physical-snapshot foundation for R2 planning. It
 * deliberately does not claim to evaluate GLB POSITION data, joint matrices,
 * inverse binds, or final node matrices. Those belong to the later physical
 * model/evaluator slice.
 */
export type StrictAppearanceRecipeSnapshotResolution = {
  state: AppearanceDialValueState;
  resolved: ResolvedAppearanceDialState;
  physicalSnapshot: AppearanceRecipePhysicalSnapshot;
};

function fail(reason: string): never {
  throw new Error(`strict Appearance Recipe state rejected: ${reason}`);
}

function buildControlSpecs(
  manifest: AppearanceDialsManifest,
): Map<string, ControlSpec> {
  const controls = new Map<string, ControlSpec>();
  const add = (id: string, spec: ControlSpec) => {
    if (controls.has(id)) {
      fail(`manifest declares duplicate control ${id}`);
    }
    controls.set(id, spec);
  };

  for (const dial of manifest.dials) {
    add(dial.id, { range: dial.range });
    if (dial.symmetry?.mode !== "linked-with-offsets") continue;
    add(dial.symmetry.left.id, {
      range: dial.symmetry.left.range,
      sideOwner: dial.id,
    });
    add(dial.symmetry.right.id, {
      range: dial.symmetry.right.range,
      sideOwner: dial.id,
    });
  }
  return controls;
}

/** Exact control/range/unlock inventory shared by strict state resolution and R2 planning. */
export function appearanceRecipeControlInventory(
  manifest: AppearanceDialsManifest,
): AppearanceRecipeControlInventory {
  const specs = buildControlSpecs(manifest);
  const ranges: Record<string, [number, number]> = {};
  const sideOwnerByControlId: Record<string, string> = {};
  for (const id of [...specs.keys()].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const spec = specs.get(id)!;
    ranges[id] = [...spec.range];
    if (spec.sideOwner) sideOwnerByControlId[id] = spec.sideOwner;
  }
  return {
    ranges,
    unlockDialIds: manifest.dials
      .filter((dial) => dial.symmetry?.mode === "linked-with-offsets")
      .map((dial) => dial.id)
      .sort((left, right) => left.localeCompare(right)),
    sideOwnerByControlId,
  };
}

function assertExactObjectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
) {
  const expectedSet = new Set(expected);
  const unknown = Object.keys(value)
    .filter((key) => !expectedSet.has(key))
    .sort((left, right) => left.localeCompare(right));
  const missing = expected
    .filter((key) => !hasOwn(value, key))
    .sort((left, right) => left.localeCompare(right));
  if (unknown.length > 0) {
    fail(`${context} contains unknown fields: ${unknown.join(", ")}`);
  }
  if (missing.length > 0) {
    fail(`${context} is missing fields: ${missing.join(", ")}`);
  }
}

function assertReconciliationWasIdentity(
  state: AppearanceDialValueState,
  reconciled: ReconciledAppearanceDialValues,
) {
  if (reconciled.incompatible) {
    fail(
      `editor reconciliation marked the state incompatible: ${reconciled.incompatibilityReasons.join(", ")}`,
    );
  }
  const changes = [
    ["prune controls", reconciled.prunedIds],
    ["prune unlocks", reconciled.prunedUnlockIds],
    ["clamp controls", reconciled.clampedIds],
    ["reset controls", reconciled.resetIds],
  ] as const;
  const changed = changes
    .filter(([, ids]) => ids.length > 0)
    .map(([action, ids]) => `${action}: ${ids.join(", ")}`);
  if (changed.length > 0) {
    fail(`editor reconciliation would ${changed.join("; ")}`);
  }
  if (!appearanceDialValuesEqual(state, reconciled.state)) {
    fail("editor reconciliation would change the saved state");
  }
}

/** Build the one exact neutral saved state for a parsed Appearance Dials v2 manifest. */
export function createNeutralAppearanceRecipeState(
  manifest: AppearanceDialsManifest,
): AppearanceDialValueState {
  const controls = buildControlSpecs(manifest);
  const values: Record<string, number> = {};
  for (const id of [...controls.keys()].sort((left, right) =>
    left.localeCompare(right),
  )) {
    values[id] = 0;
  }
  return {
    contract: APPEARANCE_DIAL_VALUES_CONTRACT,
    definitionSha256: manifest.definitionSha256,
    neutralId: manifest.neutral.id,
    neutralRecipeSha256: manifest.neutral.recipeSha256,
    values,
    unlockedDialIds: [],
  };
}

/**
 * Validate an exact Appearance Dials v2 saved state, then invoke the existing
 * canonical logical resolver and R0 physical-snapshot serializer.
 *
 * Unlike editor reconciliation, this entrypoint never repairs, prunes, resets,
 * or clamps input. Any state that would require such a change fails closed.
 */
export function resolveStrictAppearanceRecipeSnapshot(
  manifest: AppearanceDialsManifest,
  stored: unknown,
): StrictAppearanceRecipeSnapshotResolution {
  if (!isRecord(stored)) fail("state must be an object");
  assertExactObjectKeys(stored, STATE_KEYS, "state");

  if (stored.contract !== APPEARANCE_DIAL_VALUES_CONTRACT) {
    fail(`contract must be ${APPEARANCE_DIAL_VALUES_CONTRACT}`);
  }
  if (stored.definitionSha256 !== manifest.definitionSha256) {
    fail("definition identity does not match the manifest");
  }
  if (stored.neutralId !== manifest.neutral.id) {
    fail("neutral id does not match the manifest");
  }
  if (stored.neutralRecipeSha256 !== manifest.neutral.recipeSha256) {
    fail("neutral Recipe identity does not match the manifest");
  }
  if (!isRecord(stored.values)) fail("values must be an object");
  if (!Array.isArray(stored.unlockedDialIds)) {
    fail("unlockedDialIds must be an array");
  }

  const controls = buildControlSpecs(manifest);
  const controlIds = [...controls.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
  assertExactObjectKeys(stored.values, controlIds, "values");

  const unlockable = new Set(
    manifest.dials
      .filter((dial) => dial.symmetry?.mode === "linked-with-offsets")
      .map((dial) => dial.id),
  );
  const unlocks: string[] = [];
  const seenUnlocks = new Set<string>();
  for (const value of stored.unlockedDialIds) {
    if (!isStableId(value)) fail("unlockedDialIds contains an invalid id");
    if (seenUnlocks.has(value)) {
      fail(`unlockedDialIds contains duplicate ${value}`);
    }
    if (!unlockable.has(value)) {
      fail(`unlockedDialIds contains non-unlockable control ${value}`);
    }
    seenUnlocks.add(value);
    unlocks.push(value);
  }
  const canonicalUnlocks = [...unlocks].sort((left, right) =>
    left.localeCompare(right),
  );
  if (unlocks.some((id, index) => id !== canonicalUnlocks[index])) {
    fail("unlockedDialIds must use canonical ascending id order");
  }

  const values: Record<string, number> = {};
  for (const id of controlIds) {
    const value = stored.values[id];
    const spec = controls.get(id)!;
    if (!isFiniteNumber(value)) fail(`control ${id} must be finite`);
    if (value < spec.range[0] || value > spec.range[1]) {
      fail(`control ${id} is outside [${spec.range[0]}, ${spec.range[1]}]`);
    }
    if (spec.sideOwner && !seenUnlocks.has(spec.sideOwner) && value !== 0) {
      fail(`locked side offset ${id} must be exactly zero`);
    }
    values[id] = value;
  }

  const state: AppearanceDialValueState = {
    contract: APPEARANCE_DIAL_VALUES_CONTRACT,
    definitionSha256: manifest.definitionSha256,
    neutralId: manifest.neutral.id,
    neutralRecipeSha256: manifest.neutral.recipeSha256,
    values,
    unlockedDialIds: [...unlocks],
  };
  const reconciled = reconcileAppearanceDialValues(manifest, state);
  assertReconciliationWasIdentity(state, reconciled);

  const resolved = resolveAppearanceDialState(manifest, state);
  return {
    state,
    resolved,
    physicalSnapshot: snapshotAppearanceRecipePhysicalOutput(resolved),
  };
}
