import type { SaleMonitorStatus } from "./publish/saleMonitor.ts";

export function monitorPresentation(status: SaleMonitorStatus & { enabled: boolean; windowOpen: boolean }) {
  if (!status.enabled) return { label: "Monitoring paused", tone: "paused", detail: status.active ? "Finishing the current browser action" : "Paused in Settings" };
  if (!status.windowOpen) return { label: "Monitoring paused", tone: "paused", detail: "Reopen the desktop window to resume" };
  if (status.lastError) return { label: "Monitoring needs attention", tone: "error", detail: status.lastError };
  if (status.waitingForBrowser) return { label: "Waiting for browser", tone: "waiting", detail: "An upload or account task is using Chrome" };
  if (status.active) return { label: "Checking sales", tone: "active", detail: status.currentPlatform ?? "Checking pending removals" };
  const failed = Object.entries(status.platforms).filter(([, scan]) => ["failed", "partial"].includes(scan.state));
  if (failed.length) return { label: "Some checks need attention", tone: "error", detail: failed.map(([name]) => name).join(", ") };
  return { label: "Monitoring scheduled", tone: "ready", detail: status.nextCheckAt ? `Next check ${new Date(status.nextCheckAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Waiting for the next check" };
}
