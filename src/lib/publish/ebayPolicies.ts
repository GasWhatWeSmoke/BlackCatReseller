import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AppSettingsData } from "../types.ts";
import { browserBusyMessage, claimBrowser, releaseBrowser } from "../browserCoordinator.ts";
import { validateEbayPolicyResult, type EbayPolicyCatalog } from "./ebayPolicyCatalog.ts";

/** Restored beta8 read-only lookup. Keep the browser claim through natural close,
 * even after a timeout/error, so another task cannot compete with its browser. */
export async function readEbayPolicies(settings: AppSettingsData,
  options: { launch?: () => ChildProcess; timeoutMs?: number } = {}): Promise<EbayPolicyCatalog> {
  if (!claimBrowser("eBay policy lookup")) throw Error(browserBusyMessage());
  try {
    return await new Promise((resolve, reject) => {
      const child = options.launch ? options.launch() : spawn(settings.pythonWorkerPath || "python", ["-m", "black_cat_worker.ebay_policies"], {
        cwd: path.join(process.cwd(), "worker"), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONPATH: "", PYTHONIOENCODING: "utf-8", BLACKCAT_DATA_ROOT: settings.dataRoot },
      });
      let output = "", error = "", settled = false;
      const decoder = new StringDecoder("utf8");
      const timer = setTimeout(() => {
        error = "eBay policy lookup timed out. Finish sign-in, then refresh policies.";
        try { child.kill(); } catch { /* claim is released only when the owner closes */ }
      }, options.timeoutMs ?? 90_000);
      child.stdout!.on("data", (chunk: Buffer) => { output = (output + decoder.write(chunk)).slice(-256_000); });
      child.stderr!.resume();
      child.on("error", () => {
        error = "The eBay policy worker could not start. Install the photo worker and connect Chrome first.";
        if (!child.pid && !settled) { settled = true; clearTimeout(timer); reject(Error(error)); }
      });
      child.on("close", code => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        try {
          if (error || code !== 0) throw Error(error || "eBay policy lookup ended without a confirmed result.");
          output += decoder.end();
          const line = output.split(/\r?\n/).filter(line => line.startsWith("EBAY_POLICIES_DONE ")).at(-1);
          if (!line) throw Error("The eBay policy worker did not return a result.");
          resolve(validateEbayPolicyResult(JSON.parse(line.slice(19))));
        } catch (error) { reject(error); }
      });
    });
  } finally { releaseBrowser(); }
}
