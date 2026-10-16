import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { getSettings } from "@/lib/settings";
import { readIntakeReview } from "@/lib/intakeReviewStore";
import { validateIntakeCorrections } from "@/lib/intakeReview";
import { writeIntakeJson, latestIntakeJob } from "@/lib/intakeJobStore";
import { withIntakeJobMutation } from "@/lib/intakeJobs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  try {
    const settings = await getSettings();
    const id = req.nextUrl.searchParams.get("job") || latestIntakeJob(settings)?.id;
    if (!id) return NextResponse.json({ job: null });
    const { directory: _, ...review } = readIntakeReview(settings, id);
    return NextResponse.json(review, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Batch review is unavailable." }, { status: 409 }); }
}
export async function PATCH(req: NextRequest) {
  try {
    const settings = await getSettings();
    const body = await req.json();
    if (typeof body.jobId !== "string") throw Error("A batch ID is required.");
    return await withIntakeJobMutation(settings, body.jobId, async () => {
      const { directory, manifest, corrections, job } = readIntakeReview(settings, body.jobId);
      if (!manifest) throw Error("Wait until the source manifest is available.");
      const revised = validateIntakeCorrections(body, manifest, corrections, new Set(job.committedPhotoIds ?? []));
      writeIntakeJson(path.join(directory, "corrections.json"), revised);
      return NextResponse.json({ ok: true, corrections: revised });
    });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Corrections could not be saved." }, { status: 409 }); }
}
