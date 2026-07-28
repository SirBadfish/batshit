import { describe, expect, it } from "vitest";
import {
  RETIRED_FACIAL_ARTWORK_PACKAGE_NOTICE,
  classifyFacialArtworkPackageCapability,
} from "$lib/goons/facialArtwork.package";

function currentTuple(): any {
  const eyeSha = "a".repeat(64);
  const socketSha = "b".repeat(64);
  const seamSha = "c".repeat(64);
  return {
    facialArtwork: {
      schemaVersion: "facial-artwork/v4",
      definitionSha256: "d".repeat(64),
      dependencies: {
        eyeAppearance: {
          schemaVersion: "eye-appearance/v3",
          definitionSha256: eyeSha,
        },
        socketEyeSurface: {
          schemaVersion: "socket-eye-surface/v1",
          definitionSha256: socketSha,
        },
        eyeApertureSeam: {
          schemaVersion: "eye-aperture-seam/v1",
          definitionSha256: seamSha,
        },
      },
    },
    eyeAppearance: {
      schemaVersion: "eye-appearance/v3",
      definitionSha256: eyeSha,
      dependencies: {
        socketEyeSurface: {
          schemaVersion: "socket-eye-surface/v1",
          definitionSha256: socketSha,
        },
        eyeApertureSeam: {
          schemaVersion: "eye-aperture-seam/v1",
          definitionSha256: seamSha,
        },
      },
    },
    socketEyeSurface: {
      schemaVersion: "socket-eye-surface/v1",
      definitionSha256: socketSha,
    },
    eyeApertureSeam: {
      schemaVersion: "eye-aperture-seam/v1",
      definitionSha256: seamSha,
    },
  };
}

describe("Facial Artwork package capability", () => {
  it("classifies packages without any socket-eye tuple definition as absent", () => {
    expect(classifyFacialArtworkPackageCapability({})).toEqual({
      status: "absent",
    });
  });

  it("classifies the exact v4/v2/socket/seam tuple as current", () => {
    expect(classifyFacialArtworkPackageCapability(currentTuple())).toEqual({
      status: "current",
    });
  });

  it("quarantines the retired v3 capability without accepting it as current", () => {
    expect(
      classifyFacialArtworkPackageCapability({
        facialArtwork: { schemaVersion: "facial-artwork/v3" },
        eyeAppearance: { schemaVersion: "eye-appearance/v1" },
      }),
    ).toEqual({
      status: "retired",
      notice: RETIRED_FACIAL_ARTWORK_PACKAGE_NOTICE,
      schemaVersion: "facial-artwork/v3",
    });
  });

  it("fails closed for any partial socket-eye tuple", () => {
    expect(
      classifyFacialArtworkPackageCapability({
        eyeAppearance: { schemaVersion: "eye-appearance/v3" },
      }),
    ).toMatchObject({
      status: "malformed",
      error: expect.stringMatching(/partial socket-eye tuple/),
    });

    const missingSeam = currentTuple();
    delete missingSeam.eyeApertureSeam;
    expect(classifyFacialArtworkPackageCapability(missingSeam)).toMatchObject({
      status: "malformed",
      error: expect.stringMatching(/eye-aperture-seam\/v1/),
    });
  });

  it("fails closed when any package dependency hash drifts", () => {
    const staleEye = currentTuple();
    staleEye.facialArtwork.dependencies.eyeAppearance.definitionSha256 = "f".repeat(64);
    expect(classifyFacialArtworkPackageCapability(staleEye)).toMatchObject({
      status: "malformed",
      error: expect.stringMatching(/does not match/),
    });

    const staleSocket = currentTuple();
    staleSocket.eyeAppearance.dependencies.socketEyeSurface.definitionSha256 = "f".repeat(64);
    expect(classifyFacialArtworkPackageCapability(staleSocket)).toMatchObject({
      status: "malformed",
      error: expect.stringMatching(/does not match/),
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
