import { createHash } from "node:crypto";

import type { AppearanceDialValueState } from "$lib/goons/appearanceDials.contracts";
import {
  createHairState,
  parseHairRefitSource,
  verifyHairAsset,
  type HairAssetV1,
  type HairRefitSourceV1,
} from "$lib/goons/hairAssets";
import {
  HAIR_IMPORT_CANONICAL_ROOT_NODE,
  authorHairImportProposal,
  type HairImportMotionRegionSelection,
} from "$lib/goons/hairImportAuthoring";
import { parseHairFollowerDefinition } from "$lib/goons/hairFollowers";
import {
  canonicalizeHairImportSelection,
  inspectHairImportSource,
  type Bounds3,
  type HairImportTransformInput,
} from "$lib/goons/hairImportIntake";
import type { HairImportInspection } from "$lib/components/goons/hair-import/hairImportUiState";
import {
  parseHairMotionPaint,
  type HairMotionPaintV1,
} from "$lib/goons/hairMotionPaint";
import { canonicalRecipeString } from "$lib/goons/recipe/recipeCanonical";
import { parseSecondaryMotionDefinition } from "$lib/goons/secondaryMotion";
import { getOwnedRecipeGoon } from "./goonRecipeRepository.server";
import {
  HairImportJobError,
  deleteHairImportJobRecord,
  createHairImportJob,
  getHairImportJob,
  getHairImportJobForCleanup,
  listDiscardableHairImportJobs,
  replaceHairImportJob,
  type HairImportJob,
  type HairImportOwnedFile,
  type HairImportTarget,
} from "./hairImportJobRepository.server";
import {
  createHairImportTexturePng,
  deleteHairImportOwnedFile,
  readHairImportOwnedFile,
  stageHairImportPreviewGeometry,
  stageHairImportSource,
  storeHairAssetArtifact,
  strictJsonBytes,
} from "./hairImportOwnedFiles.server";
import {
  buildImportedHairRefitSource,
  buildImportedHairAsset,
  type ImportedHairAssetFiles,
} from "./hairImportAssetFactory.server";
import {
  commitImportedHairAssetRevision,
  getHairRefitSource,
  listHairAssets,
  resolveHairAssetRevision,
} from "./hairAssetRepository.server";
import {
  loadHairImportRecipeContext,
  proposeHairImportAuthoringInput,
} from "./hairImportRecipeContext.server";
import {
  parseHairImportAhsCalibration,
  parseStoredHairImportAhsCalibration,
} from "./hairImportAhsCalibration.server";

function sourceModeLabel(value: string, calibrationRecognition?: string) {
  if (calibrationRecognition === "batshit-template") {
    return "Anime Hair Studio / Batshit template";
  }
  if (calibrationRecognition === "stock-template") {
    return "Anime Hair Studio / converted stock scalp";
  }
  if (value === "ahs-like-obj" && calibrationRecognition === "unrecognized") {
    return "Anime Hair Studio / unrecognized calibration (generic fit)";
  }
  if (value === "ahs-like-obj") return "Anime Hair Studio OBJ (generic fit)";
  if (value === "generic-obj") return "Generic OBJ";
  return "Generic GLB";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown failure.";
}

function uniqueCleanupFiles(files: readonly HairImportOwnedFile[]) {
  return [...new Map(files.map((file) => [file.ref, file])).values()];
}

export function resolveHairImportCandidateFileTransition(input: {
  source: HairImportOwnedFile;
  previousFiles: readonly HairImportOwnedFile[];
  createdFiles: readonly HairImportOwnedFile[];
}) {
  const createdRefs = new Set(input.createdFiles.map((file) => file.ref));
  const obsoletePreviousFiles = input.previousFiles.filter(
    (file) => !createdRefs.has(file.ref),
  );
  return {
    obsoletePreviousFiles,
    cleanupFiles: uniqueCleanupFiles([
      input.source,
      ...obsoletePreviousFiles,
      ...input.createdFiles,
    ]),
  };
}

async function beginHairImportFromSource(input: {
  userId: string;
  goonId: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  calibrationFileName?: string;
  calibrationBytes?: Uint8Array;
  target?: HairImportTarget;
  startingTransform?: UiTransform;
  initialTransform?: UiTransform;
}): Promise<{
  job: Awaited<ReturnType<typeof createHairImportJob>>;
  inspection: HairImportInspection;
}> {
  await pruneDiscardableHairImportJobs(input.userId);
  await getOwnedRecipeGoon(input.userId, input.goonId);
  const inspected = inspectHairImportSource({
    bytes: input.bytes,
    filename: input.fileName,
  });
  const calibration =
    input.calibrationFileName && input.calibrationBytes
      ? await parseHairImportAhsCalibration({
          filename: input.calibrationFileName,
          bytes: input.calibrationBytes,
        })
      : null;
  if (calibration && inspected.sourceMode !== "ahs-like-obj") {
    throw new HairImportJobError(
      "INVALID_STATE",
      "An Anime Hair Studio .ahs project can only accompany its matching AHS OBJ export. Choose the exported OBJ and optional .ahs file together.",
      400,
    );
  }
  const proposedTransform: UiTransform =
    input.startingTransform ??
    (() => {
      const fit =
        calibration?.recommendedTransform ??
        proposeHairImportTransform(inspected.geometry.bounds);
      return {
        move: {
          x: fit.translation![0],
          y: fit.translation![1],
          z: fit.translation![2],
        },
        rotate: { x: 0, y: 0, z: 0 },
        uniformScale: fit.uniformScale!,
        axisScale: { x: 1, y: 1, z: 1 },
      };
    })();
  const initialTransform = input.initialTransform ?? proposedTransform;
  const previewCanonical = canonicalizeHairImportSelection({
    bytes: input.bytes,
    filename: input.fileName,
    calibration: calibration?.sourceCalibration,
  });
  const staged = await stageHairImportSource({
    originalName: input.fileName,
    bytes: input.bytes,
    mimeType: input.mimeType,
  });
  let preview: HairImportOwnedFile | null = null;
  try {
    preview = await stageHairImportPreviewGeometry(previewCanonical.glbBytes);
    const job = await createHairImportJob({
      userId: input.userId,
      goonId: input.goonId,
      source: staged,
      target: input.target,
      startingTransform: proposedTransform,
      initialTransform,
      inspection: inspected as unknown as Record<string, unknown>,
      calibration: calibration as unknown as Record<string, unknown> | null,
      cleanupFiles: [preview],
    });
    return {
      job,
      inspection: {
        sessionId: job.jobId,
        previewGeometryUrl: preview.ref,
        sourceModeLabel: sourceModeLabel(
          inspected.sourceMode,
          calibration?.recognition,
        ),
        sourceSummary: `${inspected.geometry.meshCount.toLocaleString()} polygon object${inspected.geometry.meshCount === 1 ? "" : "s"}, ${inspected.geometry.vertexCount.toLocaleString()} referenced vertices, and ${inspected.geometry.triangleCount.toLocaleString()} triangles were inspected from file content.`,
        objects: inspected.inventory
          .filter((entry) => entry.triangleCount > 0)
          .map((entry) => ({
            id: entry.objectId,
            name: entry.name,
            triangleCount: entry.triangleCount,
            materialCount: entry.materialNames.length,
            recommendedHair: entry.defaultDecision === "keep",
            reason: entry.defaultReason,
          })),
        proposedTransform,
        initialTransform,
        notices: [
          ...new Set([
            ...(calibration?.notices ?? []),
            ...inspected.receipts
              .filter((entry) => entry.action === "removed")
              .map((entry) => entry.reason),
          ]),
        ],
      },
    };
  } catch (error) {
    const cleanupFailures: Array<{ ref: string; message: string }> = [];
    for (const file of [preview, staged].filter(
      (entry): entry is HairImportOwnedFile => entry !== null,
    )) {
      try {
        await deleteHairImportOwnedFile(file);
      } catch (cleanupError) {
        cleanupFailures.push({
          ref: file.ref,
          message: errorMessage(cleanupError),
        });
      }
    }
    if (cleanupFailures.length > 0) {
      throw new HairImportJobError(
        "CLEANUP_FAILED",
        "Hair import job creation failed and one or more staged files could not be cleaned up.",
        502,
        {
          source: staged.ref,
          operationFailure: errorMessage(error),
          cleanupFailures,
        },
      );
    }
    throw error;
  }
}

export async function beginHairImport(input: {
  userId: string;
  goonId: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  calibrationFileName?: string;
  calibrationBytes?: Uint8Array;
}) {
  return beginHairImportFromSource(input);
}

function ownedRefitSource(
  asset: HairAssetV1,
  refitSource: HairRefitSourceV1,
): HairImportOwnedFile {
  if (asset.sourceClass !== "user") {
    throw new HairImportJobError(
      "INVALID_STATE",
      "Only imported Hair revisions with a reusable fit source can be refitted.",
      409,
    );
  }
  const prefix = "/uploads/goon_hair_assets/";
  if (
    refitSource.assetId !== asset.assetId ||
    refitSource.revisionId !== asset.revisionId
  ) {
    throw new HairImportJobError(
      "INVALID_STATE",
      "The reusable Hair fit source does not match the selected immutable revision.",
      409,
    );
  }
  const source = refitSource.source;
  if (!source.ref.startsWith(prefix)) {
    throw new HairImportJobError(
      "INVALID_STATE",
      "The reusable Hair fit source is outside the owned Hair library.",
      409,
    );
  }
  const filename = source.ref.slice(prefix.length);
  if (!filename || filename.includes("/") || filename.includes("\\")) {
    throw new HairImportJobError(
      "INVALID_STATE",
      "The reusable Hair fit source has an invalid owned filename.",
      409,
    );
  }
  return { uploadType: "goon_hair_assets", filename, ...source };
}

export async function beginHairRefit(input: {
  userId: string;
  goonId: string;
  assetId: string;
  revisionId: string;
  revisionSha256: string;
}) {
  const asset = await resolveHairAssetRevision(input.userId, {
    assetId: input.assetId,
    assetRevisionId: input.revisionId,
    assetRevisionSha256: input.revisionSha256,
  });
  const refitSource = await getHairRefitSource(
    input.userId,
    asset.assetId,
    asset.revisionId,
  );
  if (!refitSource) {
    throw new HairImportJobError(
      "INVALID_STATE",
      "This imported Hair revision does not have a reusable fit source.",
      409,
    );
  }
  const source = ownedRefitSource(asset, refitSource);
  const revisions = (await listHairAssets(input.userId)).filter(
    (entry) => entry.sourceClass === "user" && entry.assetId === asset.assetId,
  );
  const revision = Math.max(...revisions.map((entry) => entry.revision), 0) + 1;
  const revisionId = `${asset.assetId}-r${revision}`;
  const bytes = await readHairImportOwnedFile(source);
  return beginHairImportFromSource({
    userId: input.userId,
    goonId: input.goonId,
    fileName: `${asset.assetId}-refit.glb`,
    mimeType: "model/gltf-binary",
    bytes,
    target: {
      kind: "refit",
      assetId: asset.assetId,
      revisionId,
      revision,
      sourceRevisionId: asset.revisionId,
      displayName: asset.display.name,
      author: asset.provenance.author,
      license: asset.provenance.license,
      originalSourceSha256: asset.provenance.sourceSha256,
      refitSource: source,
    },
    startingTransform: refitSource.startingTransform,
    initialTransform: refitSource.savedTransform,
  });
}

export function proposeHairImportTransform(
  bounds: Bounds3 | null,
): HairImportTransformInput {
  if (!bounds) {
    throw new HairImportJobError(
      "INVALID_STATE",
      "Hair import contains no selected polygon bounds.",
      400,
    );
  }
  const size = bounds.max.map((value, axis) => value - bounds.min[axis]) as [
    number,
    number,
    number,
  ];
  if (size.some((value) => !Number.isFinite(value) || value <= 1e-8)) {
    throw new HairImportJobError(
      "INVALID_STATE",
      "Hair import bounds are too thin to fit safely.",
      400,
    );
  }
  const targetSize: [number, number, number] = [0.42, 0.48, 0.42];
  const uniformScale = Math.min(
    100,
    Math.max(
      0.01,
      Math.min(...targetSize.map((value, axis) => value / size[axis])),
    ),
  );
  const sourceCenter = bounds.min.map(
    (value, axis) => (value + bounds.max[axis]) / 2,
  ) as [number, number, number];
  const targetCenter: [number, number, number] = [0, 1.48, 0.04];
  return {
    translation: targetCenter.map(
      (value, axis) => value - sourceCenter[axis] * uniformScale,
    ) as [number, number, number],
    rotation: [0, 0, 0],
    uniformScale,
    axisScale: [1, 1, 1],
  };
}

type UiTransform = {
  move: { x: number; y: number; z: number };
  rotate: { x: number; y: number; z: number };
  uniformScale: number;
  axisScale: { x: number; y: number; z: number };
};

type StoredHairImportCandidate = {
  assetId: string;
  revisionId: string;
  revision: number;
  provisionalAsset: HairAssetV1;
  refitSource: HairRefitSourceV1;
  files: ImportedHairAssetFiles;
  headNode: string;
  authoredRootMatrix: number[];
  sourceMode: string;
  sourceSha256: string;
  recipeSource: Awaited<
    ReturnType<typeof loadHairImportRecipeContext>
  >["recipeSource"];
  audit: {
    meshCount: number;
    vertexCount: number;
    triangleCount: number;
    materialCount: number;
  };
  geometrySha256: string;
  preview: HairImportOwnedFile | null;
};

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HairImportJobError(
      "INVALID_STATE",
      `${context} is malformed.`,
      500,
    );
  }
  return value as Record<string, unknown>;
}

function uiTransform(value: unknown): UiTransform {
  const raw = record(value, "Hair import transform");
  const vector = (entry: unknown, context: string) => {
    const source = record(entry, context);
    const result = [source.x, source.y, source.z].map((component) =>
      Number(component),
    );
    if (result.some((component) => !Number.isFinite(component))) {
      throw new HairImportJobError(
        "INVALID_STATE",
        `${context} must contain finite XYZ values.`,
        400,
      );
    }
    return { x: result[0]!, y: result[1]!, z: result[2]! };
  };
  const result = {
    move: vector(raw.move, "Hair import move"),
    rotate: vector(raw.rotate, "Hair import rotation"),
    uniformScale: Number(raw.uniformScale),
    axisScale: vector(raw.axisScale, "Hair import per-axis scale"),
  };
  if (!Number.isFinite(result.uniformScale)) {
    throw new HairImportJobError(
      "INVALID_STATE",
      "Hair import uniform scale must be finite.",
      400,
    );
  }
  return result;
}

function intakeTransform(value: UiTransform): HairImportTransformInput {
  const radians = Math.PI / 180;
  return {
    translation: [value.move.x, value.move.y, value.move.z],
    rotation: [
      value.rotate.x * radians,
      value.rotate.y * radians,
      value.rotate.z * radians,
    ],
    uniformScale: value.uniformScale,
    axisScale: [value.axisScale.x, value.axisScale.y, value.axisScale.z],
  };
}

function selectedIds(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1024) {
    throw new HairImportJobError(
      "INVALID_STATE",
      "Hair import requires one to 1,024 selected polygon objects.",
      400,
    );
  }
  const ids = value.map((entry) => {
    if (typeof entry !== "string" || !entry || entry !== entry.trim()) {
      throw new HairImportJobError(
        "INVALID_STATE",
        "Hair import object ids are invalid.",
        400,
      );
    }
    return entry;
  });
  if (new Set(ids).size !== ids.length) {
    throw new HairImportJobError(
      "INVALID_STATE",
      "Hair import object ids must be unique.",
      400,
    );
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function motionRegionSelections(
  value: unknown,
): HairImportMotionRegionSelection[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 254) {
    throw new HairImportJobError(
      "INVALID_STATE",
      "Hair motion review must contain one to 254 region decisions.",
      400,
    );
  }
  const ids = new Set<string>();
  const selections = value.map((entry) => {
    const raw = record(entry, "Hair motion region selection");
    const keys = Object.keys(raw).sort();
    if (
      keys.length !== 2 ||
      keys[0] !== "id" ||
      keys[1] !== "moving" ||
      typeof raw.id !== "string" ||
      !raw.id ||
      raw.id !== raw.id.trim() ||
      typeof raw.moving !== "boolean"
    ) {
      throw new HairImportJobError(
        "INVALID_STATE",
        "Each Hair motion region decision must contain exactly id and moving.",
        400,
      );
    }
    if (ids.has(raw.id)) {
      throw new HairImportJobError(
        "INVALID_STATE",
        `Hair motion region ${raw.id} was reviewed more than once.`,
        400,
      );
    }
    ids.add(raw.id);
    return { id: raw.id, moving: raw.moving };
  });
  return selections.sort((left, right) => left.id.localeCompare(right.id));
}

function motionPaint(value: unknown): HairMotionPaintV1 | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    return parseHairMotionPaint(value);
  } catch (error) {
    throw new HairImportJobError(
      "INVALID_STATE",
      error instanceof Error ? error.message : "Hair motion paint is invalid.",
      400,
    );
  }
}

function candidateIds(job: HairImportJob) {
  if (job.target.kind === "refit") {
    return {
      assetId: job.target.assetId,
      revisionId: job.target.revisionId,
      revision: job.target.revision,
    };
  }
  const assetId = `imported-hair-${job.jobId}`.toLowerCase();
  return { assetId, revisionId: `${assetId}-r1`, revision: 1 };
}

function displayNameFromSource(value: string) {
  const base = value.replace(/\\/g, "/").split("/").at(-1) ?? "Imported Hair";
  const withoutExtension = base.replace(/\.(?:obj|glb)$/i, "");
  const result = withoutExtension
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return result || "Imported Hair";
}

function proposalEnvelope(
  authored: Awaited<ReturnType<typeof authorHairImportProposal>>,
  canonical: ReturnType<typeof canonicalizeHairImportSelection>,
) {
  return {
    material: {
      title: "Neutral Hair material",
      summary:
        "One Batshit-owned neutral material replaces source materials and supports Base plus Highlight recoloring.",
      details: [
        "UV0 and finite normals were regenerated after the reviewed fit.",
        "The neutral value map preserves readable light and shadow around the two chosen colors.",
        "Source materials are inventoried in the receipt and do not silently survive.",
      ],
    },
    follower: {
      title: "Scalp-aware Appearance following",
      summary: `${authored.evidence.morphTargetCount.toLocaleString()} generated morph targets keep the reviewed roots on the changing head and scalp.`,
      details: [
        `${authored.proposal.clumps.length.toLocaleString()} clumps use topology-derived roots and tips.`,
        `Maximum reviewed root distance is ${(authored.evidence.maximumRootDistance * 100).toFixed(2)} cm.`,
        "Head size, head shape, forehead, temple, and neck-clearance endpoints remain explicit review states.",
      ],
    },
    physics: {
      title: "Root-weighted motion",
      summary: `${authored.evidence.motionChainCount.toLocaleString()} proposed chains keep roots fixed while movement ramps toward distal tips.`,
      details: [
        `${authored.evidence.anchoredVertexCount.toLocaleString()} vertices are fully anchored at the authored default.`,
        `${authored.evidence.fullyDynamicVertexCount.toLocaleString()} distal vertices receive full proposed motion.`,
        ...(authored.evidence.anchoredMicroComponentCount > 0
          ? [
              `${authored.evidence.anchoredMicroComponentCount.toLocaleString()} sub-5 mm decorative islands (${authored.evidence.anchoredMicroVertexCount.toLocaleString()} vertices) are explicitly root-anchored and remain visible in this receipt.`,
            ]
          : []),
        `${authored.evidence.colliderCount.toLocaleString()} head, neck, shoulder, and chest collider shapes are declared explicitly.`,
        "The generated motion recipe remains visible in the receipt while the user reviews the resulting Hair in every required state.",
      ],
    },
    motionReview: {
      anchoredLength: authored.proposal.weights.anchoredLength,
      weightCurve: authored.proposal.weights.weightCurve,
      defaultIntensity: authored.proposal.weights.defaultIntensity,
      regions: authored.proposal.motionRegions.map((region) => ({
        id: region.id,
        meshNode: region.meshNode,
        label: region.label,
        moving: region.moving,
        recommendedMoving: region.recommendedMoving,
        supportsMotion: region.supportsMotion,
        lengthMeters: region.lengthMeters,
        vertexCount: region.vertexCount,
        explanation: region.explanation,
      })),
    },
    validationSummary: `${canonical.geometry.meshCount.toLocaleString()} selected mesh objects were canonicalized and authored without an unreviewed rigid fallback.`,
    receipt: {
      kept: canonical.receipts
        .filter((entry) => entry.action === "kept")
        .map((entry) => `${entry.subject}: ${entry.reason}`),
      removed: canonical.receipts
        .filter((entry) => entry.action === "removed")
        .map((entry) => `${entry.subject}: ${entry.reason}`),
      generated: canonical.receipts
        .filter((entry) => entry.action === "generated")
        .map((entry) => `${entry.subject}: ${entry.reason}`)
        .concat(
          authored.evidence.anchoredMicroComponentCount > 0
            ? [
                `micro-island anchoring: ${authored.evidence.anchoredMicroComponentCount.toLocaleString()} sub-5 mm decorative islands (${authored.evidence.anchoredMicroVertexCount.toLocaleString()} vertices) were explicitly kept at the root instead of receiving a guessed chain.`,
              ]
            : [],
        ),
    },
  };
}

function immutableAssetAudit(
  geometry: ReturnType<typeof canonicalizeHairImportSelection>["geometry"],
) {
  return {
    meshCount: geometry.meshCount,
    vertexCount: geometry.vertexCount,
    triangleCount: geometry.triangleCount,
    materialCount: geometry.materialCount,
  };
}

async function deleteFiles(files: readonly HairImportOwnedFile[]) {
  const failures: string[] = [];
  for (const file of [...files].reverse()) {
    try {
      await deleteHairImportOwnedFile(file);
    } catch (error) {
      failures.push(
        `${file.ref}: ${error instanceof Error ? error.message : "unknown cleanup failure"}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new HairImportJobError(
      "CLEANUP_FAILED",
      "Hair import candidate cleanup did not finish.",
      502,
      failures,
    );
  }
}

async function storeCandidateFiles(input: {
  assetId: string;
  revisionId: string;
  geometry: Uint8Array;
  follower: unknown;
  physics: unknown;
  receipt: unknown;
  refitSourceBytes: Uint8Array;
  reusableRefitSource: HairImportOwnedFile | null;
  created: HairImportOwnedFile[];
}) {
  const store = async (
    role: Parameters<typeof storeHairAssetArtifact>[0]["role"],
    filename: string,
    mimeType: string,
    bytes: Uint8Array,
  ) => {
    const file = await storeHairAssetArtifact({
      assetId: input.assetId,
      revisionId: input.revisionId,
      role,
      filename,
      mimeType,
      bytes,
    });
    input.created.push(file);
    return file;
  };
  const geometry = await store(
    "geometry",
    "hair.glb",
    "model/gltf-binary",
    input.geometry,
  );
  const followerDefinition = await store(
    "follower-definition",
    "appearance-followers.json",
    "application/json",
    strictJsonBytes(input.follower),
  );
  const physicsDefinition = await store(
    "physics-definition",
    "secondary-motion.json",
    "application/json",
    strictJsonBytes(input.physics),
  );
  const neutralValue = await store(
    "neutral-value",
    "neutral-value.png",
    "image/png",
    createHairImportTexturePng("neutral-value"),
  );
  const highlightMask = await store(
    "highlight-mask",
    "highlight-mask.png",
    "image/png",
    createHairImportTexturePng("highlight-mask"),
  );
  const importReceipt = await store(
    "import-receipt",
    "import-receipt.json",
    "application/json",
    strictJsonBytes(input.receipt),
  );
  const refitSourceSha256 = createHash("sha256")
    .update(input.refitSourceBytes)
    .digest("hex");
  const refitSource =
    input.reusableRefitSource &&
    input.reusableRefitSource.sha256 === refitSourceSha256 &&
    input.reusableRefitSource.bytes === input.refitSourceBytes.byteLength
      ? input.reusableRefitSource
      : await store(
          "refit-source",
          "refit-source.glb",
          "model/gltf-binary",
          input.refitSourceBytes,
        );
  return {
    geometry,
    followerDefinition,
    physicsDefinition,
    neutralValue,
    highlightMask,
    preview: neutralValue,
    importReceipt,
    refitSource,
  } satisfies ImportedHairAssetFiles;
}

function parseStoredCandidate(value: unknown): StoredHairImportCandidate {
  const candidate = record(
    value,
    "Stored Hair import candidate",
  ) as unknown as StoredHairImportCandidate;
  if (
    typeof candidate.assetId !== "string" ||
    typeof candidate.revisionId !== "string" ||
    !Number.isSafeInteger(candidate.revision) ||
    candidate.revision < 1 ||
    !candidate.files ||
    !candidate.refitSource ||
    !candidate.recipeSource ||
    !candidate.audit ||
    typeof candidate.headNode !== "string" ||
    !Array.isArray(candidate.authoredRootMatrix)
  ) {
    throw new HairImportJobError(
      "INVALID_STATE",
      "Stored Hair import candidate is malformed.",
      500,
    );
  }
  const refitSource = parseHairRefitSource(candidate.refitSource);
  if (
    refitSource.assetId !== candidate.assetId ||
    refitSource.revisionId !== candidate.revisionId
  ) {
    throw new HairImportJobError(
      "INVALID_STATE",
      "Stored Hair refit source does not match its candidate revision.",
      500,
    );
  }
  return { ...candidate, refitSource };
}

export async function prepareHairImport(input: {
  userId: string;
  jobId: string;
  selectedObjectIds: unknown;
  transform: unknown;
  reviewedAppearanceState: unknown;
  motionRegionSelections: unknown;
  motionPaint: unknown;
}) {
  const initial = await getHairImportJob(input.userId, input.jobId);
  if (!["inspected", "reviewable", "failed"].includes(initial.status)) {
    throw new HairImportJobError(
      "INVALID_STATE",
      "Hair import is already being prepared or saved.",
      409,
    );
  }
  const selectedObjectIds = selectedIds(input.selectedObjectIds);
  const transform = uiTransform(input.transform);
  const reviewedMotionRegions = motionRegionSelections(
    input.motionRegionSelections,
  );
  const reviewedMotionPaint = motionPaint(input.motionPaint);
  if (reviewedMotionPaint && reviewedMotionRegions) {
    throw new HairImportJobError(
      "INVALID_STATE",
      "Choose automatic Hair tips or painted motion areas, not both in one preview request.",
      400,
    );
  }
  const preparing = await replaceHairImportJob(initial, {
    ...initial,
    status: "preparing",
    failure: null,
  });
  const previousFiles = initial.cleanupFiles.filter(
    (file) => file.ref !== initial.source.ref,
  );
  const created: HairImportOwnedFile[] = [];
  let candidatePersisted = false;
  try {
    const [sourceBytes, context] = await Promise.all([
      readHairImportOwnedFile(initial.source),
      loadHairImportRecipeContext(input.userId, initial.goonId),
    ]);
    const calibration = parseStoredHairImportAhsCalibration(
      initial.calibration,
    );
    const canonical = canonicalizeHairImportSelection({
      bytes: sourceBytes,
      filename: initial.source.originalName,
      keepObjectIds: selectedObjectIds,
      transform: intakeTransform(transform),
      calibration: calibration?.sourceCalibration,
    });
    const sourcePolygonObjectIds = inspectHairImportSource({
      bytes: sourceBytes,
      filename: initial.source.originalName,
    })
      .inventory.filter((entry) => entry.triangleCount > 0)
      .map((entry) => entry.objectId)
      .sort((left, right) => left.localeCompare(right));
    const keepsEveryReusableObject =
      initial.target.kind === "refit" &&
      canonicalRecipeString(sourcePolygonObjectIds) ===
        canonicalRecipeString(selectedObjectIds);
    const refitSourceBytes = keepsEveryReusableObject
      ? sourceBytes
      : canonicalizeHairImportSelection({
          bytes: sourceBytes,
          filename: initial.source.originalName,
          keepObjectIds: selectedObjectIds,
          calibration: calibration?.sourceCalibration,
        }).glbBytes;
    const ids = candidateIds(initial);
    const authored = await authorHairImportProposal(
      proposeHairImportAuthoringInput({
        canonical,
        context,
        ...ids,
        reviewedAppearanceState:
          input.reviewedAppearanceState as AppearanceDialValueState | null,
        motionRegionSelections: reviewedMotionRegions,
        motionPaint: reviewedMotionPaint,
      }),
    );
    const resolvedMotionRegionSelections = authored.proposal.motionRegions
      .map((region) => ({ id: region.id, moving: region.moving }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const proposals = proposalEnvelope(authored, canonical);
    const audit = immutableAssetAudit(canonical.geometry);
    const importReceipt = {
      contract: "hair-import-receipt/v1",
      source: {
        originalName: initial.source.originalName,
        sha256: initial.source.sha256,
        bytes: initial.source.bytes,
        mode: canonical.sourceMode,
      },
      calibration: calibration
        ? {
            contract: calibration.contract,
            originalName: calibration.originalName,
            sha256: calibration.sha256,
            bytes: calibration.bytes,
            fingerprint: calibration.fingerprint,
            recognition: calibration.recognition,
            headAssetSha256: calibration.headAssetSha256,
            requiresVisualReview: calibration.requiresVisualReview,
          }
        : null,
      selection: {
        keptObjectIds: canonical.keptObjectIds,
        removedObjectIds: canonical.removedObjectIds,
        transform: canonical.transform,
      },
      geometry: canonical.geometry,
      receipts: canonical.receipts,
      authoring: authored.evidence,
      reviewedAppearanceState: input.reviewedAppearanceState,
      motionPaint: reviewedMotionPaint ?? null,
      proposal: authored.proposal,
      recipeSource: context.recipeSource,
    };
    const stored = await storeCandidateFiles({
      ...ids,
      geometry: authored.geometryGlb,
      follower: authored.followerDefinition,
      physics: authored.secondaryMotionDefinition,
      receipt: importReceipt,
      refitSourceBytes,
      reusableRefitSource:
        initial.target.kind === "refit" ? initial.target.refitSource : null,
      created,
    });
    const provisionalAsset = await buildImportedHairAsset({
      displayName:
        initial.target.kind === "refit"
          ? initial.target.displayName
          : displayNameFromSource(initial.source.originalName),
      ...ids,
      recipeSource: context.recipeSource,
      headNode: context.headRigNode,
      authoredRootMatrix: context.authoredRootMatrix,
      sourceSha256:
        initial.target.kind === "refit"
          ? initial.target.originalSourceSha256
          : initial.source.sha256,
      sourceMode: canonical.sourceMode,
      author: "Local user",
      license: "user-provided",
      followerDefinition: authored.followerDefinition,
      physicsDefinition: authored.secondaryMotionDefinition,
      files: stored,
      audit,
    });
    const refitSource = buildImportedHairRefitSource({
      ...ids,
      source: stored.refitSource,
      startingTransform: initial.startingTransform,
      savedTransform: transform,
    });
    const candidate: StoredHairImportCandidate = {
      ...ids,
      provisionalAsset,
      refitSource,
      files: stored,
      headNode: context.headRigNode,
      authoredRootMatrix: context.authoredRootMatrix,
      sourceMode: canonical.sourceMode,
      sourceSha256:
        initial.target.kind === "refit"
          ? initial.target.originalSourceSha256
          : initial.source.sha256,
      recipeSource: context.recipeSource,
      audit,
      geometrySha256: authored.evidence.outputGeometrySha256,
      preview: null,
    };
    const fileTransition = resolveHairImportCandidateFileTransition({
      source: initial.source,
      previousFiles,
      createdFiles: created,
    });
    const { obsoletePreviousFiles } = fileTransition;
    const reviewable = await replaceHairImportJob(preparing, {
      ...preparing,
      status: "reviewable",
      draft: {
        selectedObjectIds,
        transform,
        motionRegionSelections: resolvedMotionRegionSelections,
        motionPaint: reviewedMotionPaint ?? null,
      },
      proposal: proposals,
      candidate: candidate as unknown as Record<string, unknown>,
      cleanupFiles: fileTransition.cleanupFiles,
      failure: null,
    });
    candidatePersisted = true;
    if (obsoletePreviousFiles.length > 0)
      await deleteFiles(obsoletePreviousFiles);
    const settled = obsoletePreviousFiles.length
      ? await replaceHairImportJob(reviewable, {
          ...reviewable,
          cleanupFiles: uniqueCleanupFiles([initial.source, ...created]),
        })
      : reviewable;
    return {
      proposals,
      candidate: {
        asset: provisionalAsset,
        hairState: createHairState(provisionalAsset),
        stateVersion: settled.stateVersion,
        geometryUrl: provisionalAsset.geometry.main.ref,
        rootNode: HAIR_IMPORT_CANONICAL_ROOT_NODE,
      },
    };
  } catch (error) {
    if (!candidatePersisted && created.length > 0) {
      try {
        await deleteFiles(created);
      } catch (cleanupError) {
        const tracked = uniqueCleanupFiles([
          ...preparing.cleanupFiles,
          ...created,
        ]);
        try {
          await replaceHairImportJob(preparing, {
            ...preparing,
            status: "failed",
            cleanupFiles: tracked,
            failure: {
              stage: "prepare-cleanup",
              message: errorMessage(cleanupError),
            },
          });
        } catch (trackingError) {
          throw new HairImportJobError(
            "CLEANUP_FAILED",
            "Hair import preparation failed, and cleanup ownership could not be recorded for retry.",
            502,
            {
              files: tracked.map((file) => file.ref),
              operationFailure: errorMessage(error),
              cleanupFailure: errorMessage(cleanupError),
              trackingFailure: errorMessage(trackingError),
            },
          );
        }
        throw cleanupError;
      }
    }
    try {
      await failHairImportJob({
        userId: input.userId,
        jobId: input.jobId,
        stage: "prepare",
        error,
      });
    } catch (trackingError) {
      throw new HairImportJobError(
        "WRITE_CONFLICT",
        "Hair import preparation failed, and the visible failure state could not be recorded.",
        409,
        {
          operationFailure: errorMessage(error),
          trackingFailure: errorMessage(trackingError),
        },
      );
    }
    throw error;
  }
}

function textField(value: unknown, context: string, maximum: number) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new HairImportJobError(
      "INVALID_STATE",
      `${context} must be a trimmed value no longer than ${maximum} characters.`,
      400,
    );
  }
  return value;
}

function parseJsonObjectBytes(bytes: Uint8Array, context: string) {
  try {
    return record(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      context,
    );
  } catch (error) {
    if (error instanceof HairImportJobError) throw error;
    throw new HairImportJobError(
      "INVALID_STATE",
      `${context} is no longer valid UTF-8 JSON.`,
      500,
    );
  }
}

function assertPreviewPng(bytes: Uint8Array) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.byteLength < signature.length ||
    bytes.byteLength > 8 * 1024 * 1024 ||
    signature.some((value, index) => bytes[index] !== value)
  ) {
    throw new HairImportJobError(
      "INVALID_STATE",
      "Hair import preview must be a valid PNG no larger than 8 MB.",
      400,
    );
  }
}

export async function finalizeHairImport(input: {
  userId: string;
  jobId: string;
  displayName: unknown;
  author: unknown;
  license: unknown;
  previewPng: Uint8Array;
}) {
  assertPreviewPng(input.previewPng);
  const displayName = textField(input.displayName, "Hair display name", 120);
  const author = textField(input.author, "Hair author credit", 160);
  const license = textField(input.license, "Hair license", 160);
  let job = await getHairImportJob(input.userId, input.jobId);
  if (job.status !== "reviewable") {
    throw new HairImportJobError(
      "INVALID_STATE",
      "Hair import is not ready to save.",
      409,
    );
  }
  if (!job.draft) {
    throw new HairImportJobError(
      "INVALID_STATE",
      "Hair import is missing its verified finished-candidate receipt.",
      409,
    );
  }
  const candidate = parseStoredCandidate(job.candidate);
  await verifyHairAsset(candidate.provisionalAsset);
  const previewSha256 = createHash("sha256")
    .update(input.previewPng)
    .digest("hex");
  const priorPreview = candidate.preview;
  let preview = priorPreview;
  if (
    !preview ||
    preview.sha256 !== previewSha256 ||
    preview.bytes !== input.previewPng.byteLength
  ) {
    const storedPreview = await storeHairAssetArtifact({
      assetId: candidate.assetId,
      revisionId: candidate.revisionId,
      role: "preview",
      filename: "preview.png",
      mimeType: "image/png",
      bytes: input.previewPng,
    });
    let previewPersisted = false;
    try {
      const nextCandidate: StoredHairImportCandidate = {
        ...candidate,
        files: { ...candidate.files, preview: storedPreview },
        preview: storedPreview,
      };
      job = await replaceHairImportJob(job, {
        ...job,
        candidate: nextCandidate as unknown as Record<string, unknown>,
        cleanupFiles: [...job.cleanupFiles, storedPreview],
      });
      previewPersisted = true;
      preview = storedPreview;
      if (priorPreview && priorPreview.ref !== storedPreview.ref) {
        await deleteHairImportOwnedFile(priorPreview);
        job = await replaceHairImportJob(job, {
          ...job,
          cleanupFiles: job.cleanupFiles.filter(
            (file) => file.ref !== priorPreview.ref,
          ),
        });
      }
    } catch (error) {
      if (!previewPersisted) {
        try {
          await deleteHairImportOwnedFile(storedPreview);
        } catch (cleanupError) {
          const tracked = uniqueCleanupFiles([
            ...job.cleanupFiles,
            storedPreview,
          ]);
          try {
            job = await replaceHairImportJob(job, {
              ...job,
              cleanupFiles: tracked,
              failure: {
                stage: "preview-cleanup",
                message: errorMessage(cleanupError),
              },
            });
          } catch (trackingError) {
            throw new HairImportJobError(
              "CLEANUP_FAILED",
              "Hair preview storage failed, and cleanup ownership could not be recorded for retry.",
              502,
              {
                file: storedPreview.ref,
                operationFailure: errorMessage(error),
                cleanupFailure: errorMessage(cleanupError),
                trackingFailure: errorMessage(trackingError),
              },
            );
          }
          throw new HairImportJobError(
            "CLEANUP_FAILED",
            "Hair preview storage failed and its owned file still requires cleanup. The import job remains available for retry.",
            502,
            {
              file: storedPreview.ref,
              operationFailure: errorMessage(error),
              cleanupFailure: errorMessage(cleanupError),
            },
          );
        }
      }
      throw error;
    }
  }
  if (!preview) {
    throw new HairImportJobError(
      "INVALID_STATE",
      "Hair import preview storage failed.",
      500,
    );
  }
  const currentCandidate = parseStoredCandidate(job.candidate);
  const [followerDefinition, physicsDefinition] = await Promise.all([
    readHairImportOwnedFile(currentCandidate.files.followerDefinition).then(
      (bytes) =>
        parseHairFollowerDefinition(
          parseJsonObjectBytes(bytes, "Hair follower definition"),
        ),
    ),
    readHairImportOwnedFile(currentCandidate.files.physicsDefinition).then(
      (bytes) =>
        parseSecondaryMotionDefinition(
          parseJsonObjectBytes(bytes, "Hair motion definition"),
        ),
    ),
  ]);
  const finalAsset = await buildImportedHairAsset({
    displayName,
    assetId: currentCandidate.assetId,
    revisionId: currentCandidate.revisionId,
    revision: currentCandidate.revision,
    recipeSource: currentCandidate.recipeSource,
    headNode: currentCandidate.headNode,
    authoredRootMatrix: currentCandidate.authoredRootMatrix,
    sourceSha256: currentCandidate.sourceSha256,
    sourceMode: currentCandidate.sourceMode,
    author,
    license,
    followerDefinition,
    physicsDefinition,
    files: { ...currentCandidate.files, preview },
    audit: currentCandidate.audit,
  });
  // Transfer file ownership only after the exact final asset verifies. Source
  // cleanup remains retryable because the job still exists until the atomic
  // asset/index registration removes it in the same Redis transaction.
  await deleteHairImportOwnedFile(job.source);
  const asset = await commitImportedHairAssetRevision({
    userId: input.userId,
    jobId: input.jobId,
    expectedJobStateVersion: job.stateVersion,
    asset: finalAsset,
    refitSource: currentCandidate.refitSource,
  });
  return { asset };
}

export async function failHairImportJob(input: {
  userId: string;
  jobId: string;
  stage: string;
  error: unknown;
}) {
  const job = await getHairImportJob(input.userId, input.jobId);
  const message =
    input.error instanceof Error
      ? input.error.message
      : "Unknown Hair import failure.";
  return replaceHairImportJob(job, {
    ...job,
    status: "failed",
    failure: { stage: input.stage, message },
  });
}

export async function discardHairImportJob(input: {
  userId: string;
  jobId: string;
}) {
  const job = await getHairImportJobForCleanup(input.userId, input.jobId);
  if (job.status === "complete") {
    throw new HairImportJobError(
      "INVALID_STATE",
      "Completed Hair imports own an immutable library revision and cannot be discarded as drafts.",
      409,
    );
  }
  const failures: Array<{ ref: string; error: string }> = [];
  for (const file of [...job.cleanupFiles].reverse()) {
    try {
      await deleteHairImportOwnedFile(file);
    } catch (error) {
      failures.push({
        ref: file.ref,
        error:
          error instanceof Error ? error.message : "Unknown cleanup failure.",
      });
    }
  }
  if (failures.length > 0) {
    await replaceHairImportJob(job, {
      ...job,
      status: "failed",
      failure: {
        stage: "cleanup",
        message: `Hair import cleanup failed for ${failures.length} owned file${failures.length === 1 ? "" : "s"}.`,
      },
    });
    throw new HairImportJobError(
      "CLEANUP_FAILED",
      "Hair import cleanup did not finish. The job remains available for an exact retry.",
      502,
      failures,
    );
  }
  await deleteHairImportJobRecord(input.userId, input.jobId);
  return { discarded: true, deletedFiles: job.cleanupFiles.length };
}

export async function pruneDiscardableHairImportJobs(
  userId: string,
  now = new Date(),
) {
  const discardable = await listDiscardableHairImportJobs(userId, now);
  const failures: Array<{ jobId: string; ref: string; error: string }> = [];
  let deletedJobs = 0;
  let deletedFiles = 0;
  for (const job of discardable) {
    let jobFailed = false;
    for (const file of [...job.cleanupFiles].reverse()) {
      try {
        await deleteHairImportOwnedFile(file);
        deletedFiles += 1;
      } catch (error) {
        jobFailed = true;
        failures.push({
          jobId: job.jobId,
          ref: file.ref,
          error:
            error instanceof Error ? error.message : "Unknown cleanup failure.",
        });
      }
    }
    if (!jobFailed) {
      await deleteHairImportJobRecord(userId, job.jobId);
      deletedJobs += 1;
    }
  }
  if (failures.length > 0) {
    throw new HairImportJobError(
      "CLEANUP_FAILED",
      "Obsolete or expired Hair import cleanup failed. Retry before starting another import.",
      502,
      failures,
    );
  }
  return { deletedJobs, deletedFiles };
}
