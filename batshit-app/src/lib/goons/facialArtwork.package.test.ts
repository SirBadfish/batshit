import { describe, expect, it } from "vitest";
import {
  RETIRED_FACIAL_ARTWORK_PACKAGE_NOTICE,
  classifyFacialArtworkPackageCapability,
} from "$lib/goons/facialArtwork.package";

describe("Facial Artwork package capability", () => {
  it("classifies packages without either optional definition as absent", () => {
    expect(classifyFacialArtworkPackageCapability({})).toEqual({
      status: "absent",
    });
  });

  it("classifies the paired v3 definitions as current", () => {
    expect(
      classifyFacialArtworkPackageCapability({
        facialArtwork: { schemaVersion: "facial-artwork/v3" },
        eyeAppearance: {
          schemaVersion: "eye-appearance/v1",
          facialArtworkDependency: { schemaVersion: "facial-artwork/v3" },
        },
      }),
    ).toEqual({ status: "current" });
  });

  it("quarantines the retired v2 capability without accepting it as current", () => {
    expect(
      classifyFacialArtworkPackageCapability({
        facialArtwork: { schemaVersion: "facial-artwork/v2" },
        eyeAppearance: {
          schemaVersion: "eye-appearance/v1",
          facialArtworkDependency: { schemaVersion: "facial-artwork/v2" },
        },
      }),
    ).toEqual({
      status: "retired",
      notice: RETIRED_FACIAL_ARTWORK_PACKAGE_NOTICE,
      schemaVersion: "facial-artwork/v2",
    });
  });

  it("fails closed for Eye Appearance without Facial Artwork", () => {
    expect(
      classifyFacialArtworkPackageCapability({
        eyeAppearance: { schemaVersion: "eye-appearance/v1" },
      }),
    ).toMatchObject({
      status: "malformed",
      error: expect.stringMatching(/without its required/),
    });
  });

  it("fails closed when a claimed v3 package has a stale Eye Appearance dependency", () => {
    expect(
      classifyFacialArtworkPackageCapability({
        facialArtwork: { schemaVersion: "facial-artwork/v3" },
        eyeAppearance: {
          schemaVersion: "eye-appearance/v1",
          facialArtworkDependency: { schemaVersion: "facial-artwork/v2" },
        },
      }),
    ).toMatchObject({
      status: "malformed",
      error: expect.stringMatching(/does not target Facial Artwork v3/),
    });
  });

  it("fails closed for unknown Facial Artwork schemas", () => {
    expect(
      classifyFacialArtworkPackageCapability({
        facialArtwork: { schemaVersion: "facial-artwork/v99" },
      }),
    ).toMatchObject({
      status: "malformed",
      error: expect.stringMatching(/does not support/),
    });
  });
});
