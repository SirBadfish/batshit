import { FACIAL_ARTWORK_SCHEMA_VERSION } from "$lib/goons/facialArtwork";

const REQUIRED_EYE_APPEARANCE_SCHEMA_VERSION = "eye-appearance/v5";
const REQUIRED_SOCKET_EYE_SURFACE_SCHEMA_VERSION = "socket-eye-surface/v2";
const REQUIRED_EYE_APERTURE_SEAM_SCHEMA_VERSION = "eye-aperture-seam/v2";

type PackageAppearanceManifest = {
  facialArtwork?: unknown;
  eyeAppearance?: unknown;
  socketEyeSurface?: unknown;
  eyeApertureSeam?: unknown;
};

export const RETIRED_FACIAL_ARTWORK_PACKAGE_NOTICE =
  "This Goon uses an older Facial Artwork package. Open Goon File, choose Update Goon File Package, then Save Goon to use Facial Artwork and Eye Appearance.";

export type FacialArtworkPackageCapability =
  | { status: "absent" }
  | { status: "current" }
  | { status: "retired"; notice: string; schemaVersion: string }
  | { status: "malformed"; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function malformed(error: string): FacialArtworkPackageCapability {
  return { status: "malformed", error };
}

function dependencyMatches(
  value: unknown,
  schemaVersion: string,
  definitionSha256: unknown,
) {
  return (
    isRecord(value) &&
    value.schemaVersion === schemaVersion &&
    typeof definitionSha256 === "string" &&
    value.definitionSha256 === definitionSha256
  );
}

export function classifyFacialArtworkPackageCapability(
  manifest: PackageAppearanceManifest,
): FacialArtworkPackageCapability {
  const facialArtwork = manifest.facialArtwork;
  const eyeAppearance = manifest.eyeAppearance;
  const socketEyeSurface = manifest.socketEyeSurface;
  const eyeApertureSeam = manifest.eyeApertureSeam;

  if (facialArtwork === undefined || facialArtwork === null) {
    if (
      eyeAppearance !== undefined &&
      eyeAppearance !== null ||
      socketEyeSurface !== undefined &&
      socketEyeSurface !== null ||
      eyeApertureSeam !== undefined &&
      eyeApertureSeam !== null
    ) {
      return malformed(
        "The Goon package has a partial socket-eye tuple without its required Facial Artwork definition.",
      );
    }
    return { status: "absent" };
  }

  if (
    !isRecord(facialArtwork) ||
    typeof facialArtwork.schemaVersion !== "string"
  ) {
    return malformed(
      "The Goon package has an invalid Facial Artwork definition.",
    );
  }

  const schemaVersion = facialArtwork.schemaVersion;
  if (
    schemaVersion === "facial-artwork/v1" ||
    schemaVersion === "facial-artwork/v2" ||
    schemaVersion === "facial-artwork/v3" ||
    schemaVersion === "facial-artwork/v4" ||
    schemaVersion === "facial-artwork/v5"
  ) {
    return {
      status: "retired",
      notice: RETIRED_FACIAL_ARTWORK_PACKAGE_NOTICE,
      schemaVersion,
    };
  }

  if (schemaVersion !== FACIAL_ARTWORK_SCHEMA_VERSION) {
    return malformed(
      `This Batshit build does not support the Goon package's Facial Artwork definition (${schemaVersion}).`,
    );
  }

  if (!isRecord(eyeAppearance)) {
    return malformed(
      "The Goon package is missing the Eye Appearance definition required by Facial Artwork v6.",
    );
  }
  if (eyeAppearance.schemaVersion !== REQUIRED_EYE_APPEARANCE_SCHEMA_VERSION) {
    return malformed(
      "The Goon package has an unsupported Eye Appearance definition.",
    );
  }

  if (
    !isRecord(socketEyeSurface) ||
    socketEyeSurface.schemaVersion !== REQUIRED_SOCKET_EYE_SURFACE_SCHEMA_VERSION
  ) {
    return malformed(
      "The Goon package is missing the socket-eye-surface/v2 definition required by Facial Artwork v6.",
    );
  }
  if (
    !isRecord(eyeApertureSeam) ||
    eyeApertureSeam.schemaVersion !== REQUIRED_EYE_APERTURE_SEAM_SCHEMA_VERSION
  ) {
    return malformed(
      "The Goon package is missing the eye-aperture-seam/v2 definition required by Facial Artwork v6.",
    );
  }

  const eyeDependencies = isRecord(eyeAppearance.dependencies)
    ? eyeAppearance.dependencies
    : null;
  const artworkDependencies = isRecord(facialArtwork.dependencies)
    ? facialArtwork.dependencies
    : null;
  if (
    !eyeDependencies ||
    !dependencyMatches(
      eyeDependencies.socketEyeSurface,
      REQUIRED_SOCKET_EYE_SURFACE_SCHEMA_VERSION,
      socketEyeSurface.definitionSha256,
    ) ||
    !dependencyMatches(
      eyeDependencies.eyeApertureSeam,
      REQUIRED_EYE_APERTURE_SEAM_SCHEMA_VERSION,
      eyeApertureSeam.definitionSha256,
    )
  ) {
    return malformed(
      "The Goon package Eye Appearance definition does not match its socket-eye dependencies.",
    );
  }
  if (
    !artworkDependencies ||
    !dependencyMatches(
      artworkDependencies.eyeAppearance,
      REQUIRED_EYE_APPEARANCE_SCHEMA_VERSION,
      eyeAppearance.definitionSha256,
    ) ||
    !dependencyMatches(
      artworkDependencies.socketEyeSurface,
      REQUIRED_SOCKET_EYE_SURFACE_SCHEMA_VERSION,
      socketEyeSurface.definitionSha256,
    ) ||
    !dependencyMatches(
      artworkDependencies.eyeApertureSeam,
      REQUIRED_EYE_APERTURE_SEAM_SCHEMA_VERSION,
      eyeApertureSeam.definitionSha256,
    )
  ) {
    return malformed(
      "The Goon package Facial Artwork definition does not match the installed Eye Appearance and socket-eye definitions.",
    );
  }

  return { status: "current" };
}
