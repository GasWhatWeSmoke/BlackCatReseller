// Next.js runs register() once when the server boots. Use it to snapshot the DB on
// startup so there's always a recent backup even if the app never finishes a batch (B7).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { backupDatabase } = await import("./lib/backup");
      await backupDatabase("startup");
    } catch {
      /* best-effort — never block server boot on a backup */
    }
    if (process.env.NEXT_PHASE !== "phase-production-build") {
      try {
        const { startSaleMonitor } = await import("./lib/publish/saleMonitorService");
        startSaleMonitor();
        const { startAutoCrosslisting } = await import("./lib/publish/autoRunService");
        startAutoCrosslisting();
      } catch (error) {
        console.error("[sales monitor] Could not start:", error instanceof Error ? error.message : String(error));
      }
    }
  }
}
