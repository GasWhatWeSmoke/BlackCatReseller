import { NextResponse } from "next/server";
import { exportItemById } from "@/lib/export-item";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Thin HTTP wrapper: the export itself lives in src/lib/export-item.ts, shared with the
// assist route (which re-exports right before every upload so item.json is never stale).
// Body {relist:true} = the explicit "post it to Nifty AGAIN" intent (Past uploads →
// Re-list): only that resets an already-uploaded item back into the publish queue.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body=await req.json().catch(()=>({}));
  if(body?.relist===true)return NextResponse.json({error:"This relisting action has been retired. Manage existing listings in Crosslisting."},{status:410});
  const r = await exportItemById(Number(id), { requirePrice: body?.requirePrice === true,
    expectedUpdatedAt: typeof body?.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined });
  if (r.ok) {
    return NextResponse.json({ ok: true, item: r.item, readyDir: r.readyDir, copyWarnings: r.copyWarnings });
  }
  switch (r.error) {
    case "NOT_APPROVABLE": return NextResponse.json({error:r.message},{status:409});
    case "not_found":
      return NextResponse.json({ error: "not found" }, { status: 404 });
    case "UNSAFE_SKU":
      return NextResponse.json({ ok: false, error: "UNSAFE_SKU" }, { status: 400 });
    case "GATE_FAILED":
      return NextResponse.json(
        {
          ok: false, error: "GATE_FAILED", missing: r.missing,
          listingCount: r.listingCount, minListingPhotos: r.minListingPhotos,
        },
        { status: 422 },
      );
    case "EXPORT_FAILED":
      return NextResponse.json({ ok: false, error: "EXPORT_FAILED", message: r.message }, { status: 500 });
  }
}
