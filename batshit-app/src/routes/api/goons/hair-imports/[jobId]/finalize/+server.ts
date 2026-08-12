import { json, type RequestHandler } from "@sveltejs/kit";

import { HairAssetRepositoryError } from "$lib/server/services/hairAssetRepository.server";
import { HairImportJobError } from "$lib/server/services/hairImportJobRepository.server";
import { finalizeHairImport } from "$lib/server/services/hairImportLifecycle.server";
import { requireUser } from "$lib/server/services/routeSecurity";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const user = requireUser(locals);
  if (!user.ok) return user.response;
  const jobId = params.jobId;
  if (!jobId)
    return json({ error: "Hair import jobId is required." }, { status: 400 });
  try {
    const form = await request.formData();
    const preview = form.get("preview");
    if (!(preview instanceof File)) {
      return json(
        { error: "Hair import finalization requires one PNG preview." },
        { status: 400 },
      );
    }
    return json(
      await finalizeHairImport({
        userId: user.value.id,
        jobId,
        displayName: form.get("displayName"),
        author: form.get("author"),
        license: form.get("license"),
        previewPng: new Uint8Array(await preview.arrayBuffer()),
      }),
    );
  } catch (error) {
    console.error("[hair-imports] finalization failed:", error);
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
            : "Hair import finalization failed.",
      },
      { status: 400 },
    );
  }
};
