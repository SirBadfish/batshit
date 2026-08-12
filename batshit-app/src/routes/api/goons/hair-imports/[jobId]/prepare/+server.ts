import { json, type RequestHandler } from "@sveltejs/kit";

import { HairImportJobError } from "$lib/server/services/hairImportJobRepository.server";
import { prepareHairImport } from "$lib/server/services/hairImportLifecycle.server";
import { requireUser } from "$lib/server/services/routeSecurity";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const user = requireUser(locals);
  if (!user.ok) return user.response;
  const jobId = params.jobId;
  if (!jobId)
    return json({ error: "Hair import jobId is required." }, { status: 400 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    return json(
      await prepareHairImport({
        userId: user.value.id,
        jobId,
        selectedObjectIds: body.selectedObjectIds,
        transform: body.transform,
        reviewedAppearanceState: body.reviewedAppearanceState,
        motionRegionSelections: body.motionRegionSelections,
        motionPaint: body.motionPaint,
      }),
    );
  } catch (error) {
    console.error("[hair-imports] preparation failed:", error);
    if (error instanceof HairImportJobError) {
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
            : "Hair import preparation failed.",
      },
      { status: 400 },
    );
  }
};
