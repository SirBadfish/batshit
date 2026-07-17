import type { AppearanceDialValueState } from "../appearanceDials.contracts";
import { isFiniteNumber, isStableId } from "../appearanceDials.validation";
import {
  evaluateRecipeComponentMap,
  recipeComponentMapBundleSha256,
  recipeExecutableComponentMapSha256,
  verifyRecipeComponentMapBundle,
  type RecipeComponentMapBundle,
  type RecipeComponentMapMembership,
  type RecipeExecutableComponentMap,
} from "./componentMapContracts";
import type {
  RecipeMigrationCandidateOrigin,
  RecipeMigrationControlResolution,
  RecipeMigrationReasonCode,
  RecipeMigrationRejectionCode,
  RecipeMigrationComponentProof,
} from "./migrationPlanContracts";
import { canonicalRecipeSha256 } from "./recipeCanonical";
import {
  verifyRecipeUpdateEdge,
  type RecipeControlUpdatePlan,
  type RecipeExactMapping,
  type RecipeUpdateEdge,
} from "./updateContracts";

export const APPEARANCE_RECIPE_CANDIDATE_GENERATOR_CONTRACT =
  "appearance-recipe-candidate-generator/v1" as const;

export type AppearanceRecipeCandidateComponentStatus =
  "candidate" | "non-preserved" | "rejected";

export type AppearanceRecipeCandidateControl = {
  ledgerId: string;
  sourceValue: number | null;
  targetValue: number | null;
  resolution: RecipeMigrationControlResolution;
  aliasId: string | null;
  candidateOrigin: RecipeMigrationCandidateOrigin;
  reasonCode: RecipeMigrationReasonCode;
  message: string;
  requiresPreview: boolean;
  requiresConfirmation: boolean;
  preserved: boolean;
};

export type AppearanceRecipeComponentCandidate = {
  componentId: string;
  sourceControlIds: string[];
  targetControlIds: string[];
  sourceUnlockDialIds: string[];
  targetUnlockDialIds: string[];
  status: AppearanceRecipeCandidateComponentStatus;
  solver: RecipeMigrationComponentProof["solver"];
  branchId: string | null;
  componentMapSha256: string | null;
  authorizedCandidateCount: number;
  candidateSha256: string | null;
  uniquenessMethod: RecipeMigrationComponentProof["uniquenessMethod"];
  uniquenessProofSha256: string | null;
  values: Record<string, number> | null;
  unlockedDialIds: string[] | null;
  controls: AppearanceRecipeCandidateControl[];
  rejectionCodes: RecipeMigrationRejectionCode[];
};

export type AppearanceRecipeCandidateGeneration = {
  contract: typeof APPEARANCE_RECIPE_CANDIDATE_GENERATOR_CONTRACT;
  directEdgeKey: string;
  edgeSha256: string;
  componentMapBundleSha256: string | null;
  components: AppearanceRecipeComponentCandidate[];
};

export type AppearanceRecipeCandidateGeneratorInput = {
  edge: RecipeUpdateEdge;
  sourceState: AppearanceDialValueState;
  sourceControlRanges: Record<string, [number, number]>;
  targetControlRanges: Record<string, [number, number]>;
  componentMembership: Record<string, RecipeComponentMapMembership>;
  componentMapBundle?: RecipeComponentMapBundle;
};

type CandidateState = {
  values: Record<string, number>;
  unlockedDialIds: string[];
};

type CandidateFailure = {
  codes: RecipeMigrationRejectionCode[];
  message: string;
};

function copyMembership(
  membership: RecipeComponentMapMembership,
): RecipeComponentMapMembership {
  return {
    sourceControlIds: [...membership.sourceControlIds],
    targetControlIds: [...membership.targetControlIds],
    sourceUnlockDialIds: [...membership.sourceUnlockDialIds],
    targetUnlockDialIds: [...membership.targetUnlockDialIds],
  };
}

const COMPLEX_BEHAVIOR_KINDS = new Set([
  "macro",
  "bilateral-unlock",
  "shared-clamp",
]);

function fail(message: string): never {
  throw new Error(
    `[${APPEARANCE_RECIPE_CANDIDATE_GENERATOR_CONTRACT}] ${message}`,
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sortedUnique(values: readonly string[], context: string): string[] {
  const result = [...values];
  for (const [index, value] of result.entries()) {
    if (!isStableId(value)) fail(`${context}[${index}] must be a stable id`);
  }
  result.sort(compareText);
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1] === result[index]) {
      fail(`${context} contains duplicate ${result[index]}`);
    }
  }
  if (!sameStrings(result, values)) {
    fail(`${context} must be sorted and unique`);
  }
  return result;
}

function normalizeFinite(value: number, context: string): number {
  if (!isFiniteNumber(value)) fail(`${context} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

function normalizeRejectionCodes(
  values: readonly RecipeMigrationRejectionCode[],
): RecipeMigrationRejectionCode[] {
  return [...new Set(values)].sort(compareText);
}

function rangeFor(
  ranges: Record<string, [number, number]>,
  id: string,
): [number, number] {
  const range = ranges[id];
  if (
    !range ||
    !Array.isArray(range) ||
    range.length !== 2 ||
    !range.every(isFiniteNumber) ||
    range[0] > range[1]
  ) {
    fail(`target control ${id} has no exact finite range`);
  }
  return range;
}

function candidateFailure(
  codes: RecipeMigrationRejectionCode[],
  message: string,
): CandidateFailure {
  return { codes: normalizeRejectionCodes(codes), message };
}

function isCandidateFailure(value: unknown): value is CandidateFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as CandidateFailure).codes) &&
    typeof (value as CandidateFailure).message === "string"
  );
}

function validateSourceState(
  state: AppearanceDialValueState,
  edge: RecipeUpdateEdge,
  memberships: Record<string, RecipeComponentMapMembership>,
) {
  if (
    state.contract !== "appearance-dial-values/v2" ||
    state.definitionSha256 !== edge.from.definitionSha256 ||
    state.neutralId !== edge.from.neutralId ||
    state.neutralRecipeSha256 !== edge.from.neutralRecipeSha256
  ) {
    fail("source Appearance state does not bind the direct edge");
  }
  const expectedControlIds = edge.stableIdLedger.fromIds;
  const actualControlIds = Object.keys(state.values).sort(compareText);
  if (!sameStrings(actualControlIds, expectedControlIds)) {
    fail("source Appearance values do not exhaust the stable-id ledger");
  }
  for (const id of actualControlIds) {
    normalizeFinite(state.values[id], `source control ${id}`);
  }
  sortedUnique(state.unlockedDialIds, "source unlockedDialIds");
  const knownUnlocks = new Set(
    Object.values(memberships).flatMap(
      (membership) => membership.sourceUnlockDialIds,
    ),
  );
  for (const id of state.unlockedDialIds) {
    if (!knownUnlocks.has(id)) {
      fail(`source unlock ${id} is absent from component membership`);
    }
  }
}

function validateTargetRanges(
  ranges: Record<string, [number, number]>,
  edge: RecipeUpdateEdge,
) {
  const ids = Object.keys(ranges).sort(compareText);
  if (!sameStrings(ids, edge.stableIdLedger.toIds)) {
    fail("target ranges do not exhaust the stable-id ledger");
  }
  for (const id of ids) rangeFor(ranges, id);
}

function validateMemberships(
  memberships: Record<string, RecipeComponentMapMembership>,
  edge: RecipeUpdateEdge,
) {
  const controlsById = new Map(
    edge.controls.map((control) => [control.id, control]),
  );
  const seenSource = new Set<string>();
  const seenTarget = new Set<string>();
  const seenSourceUnlocks = new Set<string>();
  const seenTargetUnlocks = new Set<string>();
  for (const componentId of Object.keys(memberships).sort(compareText)) {
    if (!isStableId(componentId))
      fail(`component id ${componentId} is invalid`);
    const membership = memberships[componentId];
    const sourceControlIds = sortedUnique(
      membership.sourceControlIds,
      `${componentId}.sourceControlIds`,
    );
    const targetControlIds = sortedUnique(
      membership.targetControlIds,
      `${componentId}.targetControlIds`,
    );
    const sourceUnlockDialIds = sortedUnique(
      membership.sourceUnlockDialIds,
      `${componentId}.sourceUnlockDialIds`,
    );
    const targetUnlockDialIds = sortedUnique(
      membership.targetUnlockDialIds,
      `${componentId}.targetUnlockDialIds`,
    );
    if (sourceControlIds.length === 0 && targetControlIds.length === 0) {
      fail(`component ${componentId} has no controls`);
    }
    if (sourceUnlockDialIds.some((id) => !sourceControlIds.includes(id))) {
      fail(`component ${componentId} has a source unlock outside its controls`);
    }
    if (targetUnlockDialIds.some((id) => !targetControlIds.includes(id))) {
      fail(`component ${componentId} has a target unlock outside its controls`);
    }
    for (const id of [...new Set([...sourceControlIds, ...targetControlIds])]) {
      const control = controlsById.get(id);
      if (!control || control.componentId !== componentId) {
        fail(`component ${componentId} contradicts control ${id}`);
      }
    }
    for (const id of sourceControlIds) {
      if (seenSource.has(id))
        fail(`source control ${id} belongs to two components`);
      seenSource.add(id);
    }
    for (const id of targetControlIds) {
      if (seenTarget.has(id))
        fail(`target control ${id} belongs to two components`);
      seenTarget.add(id);
    }
    for (const id of sourceUnlockDialIds) {
      if (seenSourceUnlocks.has(id))
        fail(`source unlock ${id} belongs to two components`);
      seenSourceUnlocks.add(id);
    }
    for (const id of targetUnlockDialIds) {
      if (seenTargetUnlocks.has(id))
        fail(`target unlock ${id} belongs to two components`);
      seenTargetUnlocks.add(id);
    }
  }
  if (
    !sameStrings(
      [...seenSource].sort(compareText),
      edge.stableIdLedger.fromIds,
    ) ||
    !sameStrings([...seenTarget].sort(compareText), edge.stableIdLedger.toIds)
  ) {
    fail("component membership does not exhaust the stable-id ledger");
  }
  for (const control of edge.controls) {
    if (!memberships[control.componentId]) {
      fail(
        `control ${control.id} references missing component ${control.componentId}`,
      );
    }
  }
}

async function validateComponentMapBundle(
  value: RecipeComponentMapBundle | undefined,
  edge: RecipeUpdateEdge,
  memberships: Record<string, RecipeComponentMapMembership>,
  sourceControlRanges: Record<string, [number, number]>,
  targetControlRanges: Record<string, [number, number]>,
): Promise<{
  bundle: RecipeComponentMapBundle | null;
  mapsByComponent: Map<string, RecipeExecutableComponentMap>;
}> {
  if (!value) return { bundle: null, mapsByComponent: new Map() };
  const bundle = await verifyRecipeComponentMapBundle(value, {
    edge,
    sourceControlRanges,
    targetControlRanges,
    componentMembership: memberships,
  });
  const actualBundleSha256 = await recipeComponentMapBundleSha256(bundle);
  if (actualBundleSha256 !== bundle.bundleSha256) {
    fail("component map bundle hash mismatch");
  }
  const mapsByComponent = new Map<string, RecipeExecutableComponentMap>();
  for (const map of bundle.maps) {
    if ((await recipeExecutableComponentMapSha256(map)) !== map.mapSha256) {
      fail(`component map ${map.mapId} hash mismatch`);
    }
    const membership = memberships[map.componentId];
    if (
      !membership ||
      !sameStrings(map.sourceControlIds, membership.sourceControlIds) ||
      !sameStrings(map.targetControlIds, membership.targetControlIds) ||
      !sameStrings(map.sourceUnlockDialIds, membership.sourceUnlockDialIds) ||
      !sameStrings(map.targetUnlockDialIds, membership.targetUnlockDialIds)
    ) {
      fail(`component map ${map.mapId} contradicts component membership`);
    }
    mapsByComponent.set(map.componentId, map);
  }
  const controlsById = new Map(
    edge.controls.map((control) => [control.id, control]),
  );
  for (const alias of edge.aliases) {
    const source = controlsById.get(alias.fromId);
    const target = controlsById.get(alias.toId);
    if (!source || !target || source.componentId !== target.componentId) {
      fail(`alias ${alias.fromId}:${alias.toId} crosses components`);
    }
    const map = mapsByComponent.get(source.componentId);
    if (!map || map.mapSha256 !== alias.componentMapSha256) {
      fail(`alias ${alias.fromId}:${alias.toId} has no exact component map`);
    }
  }
  return { bundle, mapsByComponent };
}

function aliasesByControl(edge: RecipeUpdateEdge): Map<string, string> {
  const result = new Map<string, string>();
  for (const alias of edge.aliases) {
    const aliasId = `${alias.fromId}:${alias.toId}`;
    if (result.has(alias.fromId) || result.has(alias.toId)) {
      fail(`alias ${aliasId} collides with another alias`);
    }
    result.set(alias.fromId, aliasId);
    result.set(alias.toId, aliasId);
  }
  return result;
}

function controlsForComponent(
  edge: RecipeUpdateEdge,
  componentId: string,
): RecipeControlUpdatePlan[] {
  return edge.controls.filter((control) => control.componentId === componentId);
}

function hasUnsafeCoupledChange(
  controls: RecipeControlUpdatePlan[],
  membership: RecipeComponentMapMembership,
): boolean {
  // Reset-required and active-removal rows are intentionally emitted as
  // non-preserved preview work when no map exists. Exact affine/piecewise
  // preservation is the path that may not solve a coupled component one
  // control at a time.
  const behaviorChanged = controls.some((control) =>
    ["affine", "piecewise"].includes(control.action),
  );
  if (!behaviorChanged) return false;
  if (
    controls.some((control) =>
      control.behaviorKinds.some((kind) => COMPLEX_BEHAVIOR_KINDS.has(kind)),
    )
  ) {
    return true;
  }
  if (
    !sameStrings(membership.sourceUnlockDialIds, membership.targetUnlockDialIds)
  ) {
    return true;
  }
  const sourceActive = membership.sourceControlIds.filter(
    (id) => controls.find((control) => control.id === id)?.action !== "removed",
  );
  const targetActive = membership.targetControlIds.filter(
    (id) => controls.find((control) => control.id === id)?.action !== "new",
  );
  return sourceActive.length > 1 || targetActive.length > 1;
}

function evaluatePiecewiseMapping(
  mapping: Extract<RecipeExactMapping, { kind: "piecewise" }>,
  sourceValue: number,
): number | CandidateFailure {
  let direction = 0;
  for (let index = 1; index < mapping.points.length; index += 1) {
    const delta = mapping.points[index][1] - mapping.points[index - 1][1];
    if (delta === 0) {
      return candidateFailure(
        ["CANDIDATE_AMBIGUOUS"],
        "piecewise map contains a constant target segment",
      );
    }
    const nextDirection = Math.sign(delta);
    if (direction !== 0 && nextDirection !== direction) {
      return candidateFailure(
        ["CANDIDATE_AMBIGUOUS"],
        "piecewise map is non-monotonic",
      );
    }
    direction = nextDirection;
  }
  const first = mapping.points[0];
  const last = mapping.points[mapping.points.length - 1];
  if (sourceValue < first[0] || sourceValue > last[0]) {
    return candidateFailure(
      ["CANDIDATE_UNREACHABLE"],
      "source value is outside the authored piecewise domain",
    );
  }
  const exact = mapping.points.find(([input]) => input === sourceValue);
  if (exact) return normalizeFinite(exact[1], "piecewise candidate");
  for (let index = 0; index < mapping.points.length - 1; index += 1) {
    const left = mapping.points[index];
    const right = mapping.points[index + 1];
    if (sourceValue <= left[0] || sourceValue >= right[0]) continue;
    const amount = (sourceValue - left[0]) / (right[0] - left[0]);
    const candidate = left[1] + amount * (right[1] - left[1]);
    if (!isFiniteNumber(candidate)) {
      return candidateFailure(
        ["CANDIDATE_NON_FINITE"],
        "piecewise map produced a non-finite candidate",
      );
    }
    return Object.is(candidate, -0) ? 0 : candidate;
  }
  return candidateFailure(
    ["CANDIDATE_UNREACHABLE"],
    "source value has no exact piecewise segment",
  );
}

function evaluateDirectMapping(
  control: RecipeControlUpdatePlan,
  sourceValue: number,
): number | CandidateFailure {
  if (control.action === "affine") {
    const mapping = control.mapping;
    if (!mapping || mapping.kind !== "affine") {
      return candidateFailure(
        ["DEPENDENCY_MISSING"],
        `control ${control.id} has no affine map`,
      );
    }
    const value = mapping.scale * sourceValue + mapping.offset;
    if (!isFiniteNumber(value)) {
      return candidateFailure(
        ["CANDIDATE_NON_FINITE"],
        `control ${control.id} produced a non-finite affine candidate`,
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (control.action === "piecewise") {
    const mapping = control.mapping;
    if (!mapping || mapping.kind !== "piecewise") {
      return candidateFailure(
        ["DEPENDENCY_MISSING"],
        `control ${control.id} has no piecewise map`,
      );
    }
    return evaluatePiecewiseMapping(mapping, sourceValue);
  }
  return sourceValue;
}

function directResolution(
  control: RecipeControlUpdatePlan,
  sourceValue: number | null,
) {
  if (control.action === "keep") {
    return {
      resolution: "kept" as const,
      origin: "identity" as const,
      reason: "UNCHANGED_IDENTITY" as const,
      preserved: true,
    };
  }
  if (control.action === "presentation-only") {
    return {
      resolution: "presentation-updated" as const,
      origin: "identity" as const,
      reason: "PRESENTATION_ONLY" as const,
      preserved: true,
    };
  }
  if (control.action === "affine") {
    return {
      resolution: "affine-remapped" as const,
      origin: "edge-affine" as const,
      reason: "EDGE_AFFINE_CANDIDATE" as const,
      preserved: true,
    };
  }
  if (control.action === "piecewise") {
    return {
      resolution: "piecewise-remapped" as const,
      origin: "edge-piecewise" as const,
      reason: "EDGE_PIECEWISE_CANDIDATE" as const,
      preserved: true,
    };
  }
  if (control.action === "new") {
    return {
      resolution: "new-neutral" as const,
      origin: "neutral" as const,
      reason: "NEW_NEUTRAL" as const,
      preserved: true,
    };
  }
  if (control.action === "removed" && sourceValue === 0) {
    return {
      resolution: "removed-neutral" as const,
      origin: "none" as const,
      reason: "REMOVED_ZERO" as const,
      preserved: true,
    };
  }
  if (control.action === "removed") {
    return {
      resolution: "removed-active-preview" as const,
      origin: "none" as const,
      reason: "REMOVED_ACTIVE" as const,
      preserved: false,
    };
  }
  if (control.action === "reset-required") {
    return {
      resolution: "reset-to-neutral" as const,
      origin: "neutral" as const,
      reason: "RESET_REQUIRED" as const,
      preserved: false,
    };
  }
  return {
    resolution: "blocked" as const,
    origin: "none" as const,
    reason: "BLOCKED_BY_EDGE" as const,
    preserved: false,
  };
}

function rejectedControls(
  controls: RecipeControlUpdatePlan[],
  sourceState: AppearanceDialValueState,
  message: string,
): AppearanceRecipeCandidateControl[] {
  return controls.map((control) => ({
    ledgerId: control.id,
    sourceValue: Object.hasOwn(sourceState.values, control.id)
      ? sourceState.values[control.id]
      : null,
    targetValue: null,
    resolution: "blocked",
    aliasId: null,
    candidateOrigin: "none",
    reasonCode: "BLOCKED_BY_EDGE",
    message,
    requiresPreview: true,
    requiresConfirmation: false,
    preserved: false,
  }));
}

function rejectedComponent(
  componentId: string,
  membership: RecipeComponentMapMembership,
  controls: RecipeControlUpdatePlan[],
  sourceState: AppearanceDialValueState,
  codes: RecipeMigrationRejectionCode[],
  message: string,
  solver: RecipeMigrationComponentProof["solver"] = "none",
  mapSha256: string | null = null,
): AppearanceRecipeComponentCandidate {
  return {
    componentId,
    ...copyMembership(membership),
    status: "rejected",
    solver,
    branchId: null,
    componentMapSha256: mapSha256,
    authorizedCandidateCount: 0,
    candidateSha256: null,
    uniquenessMethod: "none",
    uniquenessProofSha256: null,
    values: null,
    unlockedDialIds: null,
    controls: rejectedControls(controls, sourceState, message),
    rejectionCodes: normalizeRejectionCodes(codes),
  };
}

async function hashCandidate(
  componentId: string,
  candidate: CandidateState,
): Promise<string> {
  return canonicalRecipeSha256({
    contract: "appearance-recipe-component-candidate/v1",
    componentId,
    values: Object.fromEntries(
      Object.entries(candidate.values).sort(([left], [right]) =>
        compareText(left, right),
      ),
    ),
    unlockedDialIds: [...candidate.unlockedDialIds].sort(compareText),
  });
}

async function deduplicateCandidates(
  componentId: string,
  candidates: CandidateState[],
): Promise<Array<CandidateState & { sha256: string }>> {
  const unique = new Map<string, CandidateState & { sha256: string }>();
  for (const candidate of candidates) {
    const sha256 = await hashCandidate(componentId, candidate);
    if (!unique.has(sha256)) unique.set(sha256, { ...candidate, sha256 });
  }
  return [...unique.values()].sort((left, right) =>
    compareText(left.sha256, right.sha256),
  );
}

function componentMapControls(
  controls: RecipeControlUpdatePlan[],
  sourceState: AppearanceDialValueState,
  candidate: CandidateState,
  aliases: Map<string, string>,
): AppearanceRecipeCandidateControl[] {
  return controls.map((control) => {
    const sourceValue = Object.hasOwn(sourceState.values, control.id)
      ? sourceState.values[control.id]
      : null;
    const targetValue = Object.hasOwn(candidate.values, control.id)
      ? candidate.values[control.id]
      : null;
    const aliasId = aliases.get(control.id) ?? null;
    const resolution: RecipeMigrationControlResolution = aliasId
      ? sourceValue === null
        ? "alias-target"
        : "alias-source"
      : sourceValue !== null && targetValue === null
        ? sourceValue === 0
          ? "removed-neutral"
          : "removed-component-remapped"
        : "component-remapped";
    return {
      ledgerId: control.id,
      sourceValue,
      targetValue,
      resolution,
      aliasId,
      candidateOrigin: "component-map",
      reasonCode: aliasId ? "ALIAS_COMPONENT_MAP" : "COMPONENT_MAP_CANDIDATE",
      message: control.reason,
      requiresPreview: false,
      requiresConfirmation: false,
      preserved: true,
    };
  });
}

function mapFailureCode(error: unknown): RecipeMigrationRejectionCode[] {
  const message = error instanceof Error ? error.message : String(error);
  if (/ambiguous/i.test(message)) return ["COMPONENT_MAP_DOMAIN_AMBIGUOUS"];
  if (/unreachable/i.test(message)) return ["COMPONENT_MAP_DOMAIN_GAP"];
  if (/out of range/i.test(message)) {
    return ["CANDIDATE_OUT_OF_RANGE", "IMPLICIT_CLAMP_REQUIRED"];
  }
  if (/finite/i.test(message)) return ["CANDIDATE_NON_FINITE"];
  return ["DEPENDENCY_MISSING"];
}

async function generateMappedComponent(
  componentId: string,
  membership: RecipeComponentMapMembership,
  controls: RecipeControlUpdatePlan[],
  sourceState: AppearanceDialValueState,
  targetRanges: Record<string, [number, number]>,
  map: RecipeExecutableComponentMap,
  aliases: Map<string, string>,
): Promise<AppearanceRecipeComponentCandidate> {
  if (controls.some((control) => control.action === "blocked")) {
    return rejectedComponent(
      componentId,
      membership,
      controls,
      sourceState,
      ["COMPONENT_PROOF_FAILED"],
      `component ${componentId} is blocked by its verified edge`,
      "component-map",
      map.mapSha256,
    );
  }
  const sourceValues = Object.fromEntries(
    membership.sourceControlIds.map((id) => [id, sourceState.values[id]]),
  );
  const sourceUnlocks = sourceState.unlockedDialIds.filter((id) =>
    membership.sourceUnlockDialIds.includes(id),
  );
  try {
    const evaluated = evaluateRecipeComponentMap(
      map,
      sourceValues,
      sourceUnlocks,
      { targetControlRanges: targetRanges },
    );
    const candidates = await deduplicateCandidates(componentId, [
      {
        values: evaluated.values,
        unlockedDialIds: evaluated.unlockedDialIds,
      },
    ]);
    const candidate = candidates[0]!;
    return {
      componentId,
      ...copyMembership(membership),
      status: "candidate",
      solver: "component-map",
      branchId: evaluated.branchId,
      componentMapSha256: map.mapSha256,
      authorizedCandidateCount: candidates.length,
      candidateSha256: candidate.sha256,
      uniquenessMethod: "canonical-component-map",
      uniquenessProofSha256: map.uniquenessProofSha256,
      values: candidate.values,
      unlockedDialIds: candidate.unlockedDialIds,
      controls: componentMapControls(controls, sourceState, candidate, aliases),
      rejectionCodes: [],
    };
  } catch (error) {
    return rejectedComponent(
      componentId,
      membership,
      controls,
      sourceState,
      mapFailureCode(error),
      error instanceof Error ? error.message : String(error),
      "component-map",
      map.mapSha256,
    );
  }
}

async function generateDirectComponent(
  edge: RecipeUpdateEdge,
  componentId: string,
  membership: RecipeComponentMapMembership,
  controls: RecipeControlUpdatePlan[],
  sourceState: AppearanceDialValueState,
  targetRanges: Record<string, [number, number]>,
  aliases: Map<string, string>,
): Promise<AppearanceRecipeComponentCandidate> {
  if (controls.some((control) => aliases.has(control.id))) {
    return rejectedComponent(
      componentId,
      membership,
      controls,
      sourceState,
      ["COMPONENT_MAP_MISSING"],
      `component ${componentId} contains an alias without an exact component map`,
    );
  }
  if (controls.some((control) => control.action === "blocked")) {
    return rejectedComponent(
      componentId,
      membership,
      controls,
      sourceState,
      ["COMPONENT_PROOF_FAILED"],
      `component ${componentId} is blocked by its verified edge`,
    );
  }
  if (hasUnsafeCoupledChange(controls, membership)) {
    return rejectedComponent(
      componentId,
      membership,
      controls,
      sourceState,
      ["COMPONENT_MAP_MISSING"],
      `component ${componentId} changed coupled behavior without an exact component map`,
    );
  }
  if (
    !sameStrings(membership.sourceUnlockDialIds, membership.targetUnlockDialIds)
  ) {
    return rejectedComponent(
      componentId,
      membership,
      controls,
      sourceState,
      ["COMPONENT_MAP_MISSING"],
      `component ${componentId} changed unlock ownership without an exact component map`,
    );
  }

  const values: Record<string, number> = {};
  const rows: AppearanceRecipeCandidateControl[] = [];
  const rejectionCodes: RecipeMigrationRejectionCode[] = [];
  let nonPreserved = false;
  let solver: RecipeMigrationComponentProof["solver"] = "identity";
  let failureMessage = "";

  for (const control of controls) {
    const sourceValue = Object.hasOwn(sourceState.values, control.id)
      ? sourceState.values[control.id]
      : null;
    const direct = directResolution(control, sourceValue);
    let targetValue: number | null = null;
    if (membership.targetControlIds.includes(control.id)) {
      if (control.action === "new" || control.action === "reset-required") {
        targetValue = 0;
      } else if (sourceValue !== null) {
        const mapped = evaluateDirectMapping(control, sourceValue);
        if (isCandidateFailure(mapped)) {
          rejectionCodes.push(...mapped.codes);
          failureMessage ||= mapped.message;
        } else {
          targetValue = mapped;
        }
      }
      if (targetValue !== null) {
        const range = rangeFor(targetRanges, control.id);
        if (targetValue < range[0] || targetValue > range[1]) {
          rejectionCodes.push(
            "CANDIDATE_OUT_OF_RANGE",
            "IMPLICIT_CLAMP_REQUIRED",
          );
          failureMessage ||= `control ${control.id} requires an implicit clamp`;
          targetValue = null;
        } else {
          values[control.id] = targetValue;
        }
      }
    }
    if (control.action === "affine") solver = "edge-affine";
    if (control.action === "piecewise") solver = "edge-piecewise";
    if (!direct.preserved) {
      nonPreserved = true;
      rejectionCodes.push(
        control.action === "removed"
          ? "COMPONENT_MAP_MISSING"
          : "CANDIDATE_UNREACHABLE",
      );
    }
    rows.push({
      ledgerId: control.id,
      sourceValue,
      targetValue,
      resolution: direct.resolution,
      aliasId: null,
      candidateOrigin: direct.origin,
      reasonCode: direct.reason,
      message: control.reason,
      requiresPreview: !direct.preserved,
      requiresConfirmation: !direct.preserved,
      preserved: direct.preserved,
    });
  }

  if (failureMessage) {
    return rejectedComponent(
      componentId,
      membership,
      controls,
      sourceState,
      rejectionCodes,
      failureMessage,
      solver,
    );
  }

  const unlockedDialIds = sourceState.unlockedDialIds.filter((id) =>
    membership.sourceUnlockDialIds.includes(id),
  );
  const candidates = await deduplicateCandidates(componentId, [
    { values, unlockedDialIds },
  ]);
  const candidate = candidates[0]!;
  const uniquenessMethod: RecipeMigrationComponentProof["uniquenessMethod"] =
    solver === "edge-affine" || solver === "edge-piecewise"
      ? "none"
      : controls.every((control) =>
            ["new", "removed", "reset-required"].includes(control.action),
          )
        ? "neutral"
        : "identity";
  const uniquenessProofSha256 =
    uniquenessMethod === "none"
      ? null
      : await canonicalRecipeSha256({
          contract: "appearance-recipe-candidate-uniqueness/v1",
          directEdgeKey: edge.directEdgeKey,
          edgeSha256: edge.edgeSha256,
          componentId,
          method: uniquenessMethod,
          sourceControlIds: membership.sourceControlIds,
          targetControlIds: membership.targetControlIds,
          controls: controls.map((control) => ({
            id: control.id,
            action: control.action,
            mapping: control.mapping,
            proofSha256: control.proofSha256,
          })),
          candidateSha256: candidate.sha256,
        });
  return {
    componentId,
    ...copyMembership(membership),
    status: nonPreserved ? "non-preserved" : "candidate",
    solver,
    branchId: null,
    componentMapSha256: null,
    authorizedCandidateCount: candidates.length,
    candidateSha256: candidate.sha256,
    uniquenessMethod,
    uniquenessProofSha256,
    values: candidate.values,
    unlockedDialIds: candidate.unlockedDialIds,
    controls: rows,
    rejectionCodes: normalizeRejectionCodes(rejectionCodes),
  };
}

/**
 * Generate one deterministic target candidate per union-graph component.
 * This layer never applies tolerance, clamps a value, or claims physical
 * equivalence. R2-D's physical comparator owns that later proof.
 */
export async function generateAppearanceRecipeComponentCandidates(
  input: AppearanceRecipeCandidateGeneratorInput,
): Promise<AppearanceRecipeCandidateGeneration> {
  const edge = await verifyRecipeUpdateEdge(input.edge);
  validateMemberships(input.componentMembership, edge);
  validateSourceState(input.sourceState, edge, input.componentMembership);
  validateTargetRanges(input.sourceControlRanges, {
    ...edge,
    stableIdLedger: {
      ...edge.stableIdLedger,
      toIds: edge.stableIdLedger.fromIds,
    },
  });
  validateTargetRanges(input.targetControlRanges, edge);
  const { bundle, mapsByComponent } = await validateComponentMapBundle(
    input.componentMapBundle,
    edge,
    input.componentMembership,
    input.sourceControlRanges,
    input.targetControlRanges,
  );
  const aliases = aliasesByControl(edge);
  const components: AppearanceRecipeComponentCandidate[] = [];
  for (const componentId of Object.keys(input.componentMembership).sort(
    compareText,
  )) {
    const membership = input.componentMembership[componentId];
    const controls = controlsForComponent(edge, componentId);
    const map = mapsByComponent.get(componentId);
    components.push(
      map
        ? await generateMappedComponent(
            componentId,
            membership,
            controls,
            input.sourceState,
            input.targetControlRanges,
            map,
            aliases,
          )
        : await generateDirectComponent(
            edge,
            componentId,
            membership,
            controls,
            input.sourceState,
            input.targetControlRanges,
            aliases,
          ),
    );
  }
  return {
    contract: APPEARANCE_RECIPE_CANDIDATE_GENERATOR_CONTRACT,
    directEdgeKey: edge.directEdgeKey,
    edgeSha256: edge.edgeSha256,
    componentMapBundleSha256: bundle?.bundleSha256 ?? null,
    components,
  };
}
