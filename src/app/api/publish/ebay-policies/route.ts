import { NextRequest, NextResponse } from "next/server";
import { getRequiredSettings, updateSettings } from "@/lib/settings";
import { ebayPolicyNames, EBAY_POLICY_FIELDS, mergeEbayPolicies } from "@/lib/publish/ebayPolicyCatalog";
import { readEbayPolicies } from "@/lib/publish/ebayPolicies";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await getRequiredSettings();
    return NextResponse.json({ workspace: settings.dataRoot, catalog: settings.publish?.ebayPolicyCatalog ?? null,
      names: ebayPolicyNames(settings) }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "Saved eBay policies could not be loaded." }, { status: 503 }); }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json(), before = await getRequiredSettings(), names = ebayPolicyNames(before);
    if (body?.workspace !== before.dataRoot || EBAY_POLICY_FIELDS.some(field => body?.expected?.[field] !== names[field]))
      return NextResponse.json({ error: "Saved eBay preferences changed. Reload them before refreshing policies." }, { status: 409 });
    const catalog = await readEbayPolicies(before);
    const saved = await updateSettings(current => mergeEbayPolicies(current, before, catalog));
    return NextResponse.json({ ok: true, workspace: saved.dataRoot, catalog: saved.publish!.ebayPolicyCatalog, names: ebayPolicyNames(saved) });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "eBay policies could not be linked." }, { status: 409 }); }
}
