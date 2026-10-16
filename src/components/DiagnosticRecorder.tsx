"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

/** Beta8's bounded, opt-out local event recorder. It observes outcomes without
 * modifying fetch results, native promises, form values or request payloads. */
export function DiagnosticRecorder() {
  const pathname = usePathname();
  useEffect(() => {
    const originalFetch = window.fetch;
    let enabled = false, preferenceChanged = false, disposed = false;
    const queue: Record<string, unknown>[] = [];
    const record = (event: Record<string, unknown>) => {
      if (enabled) { if (queue.length >= 100) queue.shift(); queue.push(event); }
    };
    const flush = () => {
      if (!queue.length) return;
      try { void originalFetch("/api/diagnostics", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: queue.splice(0, 20) }), keepalive: true }).catch(() => {}); }
      catch { /* diagnostic failures must never change application behavior */ }
    };
    void originalFetch("/api/diagnostics", { cache: "no-store" }).then(response => response.json()).then(value => {
      if (!disposed && !preferenceChanged) {
        enabled = value.enabled === true && value.available !== false;
        if (enabled) record({ kind: "navigation", path: location.pathname });
      }
    }).catch(() => {});
    const observedFetch: typeof window.fetch = async (input, init) => {
      let url: URL | undefined;
      try { url = new URL(input instanceof Request ? input.url : String(input), location.href); } catch { /* malformed fetch is handled by fetch */ }
      const local = url?.origin === location.origin && url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/diagnostics");
      const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase(), start = performance.now();
      if (local && method !== "GET") record({ kind: "request", phase: "started", path: url!.pathname, method });
      try {
        const response = await originalFetch(input, init);
        if (local && (method !== "GET" || !response.ok)) record({ kind: "request", phase: response.ok ? "completed" : "failed",
          path: url!.pathname, method, status: response.status, durationMs: performance.now() - start });
        if (local && !response.ok) void response.clone().json().then(value => {
          if (typeof value?.error === "string") record({ kind: "error", path: url!.pathname, message: value.error.slice(0, 800) });
        }).catch(() => {});
        return response;
      } catch (error) {
        if (local) record({ kind: "request", phase: "failed", path: url!.pathname, method, status: 0, durationMs: performance.now() - start });
        throw error;
      }
    };
    window.fetch = observedFetch;
    const click = (event: MouseEvent) => {
      const action = event.target instanceof Element ? event.target.closest("[data-diagnostic-action]")?.getAttribute("data-diagnostic-action") : null;
      if (action) record({ kind: "action", phase: "started", action, path: location.pathname });
    };
    const browserError = (event: ErrorEvent) => {
      let message = "Browser error";
      try { if (typeof event.error?.name === "string") message = event.error.name.slice(0, 800); } catch { /* avoid reading arbitrary error values */ }
      record({ kind: "error", path: location.pathname, message });
    };
    const reportedError = (event: Event) => {
      const message = (event as CustomEvent).detail?.message;
      if (typeof message === "string") record({ kind: "error", path: location.pathname, message: message.slice(0, 800) });
    };
    const nativeAction = (event: Event) => {
      try {
        const detail = (event as CustomEvent).detail;
        if (typeof detail !== "string" || detail.length > 16_000) return;
        const value = JSON.parse(detail);
        record({ kind: typeof value.message === "string" ? "error" : "action", path: location.pathname,
          action: typeof value.action === "string" ? value.action : undefined, phase: value.phase,
          message: typeof value.message === "string" ? value.message.slice(0, 800) : undefined });
      } catch { /* malformed native observation */ }
    };
    const rejected = () => record({ kind: "error", path: location.pathname, message: "Unhandled promise rejection" });
    const navigation = () => record({ kind: "navigation", path: location.pathname });
    const preference = (event: Event) => {
      const value = (event as CustomEvent).detail?.enabled;
      if (typeof value === "boolean") { preferenceChanged = true; enabled = value; if (!enabled) queue.length = 0; }
    };
    document.addEventListener("click", click, true);
    window.addEventListener("error", browserError);
    window.addEventListener("unhandledrejection", rejected);
    window.addEventListener("blackcat-diagnostic-error", reportedError);
    window.addEventListener("blackcat-native-diagnostic", nativeAction);
    window.addEventListener("blackcat-navigation", navigation);
    window.addEventListener("blackcat-diagnostics-enabled", preference);
    window.addEventListener("pagehide", flush);
    const timer = setInterval(flush, 1000);
    return () => {
      disposed = true; clearInterval(timer); flush();
      if (window.fetch === observedFetch) window.fetch = originalFetch;
      document.removeEventListener("click", click, true);
      window.removeEventListener("error", browserError);
      window.removeEventListener("unhandledrejection", rejected);
      window.removeEventListener("blackcat-diagnostic-error", reportedError);
      window.removeEventListener("blackcat-native-diagnostic", nativeAction);
      window.removeEventListener("blackcat-navigation", navigation);
      window.removeEventListener("blackcat-diagnostics-enabled", preference);
      window.removeEventListener("pagehide", flush);
    };
  }, []);
  useEffect(() => { window.dispatchEvent(new Event("blackcat-navigation")); }, [pathname]);
  return null;
}
