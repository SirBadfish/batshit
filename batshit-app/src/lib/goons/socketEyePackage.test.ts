import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseFirstPartySocketEyePackage } from "./socketEyePackage";
import { classifyFacialArtworkPackageCapability } from "./facialArtwork.package";
import { parseSocketEyeSurfaceDefinition } from "./socketEyeSurface";
import { parseEyeApertureSeamDefinition } from "./eyeApertureSeam";
import { parseEyeAppearanceDefinition } from "./eyeAppearance";
import { parseFacialArtworkDefinition } from "./facialArtwork";
import { resolveCustomPerformanceRigManifest } from "./customPerformanceRig";

vi.mock("./facialArtwork.package", () => ({
  classifyFacialArtworkPackageCapability: vi.fn(),
}));
vi.mock("./socketEyeSurface", () => ({
  parseSocketEyeSurfaceDefinition: vi.fn(),
}));
vi.mock("./eyeApertureSeam", () => ({
  parseEyeApertureSeamDefinition: vi.fn(),
  validateSocketEyeApertureOwnership: vi.fn(),
}));
vi.mock("./eyeAppearance", () => ({
  parseEyeAppearanceDefinition: vi.fn(),
}));
vi.mock("./facialArtwork", () => ({
  parseFacialArtworkDefinition: vi.fn(),
}));
vi.mock("./customAvatar", () => ({
  resolveCustomPerformanceRigBlock: vi.fn(
    (manifest) => manifest.rig?.performance,
  ),
}));
vi.mock("./customPerformanceRig", () => ({
  resolveCustomPerformanceRigManifest: vi.fn(),
}));

const hashes = {
  socket: "a".repeat(64),
  seam: "b".repeat(64),
  eye: "c".repeat(64),
};

function tuple() {
  const socketEyeSurface = {
    schemaVersion: "socket-eye-surface/v2",
    definitionSha256: hashes.socket,
    runtimeBindings: {
      left: { nodes: { physicalEye: "PhysicalEye_L" } },
      right: { nodes: { physicalEye: "PhysicalEye_R" } },
    },
  };
  const eyeApertureSeam = {
    schemaVersion: "eye-aperture-seam/v2",
    definitionSha256: hashes.seam,
    runtimeBindings: {
      left: { physicalEyeNode: "PhysicalEye_L" },
      right: { physicalEyeNode: "PhysicalEye_R" },
    },
  };
  const eyeAppearance = {
    schemaVersion: "eye-appearance/v5",
    definitionSha256: hashes.eye,
    dependencies: {
      socketEyeSurface: {
        schemaVersion: "socket-eye-surface/v2",
        definitionSha256: hashes.socket,
      },
      eyeApertureSeam: {
        schemaVersion: "eye-aperture-seam/v2",
        definitionSha256: hashes.seam,
      },
    },
    runtimeBindings: {
      left: { physicalEyeNode: "PhysicalEye_L" },
      right: { physicalEyeNode: "PhysicalEye_R" },
    },
  };
  const physicalEyeRoles = ["sclera", "iris", "pupil", "eye_highlight"].map(
    (id) => ({
      id,
      target: {
        left: {
          bindingKind: "physical-eye-layer",
          runtimeNodes: ["PhysicalEye_L"],
        },
        right: {
          bindingKind: "physical-eye-layer",
          runtimeNodes: ["PhysicalEye_R"],
        },
      },
    }),
  );
  const facialArtwork = {
    schemaVersion: "facial-artwork/v6",
    dependencies: {
      eyeAppearance: {
        schemaVersion: "eye-appearance/v5",
        definitionSha256: hashes.eye,
      },
      socketEyeSurface: {
        schemaVersion: "socket-eye-surface/v2",
        definitionSha256: hashes.socket,
      },
      eyeApertureSeam: {
        schemaVersion: "eye-aperture-seam/v2",
        definitionSha256: hashes.seam,
      },
    },
    roles: physicalEyeRoles,
  };
  return { socketEyeSurface, eyeApertureSeam, eyeAppearance, facialArtwork };
}

function manifest() {
  return {
    ...tuple(),
    rig: { performance: { contract: "batshit-performance-rig/v2" } },
  } as any;
}

beforeEach(() => {
  vi.mocked(classifyFacialArtworkPackageCapability).mockReturnValue({
    status: "current",
  });
  vi.mocked(parseSocketEyeSurfaceDefinition).mockImplementation(
    (value) => value as any,
  );
  vi.mocked(parseEyeApertureSeamDefinition).mockImplementation(
    (value) => value as any,
  );
  vi.mocked(parseEyeAppearanceDefinition).mockImplementation(
    (value) => value as any,
  );
  vi.mocked(parseFacialArtworkDefinition).mockImplementation(
    (value) => value as any,
  );
  vi.mocked(resolveCustomPerformanceRigManifest).mockReturnValue({
    manifest: { contract: "batshit-performance-rig/v2" } as any,
    issues: [],
  });
});

describe("first-party socket-eye package closure", () => {
  it("accepts the exact v2/v5 hash-bound tuple with a performance v2 eye driver", () => {
    expect(parseFirstPartySocketEyePackage(manifest())).toMatchObject({
      socketEyeSurface: {
        schemaVersion: "socket-eye-surface/v2",
        definitionSha256: hashes.socket,
      },
      eyeApertureSeam: {
        schemaVersion: "eye-aperture-seam/v2",
        definitionSha256: hashes.seam,
      },
      eyeAppearance: {
        schemaVersion: "eye-appearance/v5",
        definitionSha256: hashes.eye,
      },
      performanceRig: { contract: "batshit-performance-rig/v2" },
    });
  });

  it("rejects dependency drift and physical-eye nodes that do not share the surface", () => {
    const stale = manifest();
    stale.eyeAppearance.dependencies.socketEyeSurface.definitionSha256 =
      "f".repeat(64);
    expect(() => parseFirstPartySocketEyePackage(stale)).toThrow(
      /dependency hashes/,
    );

    const wrongEye = manifest();
    wrongEye.eyeAppearance.runtimeBindings.left.physicalEyeNode =
      "FloatingGlobe_L";
    expect(() => parseFirstPartySocketEyePackage(wrongEye)).toThrow(
      /left physical-eye node/,
    );

    const wrongArtwork = manifest();
    wrongArtwork.facialArtwork.roles[0].target.left.runtimeNodes[0] =
      "FloatingArtwork_L";
    expect(() => parseFirstPartySocketEyePackage(wrongArtwork)).toThrow(
      /left composite layers do not share the physical eye/,
    );
  });

  it("rejects the rotating-eye performance contract", () => {
    vi.mocked(resolveCustomPerformanceRigManifest).mockReturnValue({
      manifest: { contract: "batshit-performance-rig/v1" } as any,
      issues: [],
    });
    expect(() => parseFirstPartySocketEyePackage(manifest())).toThrow(
      /batshit-performance-rig\/v2/,
    );
  });
});
