import type {
  FacialArtworkDefinition,
  FacialArtworkRoleId,
} from "../facialArtwork";

const SHA = "a".repeat(64);

export function buildFacialArtworkV6DefinitionFixture(): FacialArtworkDefinition {
  const roleIds = [
    "brows",
    "lashes_eye_outline",
    "iris",
    "pupil",
    "eye_highlight",
    "sclera",
  ] as const;
  const asset = (role: FacialArtworkRoleId, name: string) => ({
    path: `goons/facial-artwork/v6/test-v6/${role}/${name}.png`,
    sha256: SHA,
  });
  const templates = roleIds.map((role) => {
    const anatomical = role === "brows" || role === "lashes_eye_outline";
    return {
      id: `${role}-template`,
      version: "6.0.0",
      dimensions: (role === "sclera" ? [2048, 1024] : [1024, 1024]) as [
        number,
        number,
      ],
      pixelContract: {
        format: "PNG" as const,
        channels: "RGBA8" as const,
        colorSpace: "sRGB" as const,
        alpha: "straight" as const,
        interlaced: false as const,
      },
      guide: asset(role, "guide-anatomical-left"),
      safePaintMask: {
        ...asset(role, "mask-anatomical-left"),
        channels: "L8" as const,
        paintThreshold: 1,
      },
      transparentBlank: asset(role, "blank"),
      semanticMap: null,
      canonicalOrientation: anatomical
        ? ("anatomical-left" as const)
        : ("orientation-neutral" as const),
      transformOriginUv: [0.5, 0.5] as [number, number],
      mirroredHorizontalVariant: anatomical
        ? {
            orientation: "anatomical-right" as const,
            label: `Goon's Right ${role === "brows" ? "Brow" : "Eye"} (viewer's left)`,
            guide: asset(role, "guide-anatomical-right"),
            safePaintMask: {
              ...asset(role, "mask-anatomical-right"),
              channels: "L8" as const,
              paintThreshold: 1,
            },
            semanticMap: null,
          }
        : null,
      orientationReference: anatomical
        ? asset(role, "orientation-reference")
        : null,
    };
  });
  const roles = roleIds.map((role) => {
    const canvas = role === "brows" || role === "lashes_eye_outline";
    const longitude = role === "sclera";
    const highlight = role === "eye_highlight";
    const compositeLayer =
      role === "iris" || role === "pupil"
        ? role
        : highlight
          ? "highlight"
          : longitude
            ? "scleraArtwork"
            : null;
    const bindingKind =
      role === "brows"
        ? "face-conformal-canvas"
        : role === "lashes_eye_outline"
          ? "eye-aperture-liner"
          : "physical-eye-layer";
    const runtimeNode = (side: "left" | "right") => {
      if (role === "brows")
        return side === "left" ? "bs_f1_brow_canvas_l" : "bs_f1_brow_canvas_r";
      if (role === "lashes_eye_outline") {
        return side === "left"
          ? "bs_f1_eye_treatment_l"
          : "bs_f1_eye_treatment_r";
      }
      return side === "left" ? "bs_f1_eye_l_physical" : "bs_f1_eye_r_physical";
    };
    const editableTransforms = longitude
      ? ["longitudeDegrees"]
      : role === "iris" || role === "pupil"
        ? ["rotationDegrees"]
        : ["translateU", "translateV", "scale", "rotationDegrees"];
    const transformBounds = longitude
      ? { longitudeDegrees: [-180, 180] as [number, number] }
      : role === "iris" || role === "pupil"
        ? { rotationDegrees: [-180, 180] as [number, number] }
        : {
            translateU: [-0.25, 0.25] as [number, number],
            translateV: [-0.25, 0.25] as [number, number],
            scale: [0.5, 1.5] as [number, number],
            rotationDegrees: [-180, 180] as [number, number],
          };
    return {
      id: role,
      template: `${role}-template`,
      ownership: canvas
        ? ("canvas" as const)
        : highlight
          ? ("lit-overlay" as const)
          : ("lit-surface" as const),
      mapping: longitude
        ? ("longitude" as const)
        : canvas
          ? ("planar" as const)
          : ("radial" as const),
      projection: longitude
        ? ("full-sphere-equirectangular-gaze-linked/v1" as const)
        : highlight
          ? ("fixed-front-cornea-space-unmirrored/v1" as const)
          : canvas
            ? ("planar-canvas" as const)
            : ("sphere-tangent-radial" as const),
      editableTransforms,
      rotationLaw: longitude
        ? ("additive-to-gaze-longitude" as const)
        : ("artwork-local" as const),
      bilateralLaw: highlight
        ? ("shared-unmirrored-same-orientation" as const)
        : ("shared-horizontal-mirror-with-same-value-transforms" as const),
      alphaPolicy: longitude
        ? {
            emptyArtworkAllowed: false as const,
            fullyOpaqueAllowed: true,
            transparencyRequired: false,
          }
        : {
            emptyArtworkAllowed: false as const,
            fullyOpaqueAllowed: false,
            transparencyRequired: true,
          },
      target: Object.fromEntries(
        (["left", "right"] as const).map((side) => [
          side,
          {
            runtimeNodes: [runtimeNode(side)] as [string],
            mirrorU: side === "right" && !highlight && !canvas,
            mirrorV: false as const,
            bindingKind,
            compositeLayer,
          },
        ]),
      ) as FacialArtworkDefinition["roles"][number]["target"],
      defaultEyeState: {
        visible: !canvas && !highlight,
        baseColor:
          role === "iris" || role === "pupil" || longitude
            ? ([0.2, 0.3, 0.4] as [number, number, number])
            : null,
        artwork: null,
      },
      defaultMode: "shared" as const,
      transformBounds,
    };
  }) as FacialArtworkDefinition["roles"];

  return {
    schemaVersion: "facial-artwork/v6",
    stateSchemaVersion: "facial-artwork-state/v6",
    status: "product-export-approved",
    productExportApproved: true,
    definitionSha256: "b".repeat(64),
    dependencies: {
      eyeAppearance: {
        schemaVersion: "eye-appearance/v5",
        definitionSha256: "c".repeat(64),
      },
      socketEyeSurface: {
        schemaVersion: "socket-eye-surface/v2",
        definitionSha256: "d".repeat(64),
      },
      eyeApertureSeam: {
        schemaVersion: "eye-aperture-seam/v2",
        definitionSha256: "e".repeat(64),
      },
    },
    templateSet: { id: "test-v6", version: "6.0.0" },
    templates,
    roles,
    trustedArtwork: {
      sourceReceiptSha256: "f".repeat(64),
      entries: roleIds.map((role) => ({
        role,
        side: "shared" as const,
        asset: asset(role, "trusted-artwork"),
        sourceSha256: SHA,
        derivation: "exact-source-bytes" as const,
        derivedFromSha256: null,
      })),
    },
  };
}
