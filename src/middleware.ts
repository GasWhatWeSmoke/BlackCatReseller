import { NextRequest, NextResponse } from "next/server";
import { checkLocalApiBoundary } from "@/lib/localApiBoundary";

export function middleware(request: NextRequest): NextResponse {
  if (process.env.BLACKCAT_PREVIEW === '1' && !['GET','HEAD'].includes(request.method)) {
    return NextResponse.json({error:'This preview is read-only.'},{status:403});
  }
  const decision = checkLocalApiBoundary(request.method, request.headers, {
    preview: process.env.BLACKCAT_PREVIEW === '1', previewPort: process.env.BLACKCAT_PREVIEW_PORT,
  });
  if (decision.ok) return NextResponse.next();

  return NextResponse.json(
    { ok: false, error: decision.error, message: decision.message },
    { status: decision.status, headers: { "Cache-Control": "no-store" } },
  );
}

export const config = {
  matcher: "/api/:path*",
};
