import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { directUploadState, republicationBlockReason } from "@/lib/publish/listingGuards";
import { inventoryState, inventoryStateFilter } from "@/lib/inventoryState";
import { inventoryPage, parseInventoryQuery } from "@/lib/inventoryQuery";
import {pricingIds,readPricingIndex,readPricingRows} from '@/lib/pricingRead';
import { reviewIds, readReviewIndex, readReviewSignatures, readReviewDetails } from '@/lib/reviewQueueRead';

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Upper bound on one list response. Generous enough for a real inventory; reported
// back so the UI can say the list was cut rather than pretending it is complete.
const LIST_CAP = 5000;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (['review-index', 'review-signatures', 'review-details'].includes(sp.get('view') ?? '')) {
    const view = sp.get('view'); let ids: number[] = [];
    try { if (view !== 'review-index') ids = reviewIds(sp.get('ids')); }
    catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }
    try { return NextResponse.json(view === 'review-index' ? await readReviewIndex(prisma)
      : view === 'review-signatures' ? await readReviewSignatures(prisma, ids) : await readReviewDetails(prisma, ids)); }
    catch { return NextResponse.json({ error: 'Review could not load. Your drafts are kept.' }, { status: 503 }); }
  }
  if(['pricing-index','pricing-rows'].includes(sp.get('view')??'')){
    let ids;try{ids=pricingIds(sp.get('ids'));if(sp.get('view')==='pricing-rows'&&ids===null)throw Error('Choose pricing items.');}
    catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Invalid pricing items.'},{status:400});}
    try{return NextResponse.json(sp.get('view')==='pricing-index'?await readPricingIndex(prisma,ids):await readPricingRows(prisma,ids!));}
    catch{return NextResponse.json({error:'Pricing could not load. Your unfinished edits are kept.'},{status:503});}
  }
  if (sp.get("view") === "inventory") {
    let query;
    try { query = parseInventoryQuery(sp); }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid inventory filters." }, { status: 400 }); }
    try { return NextResponse.json(await inventoryPage(prisma, query)); }
    catch { return NextResponse.json({ error: "Inventory could not be loaded. Your records have not been changed; retry loading the page." }, { status: 503 }); }
  }
  const where: Prisma.ItemWhereInput = inventoryStateFilter(sp.get('state') ?? '');
  for (const k of ["status", "brand", "size", "itemType"] as const) {
    const v = sp.get(k);
    if (v) where[k] = v;
  }
  const q = sp.get("q");
  if (q) where.AND = [{ OR: ['sku','brand','itemType','customTitle','finalTitle','niftyTitle'].map(key=>({[key]:{contains:q}})) }];
  const needsInfoOnly = sp.get("needsInfo") === "1";
  if (needsInfoOnly) where.status = { in: ["Photographed", "Needs Info"] };
  // "Come back to these" filter (Inventory's flagged toggle).
  if (sp.get("flagged") === "1") where.flagged = true;
  // Pricing table: every item that still needs a price and hasn't gone to Nifty yet —
  // deliberately INCLUDING "Ready for Nifty" (price isn't a gate field, so ready items
  // are exactly the ones that would hard-block a publish run).
  if (sp.get("unpriced") === "1") {
    where.OR = [{ listedPrice: null }, { listedPrice: { lte: 0 } }];
    where.status = { in: ["Photographed", "Needs Info", "Ready", "Ready for Nifty"] };
    where.niftyStatus = "Not Uploaded";
  }

  try {
    const items = await prisma.item.findMany({
      where,
      // ALWAYS consecutive SKU order (user rule): zero-padded numeric SKUs sort
      // numerically as strings, synthetic names (FIX-…) fall after the numbers.
      // Every list (Inventory, Review queue, Pricing) inherits this, and the
      // detail page's prev/next (neighbors route) uses the SAME order.
      orderBy: [{ sku: "asc" }],
      include: { photos: { orderBy: { sortOrder: "asc" } }, ...directUploadState },
      take: LIST_CAP,
    });
    // Say so rather than quietly serving a short list: at the old cap of 1000 an
    // inventory that crossed it looked like items had disappeared.
    return NextResponse.json({
      items: items.map(({ marketplaceListings, publishJobs, ...item }) => ({
        ...item, marketplaceListings, displayStatus: inventoryState({...item,marketplaceListings}),
        title: item.customTitle || item.finalTitle || item.niftyTitle || [item.brand,item.itemType,item.color,item.size].filter(Boolean).join(' '),
        republicationBlockReason: republicationBlockReason({ marketplaceListings, publishJobs }),
      })),
      truncated: items.length >= LIST_CAP, cap: LIST_CAP,
    });
  } catch {
    return NextResponse.json({ error: "Inventory is temporarily unavailable. Retry loading it.", dbUninitialized: true }, { status: 503 });
  }
}

// Create an EMPTY item by hand (batch recovery: a garment whose photos were missed or
// mis-grouped gets a shell to move photos into — nothing has to be re-imported).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const sku = String(body?.sku ?? "").trim();
  if (!sku || sku.length > 32) {
    return NextResponse.json({ error: "Enter a SKU (up to 32 characters)." }, { status: 400 });
  }
  try {
    const item = await prisma.item.create({
      data: { sku, status: "Photographed", isShell: true },
    });
    console.log(`[items] manual shell item ${sku} created (#${item.id})`);
    return NextResponse.json({ ok: true, item });
  } catch (e: unknown) {
    if (e && typeof e === "object" && (e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: `SKU ${sku} already exists.` }, { status: 409 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : "create failed" }, { status: 500 });
  }
}
