import { NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import { browserAccountStatus, confirmBrowserAccountLogin, startBrowserAccountLogin } from "@/lib/publish/browserAccounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Compatibility route for the existing Depop account screen.
export async function GET() {
  return NextResponse.json(browserAccountStatus(await getSettings(), "depop"));
}

export async function POST() {
  const result = startBrowserAccountLogin(await getSettings(), "depop");
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}

export async function PUT() {
  const settings = await getSettings();
  const result = confirmBrowserAccountLogin(settings, "depop");
  return NextResponse.json({ ...browserAccountStatus(settings, "depop"), ...result }, { status: result.ok ? 200 : 409 });
}
