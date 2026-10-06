import { NextRequest, NextResponse } from "next/server";
import { deleteSelectedItems } from "@/lib/itemDelete";
import { parseItemDeleteSelection } from '@/lib/itemDeleteSelection';

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Group-delete from the Inventory page. Reuses the same per-item deleteItem() as the
// single delete, so each item's photos + dedup hashes + working folders are removed
// (and /archive originals kept). Returns how many succeeded.
export async function POST(req: NextRequest) {
  let selected;
  try {
    const body = await req.json();
    selected = parseItemDeleteSelection(body?.ids, body?.expectedItems);
  } catch {
    return NextResponse.json({ ok: false, error: "Reload the selected items and confirm deletion again." }, { status: 400 });
  }
  const result = await deleteSelectedItems(selected.map(item => item.id), selected);
  console.log(`[items/bulk-delete] removed ${result.deleted}/${selected.length} item(s)` +
    (result.soldKept ? ` (${result.soldKept} sold kept)` : "") + (result.failed.length ? ` (${result.failed.length} failed)` : ""));
  return NextResponse.json(result);
}
