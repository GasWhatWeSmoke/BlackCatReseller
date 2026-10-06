import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { recordOrderReview, resolveOrderReview } from "@/lib/publish/orderReviews";
import { parseOrderReviewQuery, readOrderReviewPage } from "@/lib/publish/orderReviewPage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request:NextRequest) {
  let query;
  try {query=parseOrderReviewQuery(request.nextUrl.searchParams);}
  catch(error){return NextResponse.json({error:(error as Error).message},{status:400});}
  try {return NextResponse.json(await readOrderReviewPage(prisma,query));}
  catch {return NextResponse.json({error:'Order reviews could not be loaded. Refresh before making a return decision.'},{status:503});}
}
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  try {
    if (body?.action === "report") {
      if (typeof body.sku !== "string" || !body.sku.trim() || body.sku.length > 32) throw new Error("Enter the sold item's inventory number.");
      const id = await recordOrderReview(prisma, { sku: body.sku.trim(), reason: "You reported a return or cancellation. Confirm the payment outcome before changing inventory." });
      return id ? NextResponse.json({ ok: true, id }) : NextResponse.json({ error: "No sold item matches that inventory number." }, { status: 404 });
    }
    if (!Number.isSafeInteger(body?.id)) throw new Error("Choose an order review.");
    if (typeof body.reviewIdentity !== 'string' || !body.reviewIdentity || body.reviewIdentity.length > 2000)
      throw new Error('Refresh this order review before making a decision.');
    const result = await resolveOrderReview(prisma, body.id, body);
    return NextResponse.json({ ok: true, id:body.id, ...result });
  } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }
}
