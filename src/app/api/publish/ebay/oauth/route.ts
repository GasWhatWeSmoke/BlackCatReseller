import { NextResponse } from 'next/server';

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Browser sessions replaced this legacy connection method. Old links must not
// read credentials, exchange codes or rewrite stored settings.
const retired = () => NextResponse.json({
  error: 'This connection method has been retired. Connect eBay from Settings → Marketplace accounts.',
}, { status: 410 });

export { retired as GET, retired as POST };
