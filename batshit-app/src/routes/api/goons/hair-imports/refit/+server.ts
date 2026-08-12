import { json, type RequestHandler } from "@sveltejs/kit";

import { HairAssetRepositoryError } from "$lib/server/services/hairAssetRepository.server";
import { HairImportJobError } from "$lib/server/services/hairImportJobRepository.server";
import { beginHairRefit } from "$lib/server/services/hairImportLifecycle.server";
import { requireUser } from "$lib/server/services/routeSecurity";

export const POST: RequestHandler = async ({ locals, request }) => {
  const user = requireUser(locals);
  if (!user.ok) return user.response;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (
      typeof body.goonId !== "string" ||
      typeof body.assetId !== "string" ||
      typeof body.revisionId !== "string" ||
      typeof body.revisionSha256 !== "string"
    ) {
      return json(
        {
          error: "Hair refit requires a Goon and exact imported Hair revision.",
        },
        { status: 400 },
      );
    }
    const result = await beginHairRefit({
      userId: user.value.id,
      goonId: body.goonId.trim(),
      assetId: body.assetId.trim(),
      revisionId: body.revisionId.trim(),
      revisionSha256: body.revisionSha256.trim(),
    });
    return json(result, { status: 201 });
  } catch (error) {
    console.error("[hair-imports/refit] inspection failed:", error);
    if (
      error instanceof HairImportJobError ||
      error instanceof HairAssetRepositoryError
    ) {
      return json(
        { error: error.message, code: error.code, details: error.details },
        { status: error.status },
      );
    }
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Hair refit inspection failed.",
      },
      { status: 400 },
    );
  }
};
