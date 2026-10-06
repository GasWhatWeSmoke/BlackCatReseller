import { NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import { BROWSER_MARKETPLACES } from "@/lib/publish/platforms";
import { browserAccountStatus } from "@/lib/publish/browserAccounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await getSettings();
  return NextResponse.json({ accounts: BROWSER_MARKETPLACES.map((marketplace) => browserAccountStatus(settings, marketplace)) });
}
