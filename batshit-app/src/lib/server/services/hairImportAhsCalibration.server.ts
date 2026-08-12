import registeredCalibrations from "$lib/goons/registeredAhsCalibrations.v1.json";
import {
  HAIR_IMPORT_TRANSFORM_CONTRACT,
  type HairImportSourceCalibrationV1,
  type HairImportTransformV1,
  type Vec3,
} from "$lib/goons/hairImportIntake";
import {
  canonicalRecipeSha256,
  sha256Hex,
} from "$lib/goons/recipe/recipeCanonical";
import { HairImportJobError } from "./hairImportJobRepository.server";

export const HAIR_IMPORT_AHS_CALIBRATION_CONTRACT =
  "hair-import-ahs-calibration/v1" as const;
export const HAIR_IMPORT_AHS_MAX_BYTES = 8 * 1024 * 1024;

const CALIBRATION_FIELDS = [
  "scalpAttachmentVersion",
  "headTransform",
  "scalpRoughScale",
  "scalpBuilderEditedPoints",
  "editedScalpRegions",
  "scalpGuideSource",
  "customScalpRegions",
  "scalpSurface",
  "scalpArtistShape",
  "scalpLatticePoints",
  "scalpRegionAssignments",
  "scalpManualRegionQuads",
] as const;

type UnknownRecord = Record<string, unknown>;
type Recognition = "batshit-template" | "stock-template" | "unrecognized";

export type HairImportAhsCalibrationV1 = {
  contract: typeof HAIR_IMPORT_AHS_CALIBRATION_CONTRACT;
  originalName: string;
  sha256: string;
  bytes: number;
  projectVersion: 1;
  fingerprint: string;
  recognition: Recognition;
  headAssetSha256: string | null;
  recommendedTransform: HairImportTransformV1 | null;
  sourceCalibration: HairImportSourceCalibrationV1 | null;
  requiresVisualReview: boolean;
  notices: string[];
};

function invalid(message: string): never {
  throw new HairImportJobError("INVALID_STATE", message, 400);
}

function record(value: unknown, context: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${context} must be an object.`);
  }
  return value as UnknownRecord;
}

function finite(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`${context} must be finite.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function parsePoint(value: unknown, context: string): Vec3 {
  const point = record(value, context);
  if (
    Object.keys(point).sort().join(",") !== "x,y,z" ||
    typeof point.x !== "number" ||
    typeof point.y !== "number" ||
    typeof point.z !== "number"
  ) {
    invalid(`${context} must contain exactly finite x, y, and z values.`);
  }
  return [
    finite(point.x, `${context}.x`),
    finite(point.y, `${context}.y`),
    finite(point.z, `${context}.z`),
  ];
}

function parseScalpPoints(value: unknown, context: string): Vec3[] {
  if (!Array.isArray(value) || value.length !== 112) {
    invalid(`${context} must contain the registered 112 scalp points.`);
  }
  return value.map((entry, index) =>
    parsePoint(entry, `${context}[${index}]`),
  );
}

function assertJsonComplexity(value: unknown) {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value, depth: 1 },
  ];
  let values = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    values += 1;
    if (values > 500_000) {
      invalid("Anime Hair Studio project exceeds the 500,000-value limit.");
    }
    if (current.depth > 64) {
      invalid("Anime Hair Studio project exceeds the 64-level depth limit.");
    }
    if (!current.value || typeof current.value !== "object") continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as UnknownRecord);
    if (children.length > 100_000) {
      invalid("Anime Hair Studio project contains an oversized collection.");
    }
    for (const child of children) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

async function calibrationProjection(project: UnknownRecord) {
  const state = record(project.state, "Anime Hair Studio project state");
  for (const field of CALIBRATION_FIELDS) {
    if (!(field in state)) {
      invalid(`Anime Hair Studio project is missing state.${field}.`);
    }
  }
  const headAsset =
    project.headAsset === null
      ? null
      : record(project.headAsset, "Anime Hair Studio head asset");
  let headAssetSha256: string | null = null;
  let projectedHead: UnknownRecord | null = null;
  if (headAsset) {
    if (
      headAsset.format !== "obj" ||
      typeof headAsset.name !== "string" ||
      !headAsset.name.trim() ||
      typeof headAsset.content !== "string" ||
      !headAsset.content
    ) {
      invalid("Anime Hair Studio embedded head must be one named OBJ data asset.");
    }
    headAssetSha256 = await sha256Hex(headAsset.content);
    projectedHead = {
      format: headAsset.format,
      name: headAsset.name,
      sha256: headAssetSha256,
    };
  }
  return {
    headAssetSha256,
    projection: {
      contract: "hair-ahs-calibration-fingerprint/v1",
      headAssetOmitted: project.headAssetOmitted === true,
      headAsset: projectedHead,
      state: Object.fromEntries(
        CALIBRATION_FIELDS.map((field) => [field, state[field]]),
      ),
    },
    state,
  };
}

function registryTransform(): HairImportTransformV1 {
  const value = registeredCalibrations.batshitTemplate.recommendedTransform;
  return {
    contract: HAIR_IMPORT_TRANSFORM_CONTRACT,
    translation: [
      finite(value.translation[0], "registered transform translation.x"),
      finite(value.translation[1], "registered transform translation.y"),
      finite(value.translation[2], "registered transform translation.z"),
    ],
    rotation: [0, 0, 0],
    uniformScale: finite(
      value.uniformScale,
      "registered transform uniformScale",
    ),
    axisScale: [
      finite(value.axisScale[0], "registered transform axisScale.x"),
      finite(value.axisScale[1], "registered transform axisScale.y"),
      finite(value.axisScale[2], "registered transform axisScale.z"),
    ],
  };
}

export async function parseHairImportAhsCalibration(input: {
  bytes: Uint8Array;
  filename: string;
}): Promise<HairImportAhsCalibrationV1> {
  if (!/\.ahs$/i.test(input.filename)) {
    invalid("Anime Hair Studio calibration must use the .ahs extension.");
  }
  if (input.bytes.byteLength === 0) {
    invalid("Anime Hair Studio calibration file is empty.");
  }
  if (input.bytes.byteLength > HAIR_IMPORT_AHS_MAX_BYTES) {
    invalid(
      `Anime Hair Studio calibration exceeds the ${HAIR_IMPORT_AHS_MAX_BYTES.toLocaleString()}-byte limit.`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  } catch {
    invalid("Anime Hair Studio calibration is not valid UTF-8 JSON.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalid("Anime Hair Studio calibration is not valid JSON.");
  }
  assertJsonComplexity(parsed);
  const project = record(parsed, "Anime Hair Studio project");
  if (
    project.application !== "Anime Hair Studio" ||
    project.format !== "anime-hair-studio-project" ||
    project.version !== 1
  ) {
    invalid(
      "Calibration must be an Anime Hair Studio anime-hair-studio-project version 1 file.",
    );
  }
  const { headAssetSha256, projection, state } =
    await calibrationProjection(project);
  const fingerprint = await canonicalRecipeSha256(projection);
  const recognition: Recognition =
    fingerprint === registeredCalibrations.batshitTemplate.fingerprint
      ? "batshit-template"
      : fingerprint === registeredCalibrations.stockTemplate.fingerprint
        ? "stock-template"
        : "unrecognized";
  const recommendedTransform =
    recognition === "unrecognized" ? null : registryTransform();
  const sourceCalibration: HairImportSourceCalibrationV1 | null =
    recognition === "stock-template"
      ? {
          contract: "hair-import-source-calibration/v1",
          mode: "stock-scalp-deformation/v1",
          sourceScalpPoints: parseScalpPoints(
            state.scalpBuilderEditedPoints,
            "Anime Hair Studio stock scalp points",
          ),
          targetScalpPoints: parseScalpPoints(
            registeredCalibrations.batshitTemplate.scalpPoints,
            "registered Batshit scalp points",
          ),
        }
      : recognition === "batshit-template"
        ? {
            contract: "hair-import-source-calibration/v1",
            mode: "registered-template/v1",
            sourceScalpPoints: null,
            targetScalpPoints: null,
          }
        : null;
  const notices =
    recognition === "batshit-template"
      ? [
          "Recognized the Batshit Base Female Anime Hair Studio template. Batshit applied its registered deterministic starting fit.",
        ]
      : recognition === "stock-template"
        ? [
            "Recognized the stock Anime Hair Studio scalp. Batshit converted roots toward the registered Batshit scalp and preserved distal shape; inspect the full hairstyle before saving.",
          ]
        : [
            "This valid Anime Hair Studio project is not a registered Batshit or stock calibration. Batshit kept the normal generic fit and did not guess a scalp conversion.",
          ];
  return {
    contract: HAIR_IMPORT_AHS_CALIBRATION_CONTRACT,
    originalName: input.filename,
    sha256: await sha256Hex(input.bytes),
    bytes: input.bytes.byteLength,
    projectVersion: 1,
    fingerprint,
    recognition,
    headAssetSha256,
    recommendedTransform,
    sourceCalibration,
    requiresVisualReview: recognition === "stock-template",
    notices,
  };
}

export function parseStoredHairImportAhsCalibration(
  value: unknown,
): HairImportAhsCalibrationV1 | null {
  if (value === null) return null;
  const raw = record(value, "Stored Anime Hair Studio calibration");
  if (
    raw.contract !== HAIR_IMPORT_AHS_CALIBRATION_CONTRACT ||
    typeof raw.originalName !== "string" ||
    !/\.ahs$/i.test(raw.originalName) ||
    typeof raw.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.sha256) ||
    !Number.isSafeInteger(raw.bytes) ||
    (raw.bytes as number) <= 0 ||
    raw.projectVersion !== 1 ||
    typeof raw.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.fingerprint) ||
    !["batshit-template", "stock-template", "unrecognized"].includes(
      raw.recognition as string,
    ) ||
    typeof raw.requiresVisualReview !== "boolean" ||
    !Array.isArray(raw.notices) ||
    raw.notices.some((entry) => typeof entry !== "string" || !entry)
  ) {
    throw new HairImportJobError(
      "INVALID_STATE",
      "Stored Anime Hair Studio calibration is malformed.",
      500,
    );
  }
  return value as HairImportAhsCalibrationV1;
}
