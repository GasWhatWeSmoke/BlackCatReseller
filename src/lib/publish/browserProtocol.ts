export interface BrowserReport {
  outcome: "posted" | "filled" | "failed";
  url?: string;
  reason?: string;
  message?: string;
  submissionStarted?: boolean;
  uploadedPhotos?: number;
  totalPhotos?: number;
}

export type ReportPrefix = "DEPOP_DONE" | "EBAY_DONE" | "ETSY_DONE" | "POSHMARK_DONE" | "MERCARI_DONE";

export function parseBrowserReport(output: string, prefix: ReportPrefix): BrowserReport | null {
  const reports = [...output.matchAll(new RegExp(`^${prefix} (.+)$`, "gm"))];
  const last = reports.at(-1)?.[1];
  if (!last) return null;
  try {
    const value = JSON.parse(last);
    return value && typeof value === "object" && !Array.isArray(value) &&
      ["posted", "filled", "failed"].includes(value.outcome) ? value : null;
  } catch { return null; }
}
