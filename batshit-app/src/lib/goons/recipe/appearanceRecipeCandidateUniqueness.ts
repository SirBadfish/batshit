import type {
  AppearanceDialDefinition,
  AppearanceDialsManifest,
} from "../appearanceDials.contracts";
import type { AppearanceRecipeComponentCandidate } from "./appearanceRecipeCandidateGenerator";
import type {
  RecipeMigrationComponentProof,
  RecipeMigrationRejectionCode,
} from "./migrationPlanContracts";
import { canonicalRecipeSha256 } from "./recipeCanonical";
import type { RecipeUpdateEdge } from "./updateContracts";

export const APPEARANCE_RECIPE_CANDIDATE_UNIQUENESS_CONTRACT =
  "appearance-recipe-candidate-uniqueness/v1" as const;

export type AppearanceRecipeCandidateUniquenessProof = {
  verified: boolean;
  authorizedCandidateCount: 0 | 1;
  selectedCandidateSha256: string | null;
  method: RecipeMigrationComponentProof["uniquenessMethod"];
  proofSha256: string | null;
  rejectionCodes: RecipeMigrationRejectionCode[];
};

type StrictPhysicalObservable =
  | {
      kind: "target-track";
      controlId: string;
      targetId: string;
      range: [number, number];
      track: Array<[number, number]>;
      influenceRange: [number, number];
      targetContentSha256: string;
    }
  | {
      kind: "root-scale";
      controlId: string;
      range: [number, number];
      scalePerUnit: number;
    }
  | {
      kind: "follower-morph" | "follower-node-scalar";
      controlId: string;
      followerId: string;
      channelId: string;
      scalar: string;
      range: [number, number];
      samples: Array<[number, number]>;
    };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function targetOwners(
  manifest: AppearanceDialsManifest,
  targetId: string,
): string[] {
  const owners: string[] = [];
  for (const dial of manifest.dials) {
    if (dial.members?.some((member) => member.target === targetId)) {
      owners.push(dial.id);
    }
    for (const side of dial.symmetry?.mode === "linked-with-offsets"
      ? [dial.symmetry.left, dial.symmetry.right]
      : []) {
      if (side.members.some((member) => member.target === targetId)) {
        owners.push(side.id);
      }
    }
  }
  for (const corner of manifest.macroEngine?.corners ?? []) {
    if (corner.target === targetId) owners.push(`macro:${corner.family}`);
  }
  return [...new Set(owners)].sort(compareText);
}

function isStrictMonotonicTrack(
  dial: AppearanceDialDefinition,
  track: Array<[number, number]>,
  influenceRange: [number, number],
): boolean {
  if (
    track.length < 2 ||
    track[0]![0] !== dial.range[0] ||
    track[track.length - 1]![0] !== dial.range[1]
  ) {
    return false;
  }
  let direction = 0;
  for (let index = 0; index < track.length; index += 1) {
    const point = track[index]!;
    if (
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1]) ||
      point[1] < influenceRange[0] ||
      point[1] > influenceRange[1] ||
      (index > 0 && point[0] <= track[index - 1]![0])
    ) {
      return false;
    }
    if (index === 0) continue;
    const nextDirection = Math.sign(point[1] - track[index - 1]![1]);
    if (
      nextDirection === 0 ||
      (direction !== 0 && nextDirection !== direction)
    ) {
      return false;
    }
    direction = nextDirection;
  }
  return direction !== 0;
}

function isStrictMonotonicSamples(
  range: [number, number],
  samples: Array<[number, number]>,
): boolean {
  if (
    samples.length < 2 ||
    samples[0]![0] !== range[0] ||
    samples[samples.length - 1]![0] !== range[1]
  ) {
    return false;
  }
  let direction = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    if (
      !Number.isFinite(sample[0]) ||
      !Number.isFinite(sample[1]) ||
      (index > 0 && sample[0] <= samples[index - 1]![0])
    ) {
      return false;
    }
    if (index === 0) continue;
    const nextDirection = Math.sign(sample[1] - samples[index - 1]![1]);
    if (
      nextDirection === 0 ||
      (direction !== 0 && nextDirection !== direction)
    ) {
      return false;
    }
    direction = nextDirection;
  }
  return direction !== 0;
}

async function strictPhysicalObservable(
  manifest: AppearanceDialsManifest,
  controlId: string,
): Promise<StrictPhysicalObservable | null> {
  const dial = manifest.dials.find((entry) => entry.id === controlId);
  if (!dial) return null;
  const scalePerUnit = dial.scalePerUnit;
  if (
    dial.kind === "root-scale" &&
    Number.isFinite(scalePerUnit) &&
    scalePerUnit !== undefined &&
    scalePerUnit !== 0 &&
    manifest.dials.filter((entry) => entry.kind === "root-scale").length === 1
  ) {
    return {
      kind: "root-scale",
      controlId,
      range: [...dial.range],
      scalePerUnit,
    };
  }
  if (dial.kind === "follower-only") {
    const followerCandidates: StrictPhysicalObservable[] = [];
    for (const [followerId, follower] of Object.entries(manifest.followers)) {
      for (const driver of follower.drivers) {
        if (driver.driver.kind !== "dial" || driver.driver.id !== controlId) {
          continue;
        }
        for (const channel of driver.channels) {
          if (channel.kind === "morph-weight") {
            const samples = channel.samples.map(
              ([input, weight]) => [input, weight] as [number, number],
            );
            if (isStrictMonotonicSamples(dial.range, samples)) {
              followerCandidates.push({
                kind: "follower-morph",
                controlId,
                followerId,
                channelId: channel.id,
                scalar: "weight",
                range: [...dial.range],
                samples,
              });
            }
            continue;
          }
          const scalarSeries = [
            ...(["translation", "scale", "pivot"] as const).flatMap((field) =>
              [0, 1, 2].map(
                (component) =>
                  ({
                    scalar: `${field}[${component}]`,
                    samples: channel.samples.map(
                      (sample) =>
                        [sample.input, sample[field][component]] as [
                          number,
                          number,
                        ],
                    ),
                  }) as const,
              ),
            ),
          ];
          for (const series of scalarSeries) {
            if (!isStrictMonotonicSamples(dial.range, series.samples)) {
              continue;
            }
            followerCandidates.push({
              kind: "follower-node-scalar",
              controlId,
              followerId,
              channelId: channel.id,
              scalar: series.scalar,
              range: [...dial.range],
              samples: series.samples,
            });
          }
        }
      }
    }
    followerCandidates.sort((left, right) =>
      compareText(JSON.stringify(left), JSON.stringify(right)),
    );
    return followerCandidates[0] ?? null;
  }
  if (dial.kind !== "tracks" || !dial.members) return null;
  const candidates: Array<
    Extract<StrictPhysicalObservable, { kind: "target-track" }>
  > = [];
  for (const member of dial.members) {
    const target = manifest.targets[member.target];
    if (
      !target ||
      target.combine !== "exclusive" ||
      !isStrictMonotonicTrack(dial, member.track, [
        target.influenceMin,
        target.influenceMax,
      ]) ||
      targetOwners(manifest, member.target).join("\u0000") !== controlId
    ) {
      continue;
    }
    candidates.push({
      kind: "target-track",
      controlId,
      targetId: member.target,
      range: [...dial.range],
      track: member.track.map((point) => [...point]),
      influenceRange: [target.influenceMin, target.influenceMax],
      targetContentSha256: target.provenance.contentSha256,
    });
  }
  candidates.sort((left, right) => compareText(left.targetId, right.targetId));
  return candidates[0] ?? null;
}

const failed = (): AppearanceRecipeCandidateUniquenessProof => ({
  verified: false,
  authorizedCandidateCount: 0,
  selectedCandidateSha256: null,
  method: "none",
  proofSha256: null,
  rejectionCodes: ["CANDIDATE_UNIQUENESS_UNPROVEN"],
});

/**
 * Convert a generated coordinate into a machine-verifiable authorized-
 * candidate claim. This is deliberately not a claim that the target physical
 * function has only one mathematical preimage. Stable identity/neutral policy
 * and canonical component maps select one contract-authorized coordinate;
 * R2's component and whole-Recipe comparators independently prove its physical
 * equivalence. Direct affine/piecewise remaps without a component map require
 * one strict physical observable (track, root-scale law, or follower channel).
 */
export async function proveAppearanceRecipeCandidateUniqueness(
  edge: RecipeUpdateEdge,
  targetManifest: AppearanceDialsManifest,
  candidate: AppearanceRecipeComponentCandidate,
): Promise<AppearanceRecipeCandidateUniquenessProof> {
  if (
    candidate.status === "rejected" ||
    candidate.candidateSha256 === null ||
    candidate.authorizedCandidateCount !== 1
  ) {
    return failed();
  }

  if (
    candidate.solver === "edge-affine" ||
    candidate.solver === "edge-piecewise"
  ) {
    if (
      candidate.targetControlIds.length !== 1 ||
      candidate.targetUnlockDialIds.length !== 0
    ) {
      return failed();
    }
    const observable = await strictPhysicalObservable(
      targetManifest,
      candidate.targetControlIds[0]!,
    );
    if (!observable) return failed();
    const method =
      candidate.solver === "edge-affine"
        ? ("exact-affine" as const)
        : ("exact-piecewise" as const);
    const proofSha256 = await canonicalRecipeSha256({
      contract: APPEARANCE_RECIPE_CANDIDATE_UNIQUENESS_CONTRACT,
      directEdgeKey: edge.directEdgeKey,
      edgeSha256: edge.edgeSha256,
      componentId: candidate.componentId,
      method,
      candidateSha256: candidate.candidateSha256,
      observable,
    });
    return {
      verified: true,
      authorizedCandidateCount: 1,
      selectedCandidateSha256: candidate.candidateSha256,
      method,
      proofSha256,
      rejectionCodes: [],
    };
  }

  const policyAuthorized =
    candidate.solver === "identity" &&
    ["identity", "neutral"].includes(candidate.uniquenessMethod);
  const componentMapAuthorized =
    candidate.solver === "component-map" &&
    candidate.componentMapSha256 !== null &&
    candidate.uniquenessMethod === "canonical-component-map";
  if (
    (!policyAuthorized && !componentMapAuthorized) ||
    candidate.uniquenessProofSha256 === null
  ) {
    return failed();
  }
  return {
    verified: true,
    authorizedCandidateCount: 1,
    selectedCandidateSha256: candidate.candidateSha256,
    method: candidate.uniquenessMethod,
    proofSha256: candidate.uniquenessProofSha256,
    rejectionCodes: [],
  };
}
