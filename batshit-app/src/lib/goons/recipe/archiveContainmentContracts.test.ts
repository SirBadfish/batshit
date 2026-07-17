import { describe, expect, it } from "vitest";
import {
  RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
  RECIPE_ARCHIVE_EXTRACTOR_ID,
  RECIPE_ARCHIVE_EXTRACTOR_VERSION,
  createRecipeArchiveContainmentReceipt,
  parseRecipeArchiveContainmentReceipt,
  verifyRecipeArchiveContainmentReceipt,
  type RecipeArchiveContainmentReceiptContent,
} from "./archiveContainmentContracts";

const sha = (character: string) => character.repeat(64);

function content(): RecipeArchiveContainmentReceiptContent {
  return {
    contract: RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
    archiveFormat: "zip",
    extractor: {
      id: RECIPE_ARCHIVE_EXTRACTOR_ID,
      version: RECIPE_ARCHIVE_EXTRACTOR_VERSION,
    },
    archive: {
      ref: "/uploads/goon_custom_packages/source.bgoon",
      sha256: sha("a"),
      bytes: 300,
    },
    entryCount: 2,
    totalUncompressedBytes: 240,
    members: [
      {
        role: "manifest",
        path: "avatar.json",
        sha256: sha("b"),
        bytes: 40,
        extracted: {
          ref: "/uploads/goon_custom_manifests/source_avatar.json",
          sha256: sha("b"),
          bytes: 40,
        },
      },
      {
        role: "model",
        path: "avatar.glb",
        sha256: sha("c"),
        bytes: 200,
        extracted: {
          ref: "/uploads/goon_custom_models/source_avatar.glb",
          sha256: sha("c"),
          bytes: 200,
        },
      },
    ],
  };
}

describe("Recipe archive containment receipt", () => {
  it("creates and verifies an exact self-hashed two-member receipt", async () => {
    const receipt = await createRecipeArchiveContainmentReceipt(content());
    await expect(verifyRecipeArchiveContainmentReceipt(receipt)).resolves.toEqual(
      receipt,
    );
  });

  it("rejects nested, host-bound, and duplicate stored refs", async () => {
    const nested = await createRecipeArchiveContainmentReceipt(content());
    nested.members[0].extracted.ref = "/uploads/goon_custom_manifests/nested/avatar.json";
    expect(() => parseRecipeArchiveContainmentReceipt(nested)).toThrow(
      /canonical \/uploads/,
    );

    const hosted = await createRecipeArchiveContainmentReceipt(content());
    hosted.archive.ref = "http://localhost:5600/uploads/goon_custom_packages/source.bgoon";
    expect(() => parseRecipeArchiveContainmentReceipt(hosted)).toThrow(
      /canonical \/uploads/,
    );

    const duplicate = await createRecipeArchiveContainmentReceipt(content());
    duplicate.members[0].extracted.ref = duplicate.archive.ref;
    expect(() => parseRecipeArchiveContainmentReceipt(duplicate)).toThrow(
      /must be distinct/,
    );
  });

  it("rejects member drift, wrong ordering, and hash tampering", async () => {
    const drift = await createRecipeArchiveContainmentReceipt(content());
    drift.members[1].extracted.sha256 = sha("d");
    expect(() => parseRecipeArchiveContainmentReceipt(drift)).toThrow(
      /must match the exact archive member/,
    );

    const wrongOrder = await createRecipeArchiveContainmentReceipt(content());
    wrongOrder.members.reverse();
    expect(() => parseRecipeArchiveContainmentReceipt(wrongOrder)).toThrow(
      /sorted as manifest then model/,
    );

    const tampered = await createRecipeArchiveContainmentReceipt(content());
    tampered.archive.bytes += 1;
    await expect(verifyRecipeArchiveContainmentReceipt(tampered)).rejects.toThrow(
      /mismatch/,
    );
  });
});
