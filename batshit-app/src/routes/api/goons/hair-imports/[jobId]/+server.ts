import { json, type RequestHandler } from "@sveltejs/kit";

import {
  HairImportJobError,
  getHairImportJob,
} from "$lib/server/services/hairImportJobRepository.server";
import { discardHairImportJob } from "$lib/server/services/hairImportLifecycle.server";
import { requireUser } from "$lib/server/services/routeSecurity";

function failure(error: unknown, fallback: string) {
  if (error instanceof HairImportJobError) {
    return json(
      { error: error.message, code: error.code, details: error.details },
      { status: error.status },
    );
  }
  return json(
    { error: error instanceof Error ? error.message : fallback },
    { status: 400 },
  );
}

export const GET: RequestHandler = async ({ locals, params }) => {
  const user = requireUser(locals);
  if (!user.ok) return user.response;
  const jobId = params.jobId;
  if (!jobId)
    return json({ error: "Hair import jobId is required." }, { status: 400 });
  try {
    return json({ job: await getHairImportJob(user.value.id, jobId) });
  } catch (error) {
    return failure(error, "Failed to load Hair import job.");
  }
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const user = requireUser(locals);
  if (!user.ok) return user.response;
  const jobId = params.jobId;
  if (!jobId)
    return json({ error: "Hair import jobId is required." }, { status: 400 });
  try {
    return json(await discardHairImportJob({ userId: user.value.id, jobId }));
  } catch (error) {
    return failure(error, "Failed to discard Hair import job.");
  }
};
