import {
  isFiniteNumber,
  isRecord,
  isStableId,
} from "../appearanceDials.validation";
import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  requireLowercaseSha256,
} from "./recipeCanonical";
import {
  parseRecipeSourceIdentity,
  type RecipeSourceIdentity,
} from "./packageMetadata";
import {
  buildRecipeUpdateDirectEdgeKey,
  verifyRecipeUpdateEdge,
  type RecipeUpdateEdge,
} from "./updateContracts";

export const RECIPE_COMPONENT_MAPS_CONTRACT =
  "recipe-component-maps/v1" as const;

export type RecipeComponentMapDomain = {
  controlId: string;
  minimum: number;
  maximum: number;
  minimumInclusive: boolean;
  maximumInclusive: boolean;
};

export type RecipeComponentMapUnlockState = {
  dialId: string;
  unlocked: boolean;
};

export type RecipeComponentMapTerm = {
  sourceControlId: string;
  coefficient: number;
};

export type RecipeComponentMapOutput = {
  controlId: string;
  constant: number;
  terms: RecipeComponentMapTerm[];
};

export type RecipeComponentMapBranch = {
  branchId: string;
  sourceDomain: RecipeComponentMapDomain[];
  sourceUnlockState: RecipeComponentMapUnlockState[];
  outputs: RecipeComponentMapOutput[];
  targetUnlockState: RecipeComponentMapUnlockState[];
};

export type RecipeExecutableComponentMap = {
  mapId: string;
  componentId: string;
  sourceControlIds: string[];
  targetControlIds: string[];
  sourceUnlockDialIds: string[];
  targetUnlockDialIds: string[];
  branches: RecipeComponentMapBranch[];
  auditedFixtureSha256: string;
  uniquenessProofSha256: string;
  authoredPhysicalEvidenceSha256: string;
  mapSha256: string;
};

export type RecipeComponentMapBundle = {
  contract: typeof RECIPE_COMPONENT_MAPS_CONTRACT;
  schemaVersion: 1;
  directEdgeKey: string;
  edgeSha256: string;
  fromSource: RecipeSourceIdentity;
  toSource: RecipeSourceIdentity;
  maps: RecipeExecutableComponentMap[];
  bundleSha256: string;
};

export type RecipeComponentMapMembership = {
  sourceControlIds: string[];
  targetControlIds: string[];
  sourceUnlockDialIds: string[];
  targetUnlockDialIds: string[];
};

export type RecipeComponentMapVerifierContext = {
  edge: RecipeUpdateEdge;
  sourceControlRanges: Record<string, [number, number]>;
  targetControlRanges: Record<string, [number, number]>;
  componentMembership: Record<string, RecipeComponentMapMembership>;
};

export type RecipeComponentMapEvaluationContext = {
  targetControlRanges: Record<string, [number, number]>;
};

export type RecipeComponentMapEvaluation = {
  branchId: string;
  values: Record<string, number>;
  unlockedDialIds: string[];
};

type ComponentMapBundleInput = Omit<RecipeComponentMapBundle, "bundleSha256">;
type ExecutableComponentMapInput = Omit<
  RecipeExecutableComponentMap,
  "mapSha256" | "uniquenessProofSha256"
> & {
  uniquenessProofSha256?: string;
};

function fail(message: string): never {
  throw new Error(`[${RECIPE_COMPONENT_MAPS_CONTRACT}] ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${context} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${context} must be a plain object`);
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${context} must contain exactly: ${wanted.join(", ")}`);
  }
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) fail(`${context} must be an array`);
  return value;
}

function stableId(value: unknown, context: string): string {
  if (!isStableId(value)) fail(`${context} must be a stable id`);
  return value;
}

function text(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${context} must be a non-empty string`);
  }
  return value;
}

function finite(value: unknown, context: string): number {
  if (!isFiniteNumber(value)) fail(`${context} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") fail(`${context} must be boolean`);
  return value;
}

function assertSortedUnique(values: string[], context: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] >= values[index]) {
      fail(`${context} must be sorted and unique`);
    }
  }
}

function assertUnique(values: string[], context: string): void {
  if (new Set(values).size !== values.length) {
    fail(`${context} must be unique`);
  }
}

function stableIdList(value: unknown, context: string): string[] {
  const values = array(value, context).map((entry, index) =>
    stableId(entry, `${context}[${index}]`),
  );
  assertSortedUnique(values, context);
  return values;
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

function parseDomain(value: unknown, index: number): RecipeComponentMapDomain {
  const context = `component map branch domain ${index}`;
  const raw = record(value, context);
  exactKeys(
    raw,
    ["controlId", "minimum", "maximum", "minimumInclusive", "maximumInclusive"],
    context,
  );
  const minimum = finite(raw.minimum, `${context}.minimum`);
  const maximum = finite(raw.maximum, `${context}.maximum`);
  const minimumInclusive = boolean(
    raw.minimumInclusive,
    `${context}.minimumInclusive`,
  );
  const maximumInclusive = boolean(
    raw.maximumInclusive,
    `${context}.maximumInclusive`,
  );
  if (
    minimum > maximum ||
    (minimum === maximum && !(minimumInclusive && maximumInclusive))
  ) {
    fail(`${context} has an empty range`);
  }
  return {
    controlId: stableId(raw.controlId, `${context}.controlId`),
    minimum,
    maximum,
    minimumInclusive,
    maximumInclusive,
  };
}

function parseUnlockState(
  value: unknown,
  index: number,
  contextPrefix: string,
): RecipeComponentMapUnlockState {
  const context = `${contextPrefix} ${index}`;
  const raw = record(value, context);
  exactKeys(raw, ["dialId", "unlocked"], context);
  return {
    dialId: stableId(raw.dialId, `${context}.dialId`),
    unlocked: boolean(raw.unlocked, `${context}.unlocked`),
  };
}

function parseTerm(value: unknown, index: number): RecipeComponentMapTerm {
  const context = `component map output term ${index}`;
  const raw = record(value, context);
  exactKeys(raw, ["sourceControlId", "coefficient"], context);
  const coefficient = finite(raw.coefficient, `${context}.coefficient`);
  if (coefficient === 0) fail(`${context}.coefficient may not be zero`);
  return {
    sourceControlId: stableId(
      raw.sourceControlId,
      `${context}.sourceControlId`,
    ),
    coefficient,
  };
}

function parseOutput(value: unknown, index: number): RecipeComponentMapOutput {
  const context = `component map output ${index}`;
  const raw = record(value, context);
  exactKeys(raw, ["controlId", "constant", "terms"], context);
  const terms = array(raw.terms, `${context}.terms`).map(parseTerm);
  const termIds = terms.map((term) => term.sourceControlId);
  assertSortedUnique(termIds, `${context}.terms`);
  return {
    controlId: stableId(raw.controlId, `${context}.controlId`),
    constant: finite(raw.constant, `${context}.constant`),
    terms,
  };
}

function parseBranch(value: unknown, index: number): RecipeComponentMapBranch {
  const context = `component map branch ${index}`;
  const raw = record(value, context);
  exactKeys(
    raw,
    [
      "branchId",
      "sourceDomain",
      "sourceUnlockState",
      "outputs",
      "targetUnlockState",
    ],
    context,
  );
  const sourceDomain = array(raw.sourceDomain, `${context}.sourceDomain`).map(
    parseDomain,
  );
  const sourceUnlockState = array(
    raw.sourceUnlockState,
    `${context}.sourceUnlockState`,
  ).map((entry, stateIndex) =>
    parseUnlockState(entry, stateIndex, `${context}.source unlock`),
  );
  const outputs = array(raw.outputs, `${context}.outputs`).map(parseOutput);
  const targetUnlockState = array(
    raw.targetUnlockState,
    `${context}.targetUnlockState`,
  ).map((entry, stateIndex) =>
    parseUnlockState(entry, stateIndex, `${context}.target unlock`),
  );
  assertSortedUnique(
    sourceDomain.map((entry) => entry.controlId),
    `${context}.sourceDomain`,
  );
  assertSortedUnique(
    sourceUnlockState.map((entry) => entry.dialId),
    `${context}.sourceUnlockState`,
  );
  assertSortedUnique(
    outputs.map((entry) => entry.controlId),
    `${context}.outputs`,
  );
  assertSortedUnique(
    targetUnlockState.map((entry) => entry.dialId),
    `${context}.targetUnlockState`,
  );
  return {
    branchId: stableId(raw.branchId, `${context}.branchId`),
    sourceDomain,
    sourceUnlockState,
    outputs,
    targetUnlockState,
  };
}

export function parseRecipeExecutableComponentMap(
  value: unknown,
  context = "component map",
): RecipeExecutableComponentMap {
  canonicalRecipeString(value);
  const raw = record(value, context);
  exactKeys(
    raw,
    [
      "mapId",
      "componentId",
      "sourceControlIds",
      "targetControlIds",
      "sourceUnlockDialIds",
      "targetUnlockDialIds",
      "branches",
      "auditedFixtureSha256",
      "uniquenessProofSha256",
      "authoredPhysicalEvidenceSha256",
      "mapSha256",
    ],
    context,
  );
  const sourceControlIds = stableIdList(
    raw.sourceControlIds,
    `${context}.sourceControlIds`,
  );
  const targetControlIds = stableIdList(
    raw.targetControlIds,
    `${context}.targetControlIds`,
  );
  const sourceUnlockDialIds = stableIdList(
    raw.sourceUnlockDialIds,
    `${context}.sourceUnlockDialIds`,
  );
  const targetUnlockDialIds = stableIdList(
    raw.targetUnlockDialIds,
    `${context}.targetUnlockDialIds`,
  );
  if (sourceControlIds.length === 0 || targetControlIds.length === 0) {
    fail(`${context} must map at least one source and target control`);
  }
  const branches = array(raw.branches, `${context}.branches`).map(parseBranch);
  if (branches.length === 0) fail(`${context}.branches may not be empty`);
  assertSortedUnique(
    branches.map((branch) => branch.branchId),
    `${context}.branches`,
  );
  for (const branch of branches) {
    if (
      !sameStrings(
        branch.sourceDomain.map((entry) => entry.controlId),
        sourceControlIds,
      ) ||
      !sameStrings(
        branch.outputs.map((entry) => entry.controlId),
        targetControlIds,
      ) ||
      !sameStrings(
        branch.sourceUnlockState.map((entry) => entry.dialId),
        sourceUnlockDialIds,
      ) ||
      !sameStrings(
        branch.targetUnlockState.map((entry) => entry.dialId),
        targetUnlockDialIds,
      )
    ) {
      fail(`${context} branch ${branch.branchId} is not exhaustive`);
    }
    for (const output of branch.outputs) {
      if (
        output.terms.some(
          (term) => !sourceControlIds.includes(term.sourceControlId),
        )
      ) {
        fail(
          `${context} branch ${branch.branchId} references another component`,
        );
      }
    }
  }
  return {
    mapId: stableId(raw.mapId, `${context}.mapId`),
    componentId: stableId(raw.componentId, `${context}.componentId`),
    sourceControlIds,
    targetControlIds,
    sourceUnlockDialIds,
    targetUnlockDialIds,
    branches,
    auditedFixtureSha256: requireLowercaseSha256(
      raw.auditedFixtureSha256,
      `${context}.auditedFixtureSha256`,
    ),
    uniquenessProofSha256: requireLowercaseSha256(
      raw.uniquenessProofSha256,
      `${context}.uniquenessProofSha256`,
    ),
    authoredPhysicalEvidenceSha256: requireLowercaseSha256(
      raw.authoredPhysicalEvidenceSha256,
      `${context}.authoredPhysicalEvidenceSha256`,
    ),
    mapSha256: requireLowercaseSha256(raw.mapSha256, `${context}.mapSha256`),
  };
}

export function parseRecipeComponentMapBundle(
  value: unknown,
): RecipeComponentMapBundle {
  canonicalRecipeString(value);
  const context = "component map bundle";
  const raw = record(value, context);
  exactKeys(
    raw,
    [
      "contract",
      "schemaVersion",
      "directEdgeKey",
      "edgeSha256",
      "fromSource",
      "toSource",
      "maps",
      "bundleSha256",
    ],
    context,
  );
  if (
    raw.contract !== RECIPE_COMPONENT_MAPS_CONTRACT ||
    raw.schemaVersion !== 1
  ) {
    fail(`${context} identity is invalid`);
  }
  const maps = array(raw.maps, `${context}.maps`).map((entry, index) =>
    parseRecipeExecutableComponentMap(entry, `${context}.maps[${index}]`),
  );
  assertSortedUnique(
    maps.map((map) => map.mapId),
    `${context}.maps`,
  );
  assertUnique(
    maps.map((map) => map.componentId),
    `${context}.component ids`,
  );
  return {
    contract: RECIPE_COMPONENT_MAPS_CONTRACT,
    schemaVersion: 1,
    directEdgeKey: text(raw.directEdgeKey, `${context}.directEdgeKey`),
    edgeSha256: requireLowercaseSha256(raw.edgeSha256, `${context}.edgeSha256`),
    fromSource: parseRecipeSourceIdentity(
      raw.fromSource,
      `${context}.fromSource`,
    ),
    toSource: parseRecipeSourceIdentity(raw.toSource, `${context}.toSource`),
    maps,
    bundleSha256: requireLowercaseSha256(
      raw.bundleSha256,
      `${context}.bundleSha256`,
    ),
  };
}

function mapHashContent(
  map: RecipeExecutableComponentMap,
): Omit<RecipeExecutableComponentMap, "mapSha256"> {
  const { mapSha256: _mapSha256, ...content } = map;
  return content;
}

function componentMapUniquenessContent(
  value: Omit<RecipeExecutableComponentMap, "mapSha256"> & {
    mapSha256?: string;
  },
) {
  const {
    mapSha256: _mapSha256,
    uniquenessProofSha256: _uniquenessProofSha256,
    authoredPhysicalEvidenceSha256,
    auditedFixtureSha256,
    ...mapping
  } = value;
  return {
    contract: "recipe-component-map-canonical-uniqueness/v1",
    mapping,
    auditedFixtureSha256,
    authoredPhysicalEvidenceSha256,
  };
}

/**
 * Machine-verifiable canonical authorized-candidate selection. This proves one
 * exact branch function emits one exhaustive target coordinate for a matching
 * source state. `authoredPhysicalEvidenceSha256` is provenance-only; R2's
 * runtime comparator independently proves current-state equivalence.
 */
export async function recipeComponentMapCanonicalUniquenessSha256(
  value: Omit<RecipeExecutableComponentMap, "mapSha256"> & {
    mapSha256?: string;
  },
): Promise<string> {
  return canonicalRecipeSha256(componentMapUniquenessContent(value));
}

function bundleHashContent(
  bundle: RecipeComponentMapBundle,
): Omit<RecipeComponentMapBundle, "bundleSha256"> {
  const { bundleSha256: _bundleSha256, ...content } = bundle;
  return content;
}

export async function recipeExecutableComponentMapSha256(
  value: unknown,
): Promise<string> {
  const map = parseRecipeExecutableComponentMap(value);
  return canonicalRecipeSha256(mapHashContent(map));
}

export async function recipeComponentMapBundleSha256(
  value: unknown,
): Promise<string> {
  const bundle = parseRecipeComponentMapBundle(value);
  return canonicalRecipeSha256(bundleHashContent(bundle));
}

export async function createRecipeExecutableComponentMap(
  value: ExecutableComponentMapInput,
): Promise<RecipeExecutableComponentMap> {
  canonicalRecipeString(value);
  const provisional = {
    ...value,
    uniquenessProofSha256: "0".repeat(64),
  } as Omit<RecipeExecutableComponentMap, "mapSha256">;
  const uniquenessProofSha256 =
    await recipeComponentMapCanonicalUniquenessSha256(provisional);
  if (
    value.uniquenessProofSha256 !== undefined &&
    value.uniquenessProofSha256 !== "0".repeat(64) &&
    value.uniquenessProofSha256 !== uniquenessProofSha256
  ) {
    fail("component map supplied a stale uniqueness proof hash");
  }
  const content = { ...value, uniquenessProofSha256 };
  const mapSha256 = await canonicalRecipeSha256(content);
  return parseRecipeExecutableComponentMap({ ...content, mapSha256 });
}

export async function createRecipeComponentMapBundle(
  value: ComponentMapBundleInput,
): Promise<RecipeComponentMapBundle> {
  canonicalRecipeString(value);
  const bundleSha256 = await canonicalRecipeSha256(value);
  return parseRecipeComponentMapBundle({ ...value, bundleSha256 });
}

function assertRange(
  actual: [number, number] | undefined,
  context: string,
): [number, number] {
  if (!actual || !actual.every(Number.isFinite) || actual[0] > actual[1]) {
    fail(`${context} has no valid verifier range`);
  }
  return actual;
}

export async function verifyRecipeComponentMapBundle(
  value: unknown,
  verifier: RecipeComponentMapVerifierContext,
): Promise<RecipeComponentMapBundle> {
  const bundle = parseRecipeComponentMapBundle(value);
  const edge = await verifyRecipeUpdateEdge(verifier.edge);
  const expectedDirectKey = buildRecipeUpdateDirectEdgeKey(edge.from, edge.to);
  if (
    bundle.directEdgeKey !== expectedDirectKey ||
    bundle.directEdgeKey !== edge.directEdgeKey ||
    bundle.edgeSha256 !== edge.edgeSha256 ||
    canonicalRecipeString(bundle.fromSource) !==
      canonicalRecipeString(edge.from) ||
    canonicalRecipeString(bundle.toSource) !== canonicalRecipeString(edge.to)
  ) {
    fail("bundle targets another direct edge");
  }
  for (const map of bundle.maps) {
    const actualMapSha256 = await recipeExecutableComponentMapSha256(map);
    if (actualMapSha256 !== map.mapSha256) {
      fail(`map ${map.mapId} hash mismatch`);
    }
    if (
      (await recipeComponentMapCanonicalUniquenessSha256(map)) !==
      map.uniquenessProofSha256
    ) {
      fail(`map ${map.mapId} canonical uniqueness proof mismatch`);
    }
    if (map.auditedFixtureSha256 !== edge.proof.fixtureSha256) {
      fail(`map ${map.mapId} targets another audited fixture`);
    }
    const membership = verifier.componentMembership[map.componentId];
    if (
      !membership ||
      !sameStrings(map.sourceControlIds, membership.sourceControlIds) ||
      !sameStrings(map.targetControlIds, membership.targetControlIds) ||
      !sameStrings(map.sourceUnlockDialIds, membership.sourceUnlockDialIds) ||
      !sameStrings(map.targetUnlockDialIds, membership.targetUnlockDialIds)
    ) {
      fail(`map ${map.mapId} contradicts component membership`);
    }
    for (const branch of map.branches) {
      for (const domain of branch.sourceDomain) {
        const range = assertRange(
          verifier.sourceControlRanges[domain.controlId],
          `source control ${domain.controlId}`,
        );
        if (domain.minimum < range[0] || domain.maximum > range[1]) {
          fail(
            `map ${map.mapId} branch ${branch.branchId} exceeds source range`,
          );
        }
      }
      for (const targetId of map.targetControlIds) {
        assertRange(
          verifier.targetControlRanges[targetId],
          `target control ${targetId}`,
        );
      }
    }
  }
  const actualBundleSha256 = await recipeComponentMapBundleSha256(bundle);
  if (actualBundleSha256 !== bundle.bundleSha256) {
    fail("bundle hash mismatch");
  }
  for (const alias of edge.aliases) {
    if (
      !bundle.maps.some((map) => map.mapSha256 === alias.componentMapSha256)
    ) {
      fail(`alias ${alias.fromId} -> ${alias.toId} has no executable map`);
    }
  }
  return bundle;
}

function branchMatches(
  branch: RecipeComponentMapBranch,
  values: Record<string, number>,
  unlocked: Set<string>,
): boolean {
  return (
    branch.sourceDomain.every((domain) => {
      const value = values[domain.controlId];
      if (!Number.isFinite(value)) return false;
      const aboveMinimum = domain.minimumInclusive
        ? value >= domain.minimum
        : value > domain.minimum;
      const belowMaximum = domain.maximumInclusive
        ? value <= domain.maximum
        : value < domain.maximum;
      return aboveMinimum && belowMaximum;
    }) &&
    branch.sourceUnlockState.every(
      (state) => unlocked.has(state.dialId) === state.unlocked,
    )
  );
}

export function selectRecipeComponentMapBranch(
  mapValue: unknown,
  sourceValues: Record<string, number>,
  sourceUnlockedDialIds: string[],
): RecipeComponentMapBranch {
  const map = parseRecipeExecutableComponentMap(mapValue);
  const sourceIds = Object.keys(sourceValues).sort();
  if (!sameStrings(sourceIds, map.sourceControlIds)) {
    fail(`map ${map.mapId} source values are not exhaustive`);
  }
  for (const id of sourceIds) finite(sourceValues[id], `source value ${id}`);
  const unlocks = [...sourceUnlockedDialIds];
  assertSortedUnique(unlocks, `map ${map.mapId} source unlocks`);
  if (unlocks.some((id) => !map.sourceUnlockDialIds.includes(id))) {
    fail(`map ${map.mapId} source unlocks contain another component`);
  }
  const matched = map.branches.filter((branch) =>
    branchMatches(branch, sourceValues, new Set(unlocks)),
  );
  if (matched.length === 0) fail(`map ${map.mapId} domain is unreachable`);
  if (matched.length > 1) fail(`map ${map.mapId} domain is ambiguous`);
  return matched[0];
}

export function evaluateRecipeComponentMap(
  mapValue: unknown,
  sourceValues: Record<string, number>,
  sourceUnlockedDialIds: string[],
  verifier: RecipeComponentMapEvaluationContext,
): RecipeComponentMapEvaluation {
  const map = parseRecipeExecutableComponentMap(mapValue);
  const branch = selectRecipeComponentMapBranch(
    map,
    sourceValues,
    sourceUnlockedDialIds,
  );
  const values: Record<string, number> = {};
  for (const output of branch.outputs) {
    let value = output.constant;
    for (const term of output.terms) {
      value += term.coefficient * sourceValues[term.sourceControlId];
    }
    value = finite(value, `map ${map.mapId} output ${output.controlId}`);
    const range = assertRange(
      verifier.targetControlRanges[output.controlId],
      `target control ${output.controlId}`,
    );
    if (value < range[0] || value > range[1]) {
      fail(`map ${map.mapId} output ${output.controlId} is out of range`);
    }
    values[output.controlId] = value;
  }
  return {
    branchId: branch.branchId,
    values,
    unlockedDialIds: branch.targetUnlockState
      .filter((state) => state.unlocked)
      .map((state) => state.dialId),
  };
}
