import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import { getSettings } from "@/lib/settings";
import { listingIdentity } from "@/lib/publish/attempts";
import { claimBrowser, releaseBrowser, browserBusyMessage } from "@/lib/browserCoordinator";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const identity = typeof body?.url === "string" ? listingIdentity("ebay", body.url) : null;
  if (!identity) return NextResponse.json({ error: "Use an exact eBay listing URL. Other marketplaces can be recorded manually." }, { status: 400 });
  if (!claimBrowser("Read eBay comparable")) return NextResponse.json({ error: browserBusyMessage() }, { status: 409 });
  try {
    const settings = await getSettings();
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(settings.pythonWorkerPath, ["-m", "black_cat_worker.research_listing"], {
        cwd: path.join(process.cwd(), "worker"), windowsHide: true,
        env: { ...process.env, PYTHONPATH: "", PYTHONIOENCODING: "utf-8", BLACKCAT_DATA_ROOT: settings.dataRoot,
          PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.cwd(), ".local", "playwright") },
      });
      let output = ""; const timer = setTimeout(() => child.kill(), 90_000);
      child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { if (output.length < 100_000) output += chunk; });
      child.stderr.resume();
      child.on("error", () => { clearTimeout(timer); reject(new Error("Research worker could not start.")); });
      child.on("close", () => { clearTimeout(timer);
        try { const line = output.split(/\r?\n/).findLast(row => row.startsWith("RESEARCH_DONE ")); resolve(JSON.parse(line!.slice(14))); }
        catch { reject(new Error("Listing read did not finish. Open the listing in Chrome and try again.")); }
      });
      child.stdin.on("error", () => {}); child.stdin.end(JSON.stringify({ url: identity.url }));
    });
    if (result.ok !== true) return NextResponse.json({ error: result.error }, { status: 422 });
    return NextResponse.json(result);
  } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 500 }); }
  finally { releaseBrowser(); }
}
