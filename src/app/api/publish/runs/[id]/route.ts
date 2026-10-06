import { NextRequest, NextResponse } from "next/server";
import { runStatus, controlRun, retryJobs } from "@/lib/publish/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return NextResponse.json(await runStatus(Number(id)));
}

// Run controls (§45.16): pause | resume | cancel | retry (all failed) |
// retry with jobIds (selected). The worker is never impossible to stop —
// pause takes effect before the next job, cancel also clears the queue.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const runId = Number(id);
  if (!Number.isInteger(runId)) return NextResponse.json({ ok: false, error: "bad run id" }, { status: 400 });
  let action = "", jobIds: number[] | undefined;
  try {
    const body = await req.json();
    action = String(body?.action ?? "");
    if(body && 'jobIds' in body) {
      if(!Array.isArray(body.jobIds)||!body.jobIds.length||body.jobIds.some((value:unknown)=>typeof value!=="number"||!Number.isSafeInteger(value)||value<=0))return NextResponse.json({ok:false,error:"Select valid failed listings to retry."},{status:400});
      jobIds=body.jobIds;
    }
  } catch { /* fall through to the action check */ }
  if (action === "retry") { const result=await retryJobs(runId,jobIds); return NextResponse.json(result,{status:result.ok?200:409}); }
  if (action === "pause" || action === "resume" || action === "cancel") {
    const r = await controlRun(runId, action);
    return NextResponse.json(r, { status: r.ok ? 200 : 404 });
  }
  return NextResponse.json({ ok: false, error: "action must be pause | resume | cancel | retry" }, { status: 400 });
}
