import {
  LEGACY_SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
  LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
  SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
  SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT,
  SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
  SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
} from "./socketEyeArtworkProjection";

export const FACIAL_ARTWORK_V6_SCHEMA_VERSION = "facial-artwork/v6" as const;
export const FACIAL_ARTWORK_V6_STATE_SCHEMA_VERSION =
  "facial-artwork-state/v6" as const;

export const FACIAL_ARTWORK_V6_ROLE_IDS = [
  "brows",
  "lashes_eye_outline",
  "iris",
  "pupil",
  "eye_highlight",
  "sclera",
] as const;

export type FacialArtworkV6RoleId = (typeof FACIAL_ARTWORK_V6_ROLE_IDS)[number];
export type FacialArtworkV6Side = "left" | "right";
export type FacialArtworkV6Orientation =
  "orientation-neutral" | "anatomical-left" | "anatomical-right";
export type FacialArtworkV6Rgb = [number, number, number];
export type FacialArtworkV6Rgba = [number, number, number, number];

export const FACIAL_ARTWORK_V6_EDITABLE_TRANSFORMS = {
  brows: ["translateU", "translateV", "scale", "rotationDegrees"],
  lashes_eye_outline: ["translateU", "translateV", "scale", "rotationDegrees"],
  iris: ["rotationDegrees"],
  pupil: ["rotationDegrees"],
  eye_highlight: ["translateU", "translateV", "scale", "rotationDegrees"],
  sclera: ["longitudeDegrees"],
} as const satisfies Record<FacialArtworkV6RoleId, readonly string[]>;

export type FacialArtworkV6Asset = { path: string; sha256: string };
export type FacialArtworkV6MaskAsset = FacialArtworkV6Asset & {
  channels: "L8";
  paintThreshold: number;
};
export type FacialArtworkV6SemanticMapAsset = FacialArtworkV6Asset & {
  palette: Record<string, number>;
};

export type FacialArtworkV6TemplateVariant = {
  orientation: "anatomical-right";
  label: string;
  guide: FacialArtworkV6Asset;
  safePaintMask: FacialArtworkV6MaskAsset;
  semanticMap: FacialArtworkV6SemanticMapAsset | null;
};

export type FacialArtworkV6Template = {
  id: string;
  version: string;
  dimensions: [number, number];
  pixelContract: {
    format: "PNG";
    channels: "RGBA8";
    colorSpace: "sRGB";
    alpha: "straight";
    interlaced: false;
  };
  guide: FacialArtworkV6Asset;
  safePaintMask: FacialArtworkV6MaskAsset;
  transparentBlank: FacialArtworkV6Asset;
  semanticMap: FacialArtworkV6SemanticMapAsset | null;
  canonicalOrientation: "orientation-neutral" | "anatomical-left";
  transformOriginUv: [number, number];
  mirroredHorizontalVariant: FacialArtworkV6TemplateVariant | null;
  orientationReference: FacialArtworkV6Asset | null;
};

export type FacialArtworkV6TemplateBinding = {
  id: string;
  version: string;
  orientation: FacialArtworkV6Orientation;
  guideSha256: string;
  maskSha256: string;
};

export type FacialArtworkV6Provenance = {
  sourceKind:
    | "batshit-original"
    | "user-authored"
    | "comfyui-generated"
    | "approved-external";
  author: string;
  license: string;
  rightsConfirmed: true;
};

export type FacialArtworkV6Upload = {
  role: FacialArtworkV6RoleId;
  url: string;
  filename: string;
  size: number;
  mimeType: "image/png";
  sha256: string;
  template: FacialArtworkV6TemplateBinding;
  provenance: FacialArtworkV6Provenance;
};

export type FacialArtworkV6PlanarTransform = {
  translateU: number;
  translateV: number;
  scale: number;
  rotationDegrees: number;
};
export type FacialArtworkV6RotationOnlyTransform = {
  translateU: 0;
  translateV: 0;
  scale: 1;
  rotationDegrees: number;
};
export type FacialArtworkV6LongitudeTransform = { longitudeDegrees: number };

type FacialArtworkV6LayerBase = {
  upload: FacialArtworkV6Upload;
  tint: FacialArtworkV6Rgba;
  opacity: number;
};

export type FacialArtworkV6ArtworkLayer =
  | (FacialArtworkV6LayerBase & {
      mapping: "planar";
      transform: FacialArtworkV6PlanarTransform;
    })
  | (FacialArtworkV6LayerBase & {
      mapping: "radial";
      transform:
        FacialArtworkV6PlanarTransform | FacialArtworkV6RotationOnlyTransform;
    })
  | (FacialArtworkV6LayerBase & {
      mapping: "longitude";
      transform: FacialArtworkV6LongitudeTransform;
    });

export type FacialArtworkV6EyeState = {
  visible: boolean;
  baseColor: FacialArtworkV6Rgb | null;
  artwork: FacialArtworkV6ArtworkLayer | null;
};

export type FacialArtworkV6RoleState =
  | { mode: "shared"; shared: FacialArtworkV6EyeState }
  | {
      mode: "per-eye";
      left: FacialArtworkV6EyeState;
      right: FacialArtworkV6EyeState;
    };

export type FacialArtworkStateV6 = {
  schemaVersion: typeof FACIAL_ARTWORK_V6_STATE_SCHEMA_VERSION;
  definitionSha256: string;
  templateSet: { id: string; version: string };
  roles: Record<FacialArtworkV6RoleId, FacialArtworkV6RoleState>;
};

export type FacialArtworkV6RuntimeTarget = {
  runtimeNodes: [string];
  mirrorU: boolean;
  mirrorV: false;
  bindingKind:
    "face-conformal-canvas" | "eye-aperture-liner" | "physical-eye-layer";
  compositeLayer: "scleraArtwork" | "iris" | "pupil" | "highlight" | null;
};

export type FacialArtworkV6PlanarBounds = {
  translateU: [number, number];
  translateV: [number, number];
  scale: [number, number];
  rotationDegrees: [number, number];
};
export type FacialArtworkV6RotationBounds = {
  rotationDegrees: [number, number];
};
export type FacialArtworkV6LongitudeBounds = {
  longitudeDegrees: [number, number];
};

export type FacialArtworkV6RoleDefinition = {
  id: FacialArtworkV6RoleId;
  template: string;
  ownership: "canvas" | "lit-surface" | "lit-overlay";
  mapping: "planar" | "radial" | "longitude";
  projection:
    | "planar-canvas"
    | typeof LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT
    | typeof SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT
    | typeof SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT
    | typeof LEGACY_SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT
    | typeof SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT
    | typeof SOCKET_EYE_SCLERA_PROJECTION_CONTRACT;
  editableTransforms: readonly string[];
  rotationLaw: "artwork-local" | "additive-to-gaze-longitude";
  bilateralLaw:
    | "shared-horizontal-mirror-with-same-value-transforms"
    | "shared-unmirrored-same-orientation";
  alphaPolicy: {
    emptyArtworkAllowed: false;
    fullyOpaqueAllowed: boolean;
    transparencyRequired: boolean;
  };
  target: Record<FacialArtworkV6Side, FacialArtworkV6RuntimeTarget>;
  defaultEyeState: FacialArtworkV6EyeState;
  defaultMode: "shared";
  transformBounds:
    | FacialArtworkV6PlanarBounds
    | FacialArtworkV6RotationBounds
    | FacialArtworkV6LongitudeBounds;
};

export type FacialArtworkV6TrustedArtworkEntry = {
  role: FacialArtworkV6RoleId;
  side: "shared" | FacialArtworkV6Side;
  asset: FacialArtworkV6Asset;
  sourceSha256: string;
  derivation:
    | "exact-source-bytes"
    | "horizontal-mirror-of-left"
    | "piecewise-affine-uv-remap";
  derivedFromSha256: string | null;
};

export type FacialArtworkDefinitionV6 = {
  schemaVersion: typeof FACIAL_ARTWORK_V6_SCHEMA_VERSION;
  stateSchemaVersion: typeof FACIAL_ARTWORK_V6_STATE_SCHEMA_VERSION;
  status: "product-export-approved";
  productExportApproved: true;
  definitionSha256: string;
  dependencies: {
    eyeAppearance: {
      schemaVersion: "eye-appearance/v5";
      definitionSha256: string;
    };
    socketEyeSurface: {
      schemaVersion: "socket-eye-surface/v2";
      definitionSha256: string;
    };
    eyeApertureSeam: {
      schemaVersion: "eye-aperture-seam/v2";
      definitionSha256: string;
    };
  };
  templateSet: { id: string; version: string };
  templates: FacialArtworkV6Template[];
  roles: FacialArtworkV6RoleDefinition[];
  trustedArtwork: {
    sourceReceiptSha256: string;
    entries: FacialArtworkV6TrustedArtworkEntry[];
  };
};

export type FacialArtworkV6Reconciliation = {
  state: FacialArtworkStateV6 | null;
  incompatible: boolean;
  reason?: string;
};

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PUBLIC_PREFIX = "goons/facial-artwork/v6/";
const SOURCE_KINDS = new Set<FacialArtworkV6Provenance["sourceKind"]>([
  "batshit-original",
  "user-authored",
  "comfyui-generated",
  "approved-external",
]);
const COLOR_ROLES = new Set<FacialArtworkV6RoleId>(["iris", "pupil", "sclera"]);

function fail(message: string): never {
  throw new Error(`[${FACIAL_ARTWORK_V6_SCHEMA_VERSION}] ${message}`);
}

export type FacialArtworkV6ResolvedTemplateVariant = {
  orientation: FacialArtworkV6Orientation;
  label: string;
  guide: FacialArtworkV6Asset;
  safePaintMask: FacialArtworkV6MaskAsset;
  semanticMap: FacialArtworkV6SemanticMapAsset | null;
};

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail(`${context} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${context} must contain exactly: ${wanted.join(", ")}`);
  }
}

function text(value: unknown, context: string) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    fail(`${context} must be a non-empty trimmed string`);
  }
  return value;
}

function finite(value: unknown, context: string) {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(`${context} must be finite`);
  return value;
}

function unit(value: unknown, context: string) {
  const parsed = finite(value, context);
  if (parsed < 0 || parsed > 1) fail(`${context} must be inside [0, 1]`);
  return parsed;
}

// RedisJSON stores JSON numbers as binary floating-point values. Long channel
// fractions such as 238 / 255 can return with the final decimal rounded in the
// opposite direction, which is visually irrelevant but must not invalidate a
// hash-bound Recipe sibling. Six decimal places retain sub-8-bit precision and
// produce a stable number across browser JSON and RedisJSON round trips.
function storageStableUnit(value: unknown, context: string) {
  return Math.round(unit(value, context) * 1_000_000) / 1_000_000;
}

function hash(value: unknown, context: string) {
  const parsed = text(value, context);
  if (!HASH_PATTERN.test(parsed))
    fail(`${context} must be a lowercase SHA-256`);
  return parsed;
}

function literal<T extends string | number | boolean | null>(
  value: unknown,
  expected: T,
  context: string,
): T {
  if (value !== expected) fail(`${context} must be ${String(expected)}`);
  return expected;
}

function tuple2(value: unknown, context: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2)
    fail(`${context} must contain two numbers`);
  const result: [number, number] = [
    finite(value[0], `${context}[0]`),
    finite(value[1], `${context}[1]`),
  ];
  if (result[0] > result[1]) fail(`${context} minimum must not exceed maximum`);
  return result;
}

function rgb(value: unknown, context: string): FacialArtworkV6Rgb {
  if (!Array.isArray(value) || value.length !== 3)
    fail(`${context} must contain three channels`);
  return value.map((entry, index) =>
    storageStableUnit(entry, `${context}[${index}]`),
  ) as FacialArtworkV6Rgb;
}

function rgba(value: unknown, context: string): FacialArtworkV6Rgba {
  if (!Array.isArray(value) || value.length !== 4)
    fail(`${context} must contain four channels`);
  return value.map((entry, index) =>
    storageStableUnit(entry, `${context}[${index}]`),
  ) as FacialArtworkV6Rgba;
}

function publicPath(value: unknown, context: string) {
  const parsed = text(value, context);
  if (
    !parsed.startsWith(PUBLIC_PREFIX) ||
    parsed.includes("\\") ||
    parsed.split("/").includes("..") ||
    parsed.includes("_private")
  ) {
    fail(`${context} must use the canonical public v6 asset root`);
  }
  return parsed;
}

function asset(value: unknown, context: string): FacialArtworkV6Asset {
  const source = record(value, context);
  exactKeys(source, ["path", "sha256"], context);
  return {
    path: publicPath(source.path, `${context}.path`),
    sha256: hash(source.sha256, `${context}.sha256`),
  };
}

function mask(value: unknown, context: string): FacialArtworkV6MaskAsset {
  const source = record(value, context);
  exactKeys(source, ["path", "sha256", "channels", "paintThreshold"], context);
  literal(source.channels, "L8", `${context}.channels`);
  const paintThreshold = finite(
    source.paintThreshold,
    `${context}.paintThreshold`,
  );
  if (
    !Number.isInteger(paintThreshold) ||
    paintThreshold < 0 ||
    paintThreshold > 255
  ) {
    fail(`${context}.paintThreshold must be an integer inside [0, 255]`);
  }
  return {
    path: publicPath(source.path, `${context}.path`),
    sha256: hash(source.sha256, `${context}.sha256`),
    channels: "L8",
    paintThreshold,
  };
}

function semantic(
  value: unknown,
  context: string,
): FacialArtworkV6SemanticMapAsset | null {
  if (value === null) return null;
  const source = record(value, context);
  exactKeys(source, ["path", "sha256", "palette"], context);
  const paletteSource = record(source.palette, `${context}.palette`);
  if (Object.keys(paletteSource).length === 0)
    fail(`${context}.palette cannot be empty`);
  const palette: Record<string, number> = {};
  for (const [key, entry] of Object.entries(paletteSource)) {
    const channel = finite(entry, `${context}.palette.${key}`);
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      fail(`${context}.palette.${key} must be an integer inside [0, 255]`);
    }
    palette[text(key, `${context}.palette key`)] = channel;
  }
  return {
    path: publicPath(source.path, `${context}.path`),
    sha256: hash(source.sha256, `${context}.sha256`),
    palette,
  };
}

function template(value: unknown, context: string): FacialArtworkV6Template {
  const source = record(value, context);
  exactKeys(
    source,
    [
      "id",
      "version",
      "dimensions",
      "pixelContract",
      "guide",
      "safePaintMask",
      "transparentBlank",
      "semanticMap",
      "canonicalOrientation",
      "transformOriginUv",
      "mirroredHorizontalVariant",
      "orientationReference",
    ],
    context,
  );
  if (!Array.isArray(source.dimensions) || source.dimensions.length !== 2) {
    fail(`${context}.dimensions must contain width and height`);
  }
  const dimensions = source.dimensions.map((entry, index) => {
    const parsed = finite(entry, `${context}.dimensions[${index}]`);
    if (!Number.isSafeInteger(parsed) || parsed <= 0)
      fail(`${context}.dimensions must be positive integers`);
    return parsed;
  }) as [number, number];
  const pixel = record(source.pixelContract, `${context}.pixelContract`);
  exactKeys(
    pixel,
    ["format", "channels", "colorSpace", "alpha", "interlaced"],
    `${context}.pixelContract`,
  );
  literal(pixel.format, "PNG", `${context}.pixelContract.format`);
  literal(pixel.channels, "RGBA8", `${context}.pixelContract.channels`);
  literal(pixel.colorSpace, "sRGB", `${context}.pixelContract.colorSpace`);
  literal(pixel.alpha, "straight", `${context}.pixelContract.alpha`);
  literal(pixel.interlaced, false, `${context}.pixelContract.interlaced`);
  const canonicalOrientation = source.canonicalOrientation;
  if (
    canonicalOrientation !== "orientation-neutral" &&
    canonicalOrientation !== "anatomical-left"
  ) {
    fail(`${context}.canonicalOrientation is unsupported`);
  }
  let mirroredHorizontalVariant: FacialArtworkV6TemplateVariant | null = null;
  if (source.mirroredHorizontalVariant !== null) {
    const variant = record(
      source.mirroredHorizontalVariant,
      `${context}.mirroredHorizontalVariant`,
    );
    exactKeys(
      variant,
      ["orientation", "label", "guide", "safePaintMask", "semanticMap"],
      `${context}.mirroredHorizontalVariant`,
    );
    literal(
      variant.orientation,
      "anatomical-right",
      `${context}.mirroredHorizontalVariant.orientation`,
    );
    mirroredHorizontalVariant = {
      orientation: "anatomical-right",
      label: text(variant.label, `${context}.mirroredHorizontalVariant.label`),
      guide: asset(variant.guide, `${context}.mirroredHorizontalVariant.guide`),
      safePaintMask: mask(
        variant.safePaintMask,
        `${context}.mirroredHorizontalVariant.safePaintMask`,
      ),
      semanticMap: semantic(
        variant.semanticMap,
        `${context}.mirroredHorizontalVariant.semanticMap`,
      ),
    };
  }
  if (
    canonicalOrientation === "anatomical-left" &&
    mirroredHorizontalVariant === null
  ) {
    fail(
      `${context} anatomical-left template requires an anatomical-right variant`,
    );
  }
  if (
    canonicalOrientation === "orientation-neutral" &&
    mirroredHorizontalVariant !== null
  ) {
    fail(
      `${context} orientation-neutral template cannot declare a mirrored variant`,
    );
  }
  if (
    !Array.isArray(source.transformOriginUv) ||
    source.transformOriginUv.length !== 2
  ) {
    fail(`${context}.transformOriginUv must contain two coordinates`);
  }
  const transformOriginUv = source.transformOriginUv.map((entry, index) =>
    unit(entry, `${context}.transformOriginUv[${index}]`),
  ) as [number, number];
  return {
    id: text(source.id, `${context}.id`),
    version: text(source.version, `${context}.version`),
    dimensions,
    pixelContract: {
      format: "PNG",
      channels: "RGBA8",
      colorSpace: "sRGB",
      alpha: "straight",
      interlaced: false,
    },
    guide: asset(source.guide, `${context}.guide`),
    safePaintMask: mask(source.safePaintMask, `${context}.safePaintMask`),
    transparentBlank: asset(
      source.transparentBlank,
      `${context}.transparentBlank`,
    ),
    semanticMap: semantic(source.semanticMap, `${context}.semanticMap`),
    canonicalOrientation,
    transformOriginUv,
    mirroredHorizontalVariant,
    orientationReference:
      source.orientationReference === null
        ? null
        : asset(source.orientationReference, `${context}.orientationReference`),
  };
}

function expectedRole(role: FacialArtworkV6RoleId) {
  if (role === "brows") {
    return {
      ownership: "canvas",
      mapping: "planar",
      projection: "planar-canvas",
      bindingKind: "face-conformal-canvas",
      compositeLayer: null,
    };
  }
  if (role === "lashes_eye_outline") {
    return {
      ownership: "canvas",
      mapping: "planar",
      projection: "planar-canvas",
      bindingKind: "eye-aperture-liner",
      compositeLayer: null,
    };
  }
  if (role === "iris") {
    return {
      ownership: "lit-surface",
      mapping: "radial",
      projection: "sphere-tangent-radial",
      bindingKind: "physical-eye-layer",
      compositeLayer: "iris",
    };
  }
  if (role === "pupil") {
    return {
      ownership: "lit-surface",
      mapping: "radial",
      projection: "sphere-tangent-radial",
      bindingKind: "physical-eye-layer",
      compositeLayer: "pupil",
    };
  }
  if (role === "eye_highlight") {
    return {
      ownership: "lit-overlay",
      mapping: "radial",
      projection: SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
      bindingKind: "physical-eye-layer",
      compositeLayer: "highlight",
    };
  }
  return {
    ownership: "lit-surface",
    mapping: "longitude",
    projection: SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
    bindingKind: "physical-eye-layer",
    compositeLayer: "scleraArtwork",
  };
}

function bounds(value: unknown, role: FacialArtworkV6RoleId, context: string) {
  const source = record(value, context);
  const editable = FACIAL_ARTWORK_V6_EDITABLE_TRANSFORMS[role];
  exactKeys(source, editable, context);
  const parsed: Record<string, [number, number]> = {};
  for (const key of editable)
    parsed[key] = tuple2(source[key], `${context}.${key}`);
  if ("scale" in parsed && parsed.scale![0] <= 0)
    fail(`${context}.scale must stay greater than zero`);
  return parsed as FacialArtworkV6RoleDefinition["transformBounds"];
}

function target(
  value: unknown,
  role: FacialArtworkV6RoleId,
  side: FacialArtworkV6Side,
  context: string,
): FacialArtworkV6RuntimeTarget {
  const source = record(value, context);
  exactKeys(
    source,
    ["runtimeNodes", "mirrorU", "mirrorV", "bindingKind", "compositeLayer"],
    context,
  );
  if (!Array.isArray(source.runtimeNodes) || source.runtimeNodes.length !== 1) {
    fail(`${context}.runtimeNodes must contain exactly one node`);
  }
  const expected = expectedRole(role);
  literal(source.bindingKind, expected.bindingKind, `${context}.bindingKind`);
  literal(
    source.compositeLayer,
    expected.compositeLayer,
    `${context}.compositeLayer`,
  );
  literal(source.mirrorV, false, `${context}.mirrorV`);
  if (typeof source.mirrorU !== "boolean")
    fail(`${context}.mirrorU must be boolean`);
  if (role === "eye_highlight" && source.mirrorU !== false) {
    fail(`${context}.mirrorU must be false for fixed-cornea Highlight`);
  }
  if (side === "left" && source.mirrorU !== false)
    fail(`${context}.mirrorU must be false on the left`);
  return {
    runtimeNodes: [text(source.runtimeNodes[0], `${context}.runtimeNodes[0]`)],
    mirrorU: source.mirrorU,
    mirrorV: false,
    bindingKind:
      expected.bindingKind as FacialArtworkV6RuntimeTarget["bindingKind"],
    compositeLayer:
      expected.compositeLayer as FacialArtworkV6RuntimeTarget["compositeLayer"],
  };
}

function defaultEyeState(
  value: unknown,
  role: FacialArtworkV6RoleId,
  context: string,
) {
  const source = record(value, context);
  exactKeys(source, ["visible", "baseColor", "artwork"], context);
  if (typeof source.visible !== "boolean")
    fail(`${context}.visible must be boolean`);
  if (source.artwork !== null)
    fail(`${context}.artwork must be null in definition defaults`);
  if (COLOR_ROLES.has(role)) {
    if (source.baseColor === null)
      fail(`${context}.baseColor is required for ${role}`);
  } else if (source.baseColor !== null) {
    fail(`${context}.baseColor is unsupported for ${role}`);
  }
  return {
    visible: source.visible,
    baseColor:
      source.baseColor === null
        ? null
        : rgb(source.baseColor, `${context}.baseColor`),
    artwork: null,
  };
}

function roleDefinition(
  value: unknown,
  role: FacialArtworkV6RoleId,
  templateIds: ReadonlySet<string>,
  context: string,
): FacialArtworkV6RoleDefinition {
  const source = record(value, context);
  exactKeys(
    source,
    [
      "id",
      "template",
      "ownership",
      "mapping",
      "projection",
      "editableTransforms",
      "rotationLaw",
      "bilateralLaw",
      "alphaPolicy",
      "target",
      "defaultEyeState",
      "defaultMode",
      "transformBounds",
    ],
    context,
  );
  literal(source.id, role, `${context}.id`);
  const templateId = text(source.template, `${context}.template`);
  if (!templateIds.has(templateId)) fail(`${context}.template is not declared`);
  const expected = expectedRole(role);
  literal(source.ownership, expected.ownership, `${context}.ownership`);
  literal(source.mapping, expected.mapping, `${context}.mapping`);
  const allowedProjections =
    role === "iris" || role === "pupil"
      ? [
          LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
          SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
          SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT,
        ]
      : role === "eye_highlight"
        ? [
            LEGACY_SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
            SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
          ]
        : [expected.projection];
  if (!allowedProjections.includes(source.projection as never)) {
    fail(`${context}.projection must be ${allowedProjections.join(" or ")}`);
  }
  const editable = FACIAL_ARTWORK_V6_EDITABLE_TRANSFORMS[role];
  const editableTransforms = source.editableTransforms;
  if (
    !Array.isArray(editableTransforms) ||
    editableTransforms.length !== editable.length ||
    editable.some((entry, index) => editableTransforms[index] !== entry)
  ) {
    fail(`${context}.editableTransforms must equal ${editable.join(", ")}`);
  }
  const bilateralLaw =
    role === "eye_highlight"
      ? ("shared-unmirrored-same-orientation" as const)
      : ("shared-horizontal-mirror-with-same-value-transforms" as const);
  literal(source.bilateralLaw, bilateralLaw, `${context}.bilateralLaw`);
  const rotationLaw =
    role === "sclera"
      ? ("additive-to-gaze-longitude" as const)
      : ("artwork-local" as const);
  literal(source.rotationLaw, rotationLaw, `${context}.rotationLaw`);
  const alphaPolicy = record(source.alphaPolicy, `${context}.alphaPolicy`);
  exactKeys(
    alphaPolicy,
    ["emptyArtworkAllowed", "fullyOpaqueAllowed", "transparencyRequired"],
    `${context}.alphaPolicy`,
  );
  literal(
    alphaPolicy.emptyArtworkAllowed,
    false,
    `${context}.alphaPolicy.emptyArtworkAllowed`,
  );
  if (
    typeof alphaPolicy.fullyOpaqueAllowed !== "boolean" ||
    typeof alphaPolicy.transparencyRequired !== "boolean"
  ) {
    fail(`${context}.alphaPolicy values must be boolean`);
  }
  const correctedEdgeToEdgeRadialArtwork =
    (role === "iris" || role === "pupil") &&
    source.projection === SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT;
  if (role === "sclera" || correctedEdgeToEdgeRadialArtwork) {
    literal(
      alphaPolicy.fullyOpaqueAllowed,
      true,
      `${context}.alphaPolicy.fullyOpaqueAllowed`,
    );
    literal(
      alphaPolicy.transparencyRequired,
      false,
      `${context}.alphaPolicy.transparencyRequired`,
    );
  } else {
    literal(
      alphaPolicy.fullyOpaqueAllowed,
      false,
      `${context}.alphaPolicy.fullyOpaqueAllowed`,
    );
    literal(
      alphaPolicy.transparencyRequired,
      true,
      `${context}.alphaPolicy.transparencyRequired`,
    );
  }
  const targets = record(source.target, `${context}.target`);
  exactKeys(targets, ["left", "right"], `${context}.target`);
  return {
    id: role,
    template: templateId,
    ownership: expected.ownership as FacialArtworkV6RoleDefinition["ownership"],
    mapping: expected.mapping as FacialArtworkV6RoleDefinition["mapping"],
    projection:
      source.projection as FacialArtworkV6RoleDefinition["projection"],
    editableTransforms: [...editable],
    rotationLaw,
    bilateralLaw,
    alphaPolicy: {
      emptyArtworkAllowed: false,
      fullyOpaqueAllowed: alphaPolicy.fullyOpaqueAllowed,
      transparencyRequired: alphaPolicy.transparencyRequired,
    },
    target: {
      left: target(targets.left, role, "left", `${context}.target.left`),
      right: target(targets.right, role, "right", `${context}.target.right`),
    },
    defaultEyeState: defaultEyeState(
      source.defaultEyeState,
      role,
      `${context}.defaultEyeState`,
    ),
    defaultMode: literal(
      source.defaultMode,
      "shared",
      `${context}.defaultMode`,
    ),
    transformBounds: bounds(
      source.transformBounds,
      role,
      `${context}.transformBounds`,
    ),
  };
}

function dependency<
  T extends
    "eye-appearance/v5" | "socket-eye-surface/v2" | "eye-aperture-seam/v2",
>(value: unknown, schemaVersion: T, context: string) {
  const source = record(value, context);
  exactKeys(source, ["schemaVersion", "definitionSha256"], context);
  return {
    schemaVersion: literal(
      source.schemaVersion,
      schemaVersion,
      `${context}.schemaVersion`,
    ),
    definitionSha256: hash(
      source.definitionSha256,
      `${context}.definitionSha256`,
    ),
  };
}

function trustedEntry(
  value: unknown,
  context: string,
): FacialArtworkV6TrustedArtworkEntry {
  const source = record(value, context);
  exactKeys(
    source,
    [
      "role",
      "side",
      "asset",
      "sourceSha256",
      "derivation",
      "derivedFromSha256",
    ],
    context,
  );
  if (
    !FACIAL_ARTWORK_V6_ROLE_IDS.includes(source.role as FacialArtworkV6RoleId)
  ) {
    fail(`${context}.role is unsupported`);
  }
  if (
    source.side !== "shared" &&
    source.side !== "left" &&
    source.side !== "right"
  ) {
    fail(`${context}.side is unsupported`);
  }
  if (
    source.derivation !== "exact-source-bytes" &&
    source.derivation !== "horizontal-mirror-of-left" &&
    source.derivation !== "piecewise-affine-uv-remap"
  ) {
    fail(`${context}.derivation is unsupported`);
  }
  const derivedFromSha256 =
    source.derivedFromSha256 === null
      ? null
      : hash(source.derivedFromSha256, `${context}.derivedFromSha256`);
  if (
    (source.derivation === "horizontal-mirror-of-left" ||
      source.derivation === "piecewise-affine-uv-remap") &&
    derivedFromSha256 === null
  ) {
    fail(`${context}.derivedFromSha256 is required for derived artwork`);
  }
  if (
    source.derivation === "exact-source-bytes" &&
    derivedFromSha256 !== null
  ) {
    fail(`${context}.derivedFromSha256 must be null for exact source bytes`);
  }
  return {
    role: source.role as FacialArtworkV6RoleId,
    side: source.side,
    asset: asset(source.asset, `${context}.asset`),
    sourceSha256: hash(source.sourceSha256, `${context}.sourceSha256`),
    derivation: source.derivation,
    derivedFromSha256,
  };
}

export function parseFacialArtworkDefinitionV6(
  value: unknown,
): FacialArtworkDefinitionV6 {
  const source = record(value, "definition");
  exactKeys(
    source,
    [
      "schemaVersion",
      "stateSchemaVersion",
      "status",
      "productExportApproved",
      "definitionSha256",
      "dependencies",
      "templateSet",
      "templates",
      "roles",
      "trustedArtwork",
    ],
    "definition",
  );
  literal(
    source.schemaVersion,
    FACIAL_ARTWORK_V6_SCHEMA_VERSION,
    "definition.schemaVersion",
  );
  literal(
    source.stateSchemaVersion,
    FACIAL_ARTWORK_V6_STATE_SCHEMA_VERSION,
    "definition.stateSchemaVersion",
  );
  literal(source.status, "product-export-approved", "definition.status");
  literal(
    source.productExportApproved,
    true,
    "definition.productExportApproved",
  );
  const dependencies = record(source.dependencies, "definition.dependencies");
  exactKeys(
    dependencies,
    ["eyeAppearance", "socketEyeSurface", "eyeApertureSeam"],
    "definition.dependencies",
  );
  const templateSet = record(source.templateSet, "definition.templateSet");
  exactKeys(templateSet, ["id", "version"], "definition.templateSet");
  if (
    !Array.isArray(source.templates) ||
    source.templates.length !== FACIAL_ARTWORK_V6_ROLE_IDS.length
  ) {
    fail("definition.templates must contain exactly six role templates");
  }
  const templates = source.templates.map((entry, index) =>
    template(entry, `definition.templates[${index}]`),
  );
  const templateIds = new Set(templates.map((entry) => entry.id));
  if (templateIds.size !== templates.length)
    fail("definition template ids must be unique");
  const roleValues = source.roles;
  if (
    !Array.isArray(roleValues) ||
    roleValues.length !== FACIAL_ARTWORK_V6_ROLE_IDS.length
  ) {
    fail("definition.roles must contain exactly the six canonical roles");
  }
  const roles = FACIAL_ARTWORK_V6_ROLE_IDS.map((role, index) =>
    roleDefinition(
      roleValues[index],
      role,
      templateIds,
      `definition.roles[${index}]`,
    ),
  );
  const irisProjection = roles.find((entry) => entry.id === "iris")!.projection;
  const pupilProjection = roles.find(
    (entry) => entry.id === "pupil",
  )!.projection;
  const highlightProjection = roles.find(
    (entry) => entry.id === "eye_highlight",
  )!.projection;
  const legacyProjectionSuite =
    irisProjection === LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT &&
    pupilProjection === LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT &&
    highlightProjection === LEGACY_SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT;
  const correctedProjectionSuite =
    irisProjection === SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT &&
    pupilProjection === SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT &&
    highlightProjection === SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT;
  const correctedInsetProjectionSuite =
    irisProjection === SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT &&
    pupilProjection === SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT &&
    highlightProjection === SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT;
  if (
    !legacyProjectionSuite &&
    !correctedProjectionSuite &&
    !correctedInsetProjectionSuite
  ) {
    fail(
      "definition Iris, Pupil, and Eye Highlight projections must use one complete legacy, corrected edge-to-edge, or corrected inset suite",
    );
  }
  if (
    new Set(roles.map((entry) => entry.template)).size !==
    FACIAL_ARTWORK_V6_ROLE_IDS.length
  ) {
    fail("definition roles must bind six distinct templates");
  }
  const trusted = record(source.trustedArtwork, "definition.trustedArtwork");
  exactKeys(
    trusted,
    ["sourceReceiptSha256", "entries"],
    "definition.trustedArtwork",
  );
  if (
    !Array.isArray(trusted.entries) ||
    trusted.entries.length < FACIAL_ARTWORK_V6_ROLE_IDS.length
  ) {
    fail("definition.trustedArtwork.entries must cover all six roles");
  }
  const entries = trusted.entries.map((entry, index) =>
    trustedEntry(entry, `definition.trustedArtwork.entries[${index}]`),
  );
  for (const role of FACIAL_ARTWORK_V6_ROLE_IDS) {
    if (!entries.some((entry) => entry.role === role)) {
      fail(`definition.trustedArtwork.entries must cover ${role}`);
    }
  }
  return {
    schemaVersion: FACIAL_ARTWORK_V6_SCHEMA_VERSION,
    stateSchemaVersion: FACIAL_ARTWORK_V6_STATE_SCHEMA_VERSION,
    status: "product-export-approved",
    productExportApproved: true,
    definitionSha256: hash(
      source.definitionSha256,
      "definition.definitionSha256",
    ),
    dependencies: {
      eyeAppearance: dependency(
        dependencies.eyeAppearance,
        "eye-appearance/v5",
        "definition.dependencies.eyeAppearance",
      ),
      socketEyeSurface: dependency(
        dependencies.socketEyeSurface,
        "socket-eye-surface/v2",
        "definition.dependencies.socketEyeSurface",
      ),
      eyeApertureSeam: dependency(
        dependencies.eyeApertureSeam,
        "eye-aperture-seam/v2",
        "definition.dependencies.eyeApertureSeam",
      ),
    },
    templateSet: {
      id: text(templateSet.id, "definition.templateSet.id"),
      version: text(templateSet.version, "definition.templateSet.version"),
    },
    templates,
    roles,
    trustedArtwork: {
      sourceReceiptSha256: hash(
        trusted.sourceReceiptSha256,
        "definition.trustedArtwork.sourceReceiptSha256",
      ),
      entries,
    },
  };
}

export type FacialArtworkV6SocketProjectionMode =
  | "legacy"
  | "corrected"
  | "corrected-inset";

export function resolveFacialArtworkV6SocketProjectionMode(
  definition: FacialArtworkDefinitionV6,
): FacialArtworkV6SocketProjectionMode {
  const iris = definition.roles.find((entry) => entry.id === "iris");
  const pupil = definition.roles.find((entry) => entry.id === "pupil");
  const highlight = definition.roles.find(
    (entry) => entry.id === "eye_highlight",
  );
  if (!iris || !pupil || !highlight) {
    fail("definition is missing one or more Socket Eye artwork roles");
  }
  if (
    iris.projection === SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT &&
    pupil.projection === SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT &&
    highlight.projection === SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT
  ) {
    return "corrected-inset";
  }
  if (
    iris.projection === SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT &&
    pupil.projection === SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT &&
    highlight.projection === SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT
  ) {
    return "corrected";
  }
  if (
    iris.projection === LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT &&
    pupil.projection === LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT &&
    highlight.projection === LEGACY_SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT
  ) {
    return "legacy";
  }
  fail("definition Socket Eye artwork projection suite is inconsistent");
}

function templateBindingFor(
  definition: FacialArtworkDefinitionV6,
  role: FacialArtworkV6RoleId,
  orientation: FacialArtworkV6Orientation,
): FacialArtworkV6TemplateBinding {
  const roleDefinition = definition.roles.find((entry) => entry.id === role);
  const template = definition.templates.find(
    (entry) => entry.id === roleDefinition?.template,
  );
  if (!template) fail(`definition is missing the template for ${role}`);
  if (orientation === "anatomical-right") {
    if (!template.mirroredHorizontalVariant)
      fail(`${role} has no anatomical-right template`);
    return {
      id: template.id,
      version: template.version,
      orientation,
      guideSha256: template.mirroredHorizontalVariant.guide.sha256,
      maskSha256: template.mirroredHorizontalVariant.safePaintMask.sha256,
    };
  }
  if (orientation !== template.canonicalOrientation) {
    fail(`${role} upload orientation must match its template`);
  }
  return {
    id: template.id,
    version: template.version,
    orientation,
    guideSha256: template.guide.sha256,
    maskSha256: template.safePaintMask.sha256,
  };
}

function upload(
  definition: FacialArtworkDefinitionV6,
  value: unknown,
  role: FacialArtworkV6RoleId,
  context: string,
): FacialArtworkV6Upload {
  const source = record(value, context);
  exactKeys(
    source,
    [
      "role",
      "url",
      "filename",
      "size",
      "mimeType",
      "sha256",
      "template",
      "provenance",
    ],
    context,
  );
  literal(source.role, role, `${context}.role`);
  literal(source.mimeType, "image/png", `${context}.mimeType`);
  if (!Number.isSafeInteger(source.size) || (source.size as number) <= 0) {
    fail(`${context}.size must be a positive safe integer`);
  }
  const templateSource = record(source.template, `${context}.template`);
  exactKeys(
    templateSource,
    ["id", "version", "orientation", "guideSha256", "maskSha256"],
    `${context}.template`,
  );
  const orientation = templateSource.orientation as FacialArtworkV6Orientation;
  const expected = templateBindingFor(definition, role, orientation);
  for (const key of [
    "id",
    "version",
    "orientation",
    "guideSha256",
    "maskSha256",
  ] as const) {
    if (templateSource[key] !== expected[key])
      fail(`${context}.template.${key} does not match the definition`);
  }
  const provenance = record(source.provenance, `${context}.provenance`);
  exactKeys(
    provenance,
    ["sourceKind", "author", "license", "rightsConfirmed"],
    `${context}.provenance`,
  );
  if (
    !SOURCE_KINDS.has(
      provenance.sourceKind as FacialArtworkV6Provenance["sourceKind"],
    )
  ) {
    fail(`${context}.provenance.sourceKind is unsupported`);
  }
  literal(
    provenance.rightsConfirmed,
    true,
    `${context}.provenance.rightsConfirmed`,
  );
  return {
    role,
    url: text(source.url, `${context}.url`),
    filename: text(source.filename, `${context}.filename`),
    size: source.size as number,
    mimeType: "image/png",
    sha256: hash(source.sha256, `${context}.sha256`),
    template: expected,
    provenance: {
      sourceKind:
        provenance.sourceKind as FacialArtworkV6Provenance["sourceKind"],
      author: text(provenance.author, `${context}.provenance.author`),
      license: text(provenance.license, `${context}.provenance.license`),
      rightsConfirmed: true,
    },
  };
}

function transform(
  value: unknown,
  role: FacialArtworkV6RoleId,
  boundsDefinition: FacialArtworkV6RoleDefinition["transformBounds"],
  context: string,
): FacialArtworkV6ArtworkLayer["transform"] {
  const source = record(value, context);
  if (role === "sclera") {
    exactKeys(source, ["longitudeDegrees"], context);
    const value = finite(
      source.longitudeDegrees,
      `${context}.longitudeDegrees`,
    );
    const bounds = boundsDefinition as FacialArtworkV6LongitudeBounds;
    if (
      value < bounds.longitudeDegrees[0] ||
      value > bounds.longitudeDegrees[1]
    ) {
      fail(`${context}.longitudeDegrees must be inside its definition bounds`);
    }
    return { longitudeDegrees: value };
  }
  exactKeys(
    source,
    ["translateU", "translateV", "scale", "rotationDegrees"],
    context,
  );
  const parsed: FacialArtworkV6PlanarTransform = {
    translateU: finite(source.translateU, `${context}.translateU`),
    translateV: finite(source.translateV, `${context}.translateV`),
    scale: finite(source.scale, `${context}.scale`),
    rotationDegrees: finite(
      source.rotationDegrees,
      `${context}.rotationDegrees`,
    ),
  };
  if (role === "iris" || role === "pupil") {
    literal(parsed.translateU, 0, `${context}.translateU`);
    literal(parsed.translateV, 0, `${context}.translateV`);
    literal(parsed.scale, 1, `${context}.scale`);
    const bounds = boundsDefinition as FacialArtworkV6RotationBounds;
    if (
      parsed.rotationDegrees < bounds.rotationDegrees[0] ||
      parsed.rotationDegrees > bounds.rotationDegrees[1]
    ) {
      fail(`${context}.rotationDegrees must be inside its definition bounds`);
    }
    return parsed as FacialArtworkV6RotationOnlyTransform;
  }
  const bounds = boundsDefinition as FacialArtworkV6PlanarBounds;
  for (const key of [
    "translateU",
    "translateV",
    "scale",
    "rotationDegrees",
  ] as const) {
    if (parsed[key] < bounds[key][0] || parsed[key] > bounds[key][1]) {
      fail(`${context}.${key} must be inside its definition bounds`);
    }
  }
  if (parsed.scale <= 0) fail(`${context}.scale must be greater than zero`);
  return parsed;
}

function eyeState(
  definition: FacialArtworkDefinitionV6,
  value: unknown,
  role: FacialArtworkV6RoleId,
  context: string,
): FacialArtworkV6EyeState {
  const source = record(value, context);
  exactKeys(source, ["visible", "baseColor", "artwork"], context);
  if (typeof source.visible !== "boolean")
    fail(`${context}.visible must be boolean`);
  let baseColor: FacialArtworkV6Rgb | null = null;
  if (source.baseColor !== null) {
    if (!COLOR_ROLES.has(role))
      fail(`${context}.baseColor is unsupported for ${role}`);
    baseColor = rgb(source.baseColor, `${context}.baseColor`);
  }
  if (source.artwork === null)
    return { visible: source.visible, baseColor, artwork: null };
  const artwork = record(source.artwork, `${context}.artwork`);
  exactKeys(
    artwork,
    ["upload", "tint", "opacity", "mapping", "transform"],
    `${context}.artwork`,
  );
  const roleDefinition = definition.roles.find((entry) => entry.id === role);
  if (!roleDefinition) fail(`definition is missing ${role}`);
  literal(
    artwork.mapping,
    roleDefinition.mapping,
    `${context}.artwork.mapping`,
  );
  const common = {
    upload: upload(
      definition,
      artwork.upload,
      role,
      `${context}.artwork.upload`,
    ),
    tint: rgba(artwork.tint, `${context}.artwork.tint`),
    opacity: unit(artwork.opacity, `${context}.artwork.opacity`),
  };
  const parsedTransform = transform(
    artwork.transform,
    role,
    roleDefinition.transformBounds,
    `${context}.artwork.transform`,
  );
  if (roleDefinition.mapping === "longitude") {
    return {
      visible: source.visible,
      baseColor,
      artwork: {
        ...common,
        mapping: "longitude",
        transform: parsedTransform as FacialArtworkV6LongitudeTransform,
      },
    };
  }
  return {
    visible: source.visible,
    baseColor,
    artwork: {
      ...common,
      mapping: roleDefinition.mapping,
      transform: parsedTransform as FacialArtworkV6PlanarTransform,
    },
  };
}

function roleState(
  definition: FacialArtworkDefinitionV6,
  value: unknown,
  role: FacialArtworkV6RoleId,
): FacialArtworkV6RoleState {
  const context = `state.roles.${role}`;
  const source = record(value, context);
  if (source.mode === "shared") {
    exactKeys(source, ["mode", "shared"], context);
    return {
      mode: "shared",
      shared: eyeState(definition, source.shared, role, `${context}.shared`),
    };
  }
  if (source.mode === "per-eye") {
    exactKeys(source, ["mode", "left", "right"], context);
    return {
      mode: "per-eye",
      left: eyeState(definition, source.left, role, `${context}.left`),
      right: eyeState(definition, source.right, role, `${context}.right`),
    };
  }
  fail(`${context}.mode must be shared or per-eye`);
}

export function createDefaultFacialArtworkStateV6(
  definition: FacialArtworkDefinitionV6,
): FacialArtworkStateV6 {
  return {
    schemaVersion: FACIAL_ARTWORK_V6_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    templateSet: { ...definition.templateSet },
    roles: Object.fromEntries(
      definition.roles.map((role) => [
        role.id,
        {
          mode: "shared",
          shared: eyeState(
            definition,
            role.defaultEyeState,
            role.id,
            `definition.roles.${role.id}.defaultEyeState`,
          ),
        },
      ]),
    ) as Record<FacialArtworkV6RoleId, FacialArtworkV6RoleState>,
  };
}

export function parseFacialArtworkStateV6(
  definition: FacialArtworkDefinitionV6,
  value: unknown,
): FacialArtworkStateV6 {
  const source = record(value, "state");
  exactKeys(
    source,
    ["schemaVersion", "definitionSha256", "templateSet", "roles"],
    "state",
  );
  literal(
    source.schemaVersion,
    FACIAL_ARTWORK_V6_STATE_SCHEMA_VERSION,
    "state.schemaVersion",
  );
  if (source.definitionSha256 !== definition.definitionSha256) {
    fail("state.definitionSha256 does not match this package");
  }
  const templateSet = record(source.templateSet, "state.templateSet");
  exactKeys(templateSet, ["id", "version"], "state.templateSet");
  if (
    templateSet.id !== definition.templateSet.id ||
    templateSet.version !== definition.templateSet.version
  ) {
    fail("state.templateSet does not match this package");
  }
  const roleSource = record(source.roles, "state.roles");
  exactKeys(roleSource, FACIAL_ARTWORK_V6_ROLE_IDS, "state.roles");
  const roles = {} as Record<FacialArtworkV6RoleId, FacialArtworkV6RoleState>;
  for (const role of FACIAL_ARTWORK_V6_ROLE_IDS)
    roles[role] = roleState(definition, roleSource[role], role);
  return {
    schemaVersion: FACIAL_ARTWORK_V6_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    templateSet: { ...definition.templateSet },
    roles,
  };
}

export function reconcileFacialArtworkStateV6(
  definition: FacialArtworkDefinitionV6,
  value: unknown,
): FacialArtworkV6Reconciliation {
  if (value == null) return { state: null, incompatible: false };
  try {
    return {
      state: parseFacialArtworkStateV6(definition, value),
      incompatible: false,
    };
  } catch (error) {
    return {
      state: null,
      incompatible: true,
      reason:
        error instanceof Error
          ? error.message
          : "Facial Artwork v6 state is incompatible with this package.",
    };
  }
}

export function resolveFacialArtworkStateV6(
  definition: FacialArtworkDefinitionV6,
  value: FacialArtworkStateV6 | null | undefined,
) {
  return value
    ? parseFacialArtworkStateV6(definition, value)
    : createDefaultFacialArtworkStateV6(definition);
}

export function resolveFacialArtworkEyeStateV6(
  state: FacialArtworkStateV6,
  roleId: FacialArtworkV6RoleId,
  side: FacialArtworkV6Side,
) {
  const role = state.roles[roleId];
  return role.mode === "shared" ? role.shared : role[side];
}

export function resolveFacialArtworkTemplateVariantV6(
  template: FacialArtworkV6Template,
  orientation: FacialArtworkV6Orientation,
): FacialArtworkV6ResolvedTemplateVariant {
  if (orientation === template.canonicalOrientation) {
    const anatomicalFeature = template.id.includes("brow") ? "Brow" : "Eye";
    return {
      orientation,
      label:
        orientation === "anatomical-left"
          ? `Goon's Left ${anatomicalFeature} (viewer's right)`
          : "Orientation-neutral",
      guide: template.guide,
      safePaintMask: template.safePaintMask,
      semanticMap: template.semanticMap,
    };
  }
  if (
    orientation === "anatomical-right" &&
    template.mirroredHorizontalVariant
  ) {
    return template.mirroredHorizontalVariant;
  }
  fail(`${template.id} does not support ${orientation}`);
}

export function resolveFacialArtworkTemplateOrientationV6(
  template: FacialArtworkV6Template,
  side: FacialArtworkV6Side | "shared",
): FacialArtworkV6Orientation {
  if (template.canonicalOrientation === "orientation-neutral")
    return "orientation-neutral";
  return side === "right" ? "anatomical-right" : "anatomical-left";
}

export function createFacialArtworkArtworkLayerV6(
  definition: FacialArtworkDefinitionV6,
  roleId: FacialArtworkV6RoleId,
  uploadValue: FacialArtworkV6Upload,
): FacialArtworkV6ArtworkLayer {
  const role = definition.roles.find((candidate) => candidate.id === roleId);
  if (!role) fail(`definition has no role ${roleId}`);
  const parsedUpload = upload(
    definition,
    uploadValue,
    roleId,
    `upload.${roleId}`,
  );
  const base = {
    upload: parsedUpload,
    tint: [1, 1, 1, 1] as FacialArtworkV6Rgba,
    opacity: 1,
  };
  if (role.mapping === "longitude") {
    return {
      ...base,
      mapping: "longitude",
      transform: { longitudeDegrees: 0 },
    };
  }
  return {
    ...base,
    mapping: role.mapping,
    transform: { translateU: 0, translateV: 0, scale: 1, rotationDegrees: 0 },
  };
}

export function resolveFacialArtworkAssetUrlV6(path: string) {
  return `/${publicPath(path, "asset path")}`;
}

export function collectFacialArtworkUploadsV6(
  value: FacialArtworkStateV6 | null | undefined,
) {
  const uploads = new Map<string, FacialArtworkV6Upload>();
  if (!value) return [];
  for (const role of Object.values(value.roles)) {
    const eyes =
      role.mode === "shared" ? [role.shared] : [role.left, role.right];
    for (const eye of eyes) {
      const uploadValue = eye.artwork?.upload;
      if (uploadValue) uploads.set(uploadValue.filename, uploadValue);
    }
  }
  return [...uploads.values()];
}

export function collectFacialArtworkUploadUrlsV6(
  value: FacialArtworkStateV6 | null | undefined,
) {
  return new Set(
    collectFacialArtworkUploadsV6(value).map((uploadValue) => uploadValue.url),
  );
}
