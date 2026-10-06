import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import { isBrowserMarketplace } from "@/lib/publish/platforms";
import { confirmBrowserAccountLogin, startBrowserAccountLogin } from "@/lib/publish/browserAccounts";

export const runtime = "nodejs";
type Context = { params: Promise<{ marketplace: string }> };

export async function POST(_req: NextRequest, context: Context) {
  const { marketplace } = await context.params;
  if (!isBrowserMarketplace(marketplace)) return NextResponse.json({ ok: false, error: "Unknown marketplace." }, { status: 400 });
  const result = startBrowserAccountLogin(await getSettings(), marketplace);
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}

export async function PUT(req: NextRequest, context: Context) {
  const { marketplace } = await context.params;
  const body = await req.json().catch(() => null);
  if (!isBrowserMarketplace(marketplace) || body?.confirmed !== true) {
    return NextResponse.json({ ok: false, error: "Confirm that you finished signing in." }, { status: 400 });
  }
  const result = confirmBrowserAccountLogin(await getSettings(), marketplace);
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
