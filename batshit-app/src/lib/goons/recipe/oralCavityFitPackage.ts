import type { ResolvedAppearanceDialState } from "../appearanceDials.contracts";
import {
  createOralCavityFitDefinition,
  parseOralCavityFitDefinition,
  type OralCavityFitDefinitionV1,
  type OralCavityFitLandmarkSetId,
  type OralCavityFitPoint,
} from "./oralCavityFit";
import {
  canonicalRecipeSha256,
  requireLowercaseSha256,
} from "./recipeCanonical";

export const ORAL_CAVITY_LANDMARK_BASIS_CONTRACT =
  "oral-cavity-landmark-basis/v1" as const;
export const ORAL_CAVITY_FIT_PACKAGE_CONTRACT =
  "oral-cavity-fit-package/v1" as const;

export type OralCavityLandmarkTargetDelta = {
  targetId: string;
  deltasRoot: OralCavityFitPoint[];
};

export type OralCavityLandmarkFrameBasis = {
  id: OralCavityFitLandmarkSetId;
  neutralPositionsRoot: OralCavityFitPoint[];
  targetDeltas: OralCavityLandmarkTargetDelta[];
};

export type OralCavityLandmarkBasisV1 = {
  contract: typeof ORAL_CAVITY_LANDMARK_BASIS_CONTRACT;
  frames: OralCavityLandmarkFrameBasis[];
  targetIds: string[];
  definitionSha256: string;
};

export type OralCavityFitPackageV1 = {
  contract: typeof ORAL_CAVITY_FIT_PACKAGE_CONTRACT;
  definition: OralCavityFitDefinitionV1;
  landmarkBasis: OralCavityLandmarkBasisV1;
  definitionSha256: string;
};

type LandmarkBasisPayload = Omit<
  OralCavityLandmarkBasisV1,
  "definitionSha256"
>;
type OralPackagePayload = Omit<OralCavityFitPackageV1, "definitionSha256">;

const FRAME_IDS: OralCavityFitLandmarkSetId[] = ["lower", "tongue", "upper"];
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export class OralCavityFitPackageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OralCavityFitPackageError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new OralCavityFitPackageError(
    code,
    `[${ORAL_CAVITY_FIT_PACKAGE_CONTRACT}] ${message}`,
  );
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-package", `${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((entry, index) => entry !== canonical[index])
  ) {
    fail(
      "invalid-package",
      `${context} must contain exactly: ${canonical.join(", ")}`,
    );
  }
}

function stableId(value: unknown, context: string): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !STABLE_ID_PATTERN.test(value)
  ) {
    fail("invalid-package", `${context} must be a stable id`);
  }
  return value;
}

function point(value: unknown, context: string): OralCavityFitPoint {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    fail("invalid-package", `${context} must contain three finite coordinates`);
  }
  return value.map((entry) => {
    const normalized = Math.fround(entry);
    return Object.is(normalized, -0) ? 0 : normalized;
  }) as OralCavityFitPoint;
}

function sortedUnique<T>(
  rows: T[],
  key: (row: T) => string,
  context: string,
): T[] {
  const ids = rows.map(key);
  const sorted = [...ids].sort((left, right) => left.localeCompare(right));
  if (ids.some((entry, index) => entry !== sorted[index])) {
    fail("invalid-package", `${context} must use ascending stable-id order`);
  }
  const duplicate = ids.find(
    (entry, index) => index > 0 && entry === ids[index - 1],
  );
  if (duplicate) fail("invalid-package", `${context} duplicates ${duplicate}`);
  return rows;
}

function parseTargetDelta(
  value: unknown,
  context: string,
  pointCount: number,
): OralCavityLandmarkTargetDelta {
  const raw = record(value, context);
  exactKeys(raw, ["targetId", "deltasRoot"], context);
  if (!Array.isArray(raw.deltasRoot) || raw.deltasRoot.length !== pointCount) {
    fail(
      "invalid-package",
      `${context}.deltasRoot must match the frame's ${pointCount} landmarks`,
    );
  }
  const deltasRoot = raw.deltasRoot.map((entry, index) =>
    point(entry, `${context}.deltasRoot[${index}]`),
  );
  if (!deltasRoot.some((entry) => entry.some((scalar) => scalar !== 0))) {
    fail("invalid-package", `${context} must carry a nonzero landmark delta`);
  }
  return {
    targetId: stableId(raw.targetId, `${context}.targetId`),
    deltasRoot,
  };
}

function parseFrame(
  value: unknown,
  index: number,
): OralCavityLandmarkFrameBasis {
  const context = `landmarkBasis.frames[${index}]`;
  const raw = record(value, context);
  exactKeys(raw, ["id", "neutralPositionsRoot", "targetDeltas"], context);
  if (raw.id !== "lower" && raw.id !== "tongue" && raw.id !== "upper") {
    fail("invalid-package", `${context}.id must be lower, tongue, or upper`);
  }
  if (
    !Array.isArray(raw.neutralPositionsRoot) ||
    raw.neutralPositionsRoot.length < 4
  ) {
    fail(
      "invalid-package",
      `${context}.neutralPositionsRoot must contain at least four landmarks`,
    );
  }
  const neutralPositionsRoot = raw.neutralPositionsRoot.map((entry, pointIndex) =>
    point(entry, `${context}.neutralPositionsRoot[${pointIndex}]`),
  );
  if (!Array.isArray(raw.targetDeltas)) {
    fail("invalid-package", `${context}.targetDeltas must be an array`);
  }
  const targetDeltas = sortedUnique(
    raw.targetDeltas.map((entry, targetIndex) =>
      parseTargetDelta(
        entry,
        `${context}.targetDeltas[${targetIndex}]`,
        neutralPositionsRoot.length,
      ),
    ),
    (entry) => entry.targetId,
    `${context}.targetDeltas`,
  );
  return { id: raw.id, neutralPositionsRoot, targetDeltas };
}

function parseBasisPayload(value: unknown): LandmarkBasisPayload {
  const raw = record(value, "Oral Cavity landmark basis");
  exactKeys(raw, ["contract", "frames", "targetIds"], "Oral Cavity landmark basis");
  if (raw.contract !== ORAL_CAVITY_LANDMARK_BASIS_CONTRACT) {
    fail("invalid-package", "landmark basis contract is unsupported");
  }
  if (!Array.isArray(raw.frames) || raw.frames.length !== 3) {
    fail("invalid-package", "landmark basis must contain lower, tongue, and upper frames");
  }
  const frames = sortedUnique(
    raw.frames.map(parseFrame),
    (entry) => entry.id,
    "landmarkBasis.frames",
  );
  if (frames.some((entry, index) => entry.id !== FRAME_IDS[index])) {
    fail("invalid-package", "landmark basis must contain exactly lower, tongue, and upper");
  }
  if (!Array.isArray(raw.targetIds)) {
    fail("invalid-package", "landmarkBasis.targetIds must be an array");
  }
  const targetIds = sortedUnique(
    raw.targetIds.map((entry, index) =>
      stableId(entry, `landmarkBasis.targetIds[${index}]`),
    ),
    (entry) => entry,
    "landmarkBasis.targetIds",
  );
  const actualTargets = [...new Set(
    frames.flatMap((frame) => frame.targetDeltas.map((entry) => entry.targetId)),
  )].sort((left, right) => left.localeCompare(right));
  if (
    targetIds.length === 0 ||
    targetIds.length !== actualTargets.length ||
    targetIds.some((entry, index) => entry !== actualTargets[index])
  ) {
    fail(
      "invalid-package",
      "landmarkBasis.targetIds must exactly index every nonzero frame target",
    );
  }
  return {
    contract: ORAL_CAVITY_LANDMARK_BASIS_CONTRACT,
    frames,
    targetIds,
  };
}

export async function createOralCavityLandmarkBasis(
  value: Omit<LandmarkBasisPayload, "contract" | "targetIds">,
): Promise<OralCavityLandmarkBasisV1> {
  const frames = [...value.frames]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((frame) => ({
      ...frame,
      targetDeltas: [...frame.targetDeltas].sort((left, right) =>
        left.targetId.localeCompare(right.targetId),
      ),
    }));
  const targetIds = [...new Set(
    frames.flatMap((frame) => frame.targetDeltas.map((entry) => entry.targetId)),
  )].sort((left, right) => left.localeCompare(right));
  const payload = parseBasisPayload({
    contract: ORAL_CAVITY_LANDMARK_BASIS_CONTRACT,
    frames,
    targetIds,
  });
  return { ...payload, definitionSha256: await canonicalRecipeSha256(payload) };
}

export async function parseOralCavityLandmarkBasis(
  value: unknown,
): Promise<OralCavityLandmarkBasisV1> {
  const raw = record(value, "Oral Cavity landmark basis");
  exactKeys(
    raw,
    ["contract", "frames", "targetIds", "definitionSha256"],
    "Oral Cavity landmark basis",
  );
  const { definitionSha256: claimed, ...payloadValue } = raw;
  const payload = parseBasisPayload(payloadValue);
  const definitionSha256 = requireLowercaseSha256(
    claimed,
    "Oral Cavity landmark basis definitionSha256",
  );
  if (definitionSha256 !== (await canonicalRecipeSha256(payload))) {
    fail("stale-package", "landmark basis definitionSha256 is stale");
  }
  return { ...payload, definitionSha256 };
}

function assertPackageCoherence(
  definition: OralCavityFitDefinitionV1,
  basis: OralCavityLandmarkBasisV1,
) {
  let offset = 0;
  for (const frame of basis.frames) {
    const landmarkSet = definition.landmarkSets.find((entry) => entry.id === frame.id);
    if (!landmarkSet) fail("invalid-package", `definition lacks ${frame.id} landmarks`);
    if (landmarkSet.bindings.length !== frame.neutralPositionsRoot.length) {
      fail(
        "invalid-package",
        `${frame.id} definition/basis landmark counts differ`,
      );
    }
    for (let index = 0; index < landmarkSet.bindings.length; index += 1) {
      const binding = landmarkSet.bindings[index]!;
      if (
        binding.kind !== "vertex" ||
        binding.vertexIndex !== offset + index
      ) {
        fail(
          "invalid-package",
          `${frame.id} bindings must index the exact packed landmark stream`,
        );
      }
    }
    offset += frame.neutralPositionsRoot.length;
  }
}

export async function createOralCavityFitPackage(value: {
  definition:
    | Parameters<typeof createOralCavityFitDefinition>[0]
    | OralCavityFitDefinitionV1;
  landmarkBasis: OralCavityLandmarkBasisV1;
}): Promise<OralCavityFitPackageV1> {
  const definition = "definitionSha256" in value.definition
    ? await parseOralCavityFitDefinition(value.definition)
    : await createOralCavityFitDefinition(value.definition);
  const landmarkBasis = await parseOralCavityLandmarkBasis(value.landmarkBasis);
  assertPackageCoherence(definition, landmarkBasis);
  const payload: OralPackagePayload = {
    contract: ORAL_CAVITY_FIT_PACKAGE_CONTRACT,
    definition,
    landmarkBasis,
  };
  return { ...payload, definitionSha256: await canonicalRecipeSha256(payload) };
}

export async function parseOralCavityFitPackage(
  value: unknown,
): Promise<OralCavityFitPackageV1> {
  const raw = record(value, "Oral Cavity Fit package");
  exactKeys(
    raw,
    ["contract", "definition", "landmarkBasis", "definitionSha256"],
    "Oral Cavity Fit package",
  );
  if (raw.contract !== ORAL_CAVITY_FIT_PACKAGE_CONTRACT) {
    fail("invalid-package", "package contract is unsupported");
  }
  const [definition, landmarkBasis] = await Promise.all([
    parseOralCavityFitDefinition(raw.definition),
    parseOralCavityLandmarkBasis(raw.landmarkBasis),
  ]);
  assertPackageCoherence(definition, landmarkBasis);
  const payload: OralPackagePayload = {
    contract: ORAL_CAVITY_FIT_PACKAGE_CONTRACT,
    definition,
    landmarkBasis,
  };
  const definitionSha256 = requireLowercaseSha256(
    raw.definitionSha256,
    "Oral Cavity Fit package definitionSha256",
  );
  if (definitionSha256 !== (await canonicalRecipeSha256(payload))) {
    fail("stale-package", "package definitionSha256 is stale");
  }
  return { ...payload, definitionSha256 };
}

/** Compose exact hidden oral landmarks from the final resolved target influences. */
export function composeOralCavityLandmarkPositions(
  basis: OralCavityLandmarkBasisV1,
  resolved: Pick<ResolvedAppearanceDialState, "influences">,
): Float32Array {
  const positions: number[] = [];
  for (const frame of basis.frames) {
    const composed = frame.neutralPositionsRoot.map(
      (entry) => [...entry] as OralCavityFitPoint,
    );
    for (const target of frame.targetDeltas) {
      const influence = resolved.influences.get(target.targetId);
      if (influence === undefined || !Number.isFinite(influence)) {
        fail(
          "missing-target",
          `resolved Appearance state lacks landmark target ${target.targetId}`,
        );
      }
      if (influence === 0) continue;
      for (let pointIndex = 0; pointIndex < composed.length; pointIndex += 1) {
        const point = composed[pointIndex]!;
        const delta = target.deltasRoot[pointIndex]!;
        point[0] += delta[0] * influence;
        point[1] += delta[1] * influence;
        point[2] += delta[2] * influence;
      }
    }
    positions.push(...composed.flat());
  }
  return new Float32Array(positions);
}
