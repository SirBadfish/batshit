import * as THREE from "three";

import type { AppearanceDialValueState } from "$lib/goons/appearanceDials.contracts";
import { parseAppearanceDialsManifest } from "$lib/goons/appearanceDials.schema";
import { resolveCustomPerformanceRigManifest } from "$lib/goons/customPerformanceRig";
import type {
  HairImportAuthoringInput,
  HairImportClumpReviewInput,
  HairImportColliderInput,
  HairImportFollowerDriverInput,
  HairImportMotionRegionSelection,
} from "$lib/goons/hairImportAuthoring";
import type { HairImportCanonicalizationV1 } from "$lib/goons/hairImportIntake";
import type { HairMotionPaintV1 } from "$lib/goons/hairMotionPaint";
import {
  parseSemanticGlb,
  resolveSemanticGlbNode,
  resolveSemanticGlbNodeTransform,
  semanticGlbRuntimeNodeName,
} from "$lib/goons/recipe/semanticGlb";
import { sha256Hex } from "$lib/goons/recipe/recipeCanonical";
import { verifyGoonRecipeV2 } from "$lib/goons/recipe";

import { getOwnedRecipeGoon } from "./goonRecipeRepository.server";
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl,
} from "./batshitServerUrls";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export type HairImportRecipeContext = {
  recipeSourceGlb: Uint8Array;
  appearanceManifest: Record<string, unknown>;
  recipeSource: Awaited<
    ReturnType<typeof verifyGoonRecipeV2>
  >["authoringRevision"]["source"]["identities"];
  bodyManifestNodeId: string;
  headRigNode: string;
  neckRigNode: string;
  authoredRootMatrix: number[];
};

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be one JSON object.`);
  }
  return value as Record<string, unknown>;
}

async function readRecipeAsset(
  ref: { ref: string; sha256: string },
  context: string,
) {
  if (!ref.ref.startsWith("/uploads/")) {
    throw new Error(`${context} is outside the owned Recipe upload boundary.`);
  }
  const response = await fetch(`${getInternalBatshitServerUrl()}${ref.ref}`, {
    headers: getInternalBatshitServerAuthHeaders(),
  });
  if (!response.ok)
    throw new Error(`${context} could not be read (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if ((await sha256Hex(bytes)) !== ref.sha256) {
    throw new Error(
      `${context} no longer matches its immutable Recipe receipt.`,
    );
  }
  return bytes;
}

function nodeWorldMatrix(
  parsed: ReturnType<typeof parseSemanticGlb>,
  nodeIndex: number,
) {
  const chain: number[] = [];
  let cursor: number | undefined = nodeIndex;
  while (cursor !== undefined) {
    chain.unshift(cursor);
    cursor = parsed.parents.get(cursor);
  }
  const world = new THREE.Matrix4();
  for (const index of chain) {
    world.multiply(
      new THREE.Matrix4().fromArray(
        resolveSemanticGlbNodeTransform(
          parsed.nodes[index]!,
          `Recipe node ${index}`,
          {
            diagnosticPrefix: "hair-import-recipe-context/v1",
          },
        ).matrix,
      ),
    );
  }
  return world;
}

function resolveRequiredRigNode(
  performance: NonNullable<
    ReturnType<typeof resolveCustomPerformanceRigManifest>["manifest"]
  >,
  role: "head" | "neck",
) {
  const node = performance.nodes[role]?.node;
  if (!node)
    throw new Error(
      `Recipe rig.performance.nodes.${role}.node is required for Hair import.`,
    );
  return node;
}

export async function loadHairImportRecipeContext(
  userId: string,
  goonId: string,
): Promise<HairImportRecipeContext> {
  const goon = await getOwnedRecipeGoon(userId, goonId);
  const owner = await verifyGoonRecipeV2(goon.recipe);
  const source = owner.authoringRevision.source;
  const [recipeSourceGlb, manifestBytes] = await Promise.all([
    readRecipeAsset(source.model, "Recipe source model"),
    readRecipeAsset(source.manifest, "Recipe source manifest"),
  ]);
  const appearanceManifest = record(
    JSON.parse(UTF8.decode(manifestBytes)) as unknown,
    "Recipe source manifest",
  );
  const appearance = parseAppearanceDialsManifest(appearanceManifest);
  if (!appearance)
    throw new Error("Recipe source manifest is missing appearance-dials/v2.");
  if (appearance.definitionSha256 !== source.identities.definitionSha256) {
    throw new Error(
      "Recipe source manifest does not match the active Appearance definition.",
    );
  }
  const bodyNodes = Object.entries(appearance.nodes).filter(
    ([, declaration]) =>
      declaration.kind === "mesh" && declaration.role === "body",
  );
  if (bodyNodes.length !== 1) {
    throw new Error(
      "Recipe source must declare exactly one Appearance body mesh for Hair import.",
    );
  }
  const rawRig = record(appearanceManifest.rig, "Recipe rig");
  const performance = resolveCustomPerformanceRigManifest(rawRig.performance);
  if (performance.issues.length > 0 || !performance.manifest) {
    throw new Error(
      performance.issues[0] ??
        "Recipe source has no complete performance rig for Hair import.",
    );
  }
  const headRigNode = resolveRequiredRigNode(performance.manifest, "head");
  const neckRigNode = resolveRequiredRigNode(performance.manifest, "neck");
  const parsed = parseSemanticGlb(recipeSourceGlb, {
    diagnosticPrefix: "hair-import-recipe-context/v1",
  });
  resolveSemanticGlbNode(parsed, bodyNodes[0]![1].node, "Appearance body mesh");
  const headIndex = resolveSemanticGlbNode(
    parsed,
    headRigNode,
    "performance head node",
  );
  resolveSemanticGlbNode(parsed, neckRigNode, "performance neck node");
  const authoredRootMatrix = nodeWorldMatrix(parsed, headIndex)
    .invert()
    .elements.map((value) => (Object.is(value, -0) ? 0 : value));
  return {
    recipeSourceGlb,
    appearanceManifest,
    recipeSource: source.identities,
    bodyManifestNodeId: bodyNodes[0]![0],
    headRigNode,
    neckRigNode,
    authoredRootMatrix,
  };
}

function dialDrivers(
  appearanceManifest: Record<string, unknown>,
): HairImportFollowerDriverInput[] {
  const manifest = parseAppearanceDialsManifest(appearanceManifest);
  if (!manifest)
    throw new Error("Recipe source manifest is missing appearance-dials/v2.");
  const profiles = new Map<
    string,
    HairImportFollowerDriverInput["falloffProfile"]
  >([
    ["head_size", "global-head"],
    ["head_projection", "global-head"],
    ["cranium_depth", "scalp-shape"],
    ["square_head_shape", "scalp-shape"],
    ["rectangular_head_shape", "scalp-shape"],
    ["forehead_height", "local-clearance"],
    ["temple_width", "local-clearance"],
    ["trap_slope", "local-clearance"],
  ]);
  const drivers: HairImportFollowerDriverInput[] = [];
  for (const [dialId, falloffProfile] of profiles) {
    const dial = manifest.dials.find((entry) => entry.id === dialId);
    if (!dial) continue;
    for (const endpoint of [...new Set(dial.range)].filter(
      (value) => value !== 0,
    )) {
      drivers.push({ dialId, endpoint, falloffProfile });
    }
  }
  const headSize = drivers.filter((entry) => entry.dialId === "head_size");
  if (
    !headSize.some((entry) => entry.endpoint < 0) ||
    !headSize.some((entry) => entry.endpoint > 0)
  ) {
    throw new Error(
      "Recipe source must expose both Head Size endpoints for Hair import.",
    );
  }
  return drivers;
}

function responsiveColliderDrivers(
  appearanceManifest: Record<string, unknown>,
  dialId: string,
  geometry: (
    direction: -1 | 1,
  ) => Omit<
    NonNullable<HairImportColliderInput["drivers"]>[number],
    "dialId" | "endpoint"
  >,
) {
  const manifest = parseAppearanceDialsManifest(appearanceManifest);
  if (!manifest)
    throw new Error("Recipe source manifest is missing appearance-dials/v2.");
  const dial = manifest.dials.find((entry) => entry.id === dialId);
  if (!dial) return [];
  return [...new Set(dial.range)]
    .filter((endpoint) => endpoint !== 0)
    .map((endpoint) => ({
      dialId,
      endpoint,
      ...geometry(endpoint < 0 ? -1 : 1),
    }));
}

export function proposeHairImportAuthoringInput(input: {
  canonical: HairImportCanonicalizationV1;
  context: HairImportRecipeContext;
  assetId: string;
  revisionId: string;
  reviewedAppearanceState?: AppearanceDialValueState | null;
  motionRegionSelections?: HairImportMotionRegionSelection[];
  motionPaint?: HairMotionPaintV1;
}): HairImportAuthoringInput {
  const parsedHair = parseSemanticGlb(input.canonical.glbBytes, {
    diagnosticPrefix: "hair-import-proposal/v1",
  });
  const meshNodes = parsedHair.nodes
    .map((node, index) => ({ node, index }))
    .filter((entry) => entry.node.mesh !== undefined);
  if (meshNodes.length !== input.canonical.geometry.meshCount) {
    throw new Error("Canonical Hair mesh inventory changed before authoring.");
  }
  const clumps: HairImportClumpReviewInput[] = meshNodes.map(
    ({ node }, index) => ({
      id: `clump-${String(index + 1).padStart(3, "0")}`,
      meshNode: semanticGlbRuntimeNodeName(String(node.name)),
      collisionGroups: ["head", "upper-body"],
      maximumConnectedComponents: 8,
    }),
  );
  const colliders: HairImportColliderInput[] = [
    {
      id: "head-shell",
      group: "head",
      shape: "sphere",
      node: input.context.headRigNode,
      offset: [0, 0.08, 0.03],
      tailOffset: [0, 0.08, 0.03],
      radius: 0.17,
      drivers: responsiveColliderDrivers(
        input.context.appearanceManifest,
        "head_size",
        (direction) => ({
          offsetDelta: [0, 0, 0],
          tailOffsetDelta: [0, 0, 0],
          radiusDelta: direction * 0.02,
        }),
      ),
    },
    {
      id: "neck-clearance",
      group: "upper-body",
      shape: "capsule",
      node: input.context.neckRigNode,
      offset: [0, 0, 0],
      tailOffset: [0, 0.12, 0],
      radius: 0.085,
      drivers: [
        ...responsiveColliderDrivers(
          input.context.appearanceManifest,
          "neck_thickness",
          (direction) => ({
            offsetDelta: [0, 0, 0],
            tailOffsetDelta: [0, 0, 0],
            radiusDelta: direction * 0.025,
          }),
        ),
        ...responsiveColliderDrivers(
          input.context.appearanceManifest,
          "neck_projection",
          (direction) => ({
            offsetDelta: [0, 0, direction * 0.015],
            tailOffsetDelta: [0, 0, direction * 0.015],
            radiusDelta: 0,
          }),
        ),
      ],
    },
    {
      id: "shoulder-chest-clearance",
      group: "upper-body",
      shape: "capsule",
      manifestNodeId: input.context.bodyManifestNodeId,
      offset: [-0.24, 1.31, 0.035],
      tailOffset: [0.48, 0, 0],
      radius: 0.11,
      drivers: [
        ...responsiveColliderDrivers(
          input.context.appearanceManifest,
          "shoulder_distance",
          (direction) => ({
            offsetDelta: [-direction * 0.04, 0, 0],
            tailOffsetDelta: [direction * 0.08, 0, 0],
            radiusDelta: direction * 0.005,
          }),
        ),
        ...responsiveColliderDrivers(
          input.context.appearanceManifest,
          "trap_slope",
          (direction) => ({
            offsetDelta: [0, direction * 0.02, 0],
            tailOffsetDelta: [0, 0, 0],
            radiusDelta: direction * 0.005,
          }),
        ),
      ],
    },
  ];
  const headWorld = new THREE.Matrix4()
    .fromArray(input.context.authoredRootMatrix)
    .invert();
  const head = new THREE.Vector3().setFromMatrixPosition(headWorld);
  return {
    canonicalHairGlb: input.canonical.glbBytes,
    recipeSourceGlb: input.context.recipeSourceGlb,
    appearanceManifest: input.context.appearanceManifest,
    owner: {
      assetId: input.assetId,
      revisionId: input.revisionId,
      fitFamily: input.context.recipeSource.fitFamily,
    },
    recipeNodes: {
      bodyManifestNodeId: input.context.bodyManifestNodeId,
      headRigNode: input.context.headRigNode,
    },
    fit: {
      authoredRootMatrix: input.context.authoredRootMatrix,
      minimumScale: 0.01,
      maximumScale: 100,
      maximumAxisScaleRatio: 4,
    },
    reviewedAppearanceState: input.reviewedAppearanceState ?? null,
    scalp: {
      rootBounds: {
        minimum: [head.x - 0.32, head.y - 0.19, head.z - 0.28],
        maximum: [head.x + 0.32, head.y + 0.22, head.z + 0.32],
      },
      transferBounds: {
        minimum: [head.x - 0.37, head.y - 0.31, head.z - 0.33],
        maximum: [head.x + 0.37, head.y + 0.23, head.z + 0.37],
      },
      rootSeedFraction: 0.04,
      maximumRootDistance: 0.25,
    },
    followerDrivers: dialDrivers(input.context.appearanceManifest),
    clumps,
    colliders,
    motion: {
      anchoredLength: 0.5,
      defaultIntensity: 1,
      ...(input.motionRegionSelections
        ? { regionSelections: input.motionRegionSelections }
        : {}),
      ...(input.motionPaint ? { paint: input.motionPaint } : {}),
      fixedStepSeconds: 1 / 120,
      maxSubsteps: 8,
      interruptionResetSeconds: 0.25,
      gravity: [0, -9.81, 0],
      collisionIterations: 4,
    },
  };
}
