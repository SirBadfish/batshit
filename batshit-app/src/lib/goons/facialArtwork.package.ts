import { EYE_APPEARANCE_SCHEMA_VERSION } from "$lib/goons/eyeAppearance";
import { FACIAL_ARTWORK_SCHEMA_VERSION } from "$lib/goons/facialArtwork";

type PackageAppearanceManifest = {
  facialArtwork?: unknown;
  eyeAppearance?: unknown;
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

export function classifyFacialArtworkPackageCapability(
  manifest: PackageAppearanceManifest,
): FacialArtworkPackageCapability {
  const facialArtwork = manifest.facialArtwork;
  const eyeAppearance = manifest.eyeAppearance;

  if (facialArtwork === undefined || facialArtwork === null) {
    if (eyeAppearance !== undefined && eyeAppearance !== null) {
      return malformed(
        "The Goon package has Eye Appearance without its required Facial Artwork definition.",
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
    schemaVersion === "facial-artwork/v2"
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
      "The Goon package is missing the Eye Appearance definition required by Facial Artwork v3.",
    );
  }
  if (eyeAppearance.schemaVersion !== EYE_APPEARANCE_SCHEMA_VERSION) {
    return malformed(
      "The Goon package has an unsupported Eye Appearance definition.",
    );
  }

  const dependency = eyeAppearance.facialArtworkDependency;
  if (
    !isRecord(dependency) ||
    dependency.schemaVersion !== FACIAL_ARTWORK_SCHEMA_VERSION
  ) {
    return malformed(
      "The Goon package Eye Appearance definition does not target Facial Artwork v3.",
    );
  }

  return { status: "current" };
}
