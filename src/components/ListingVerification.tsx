"use client";
import { useRef, useState } from "react";
import { toast } from "sonner";
export default function ListingVerification({ jobId, sku, marketplace, revision, onResolved, disabled = false }: {
  jobId: number; sku: string; marketplace: string; revision: string; onResolved: () => Promise<void>; disabled?: boolean;
}) {
  const [url, setUrl] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  async function resolve(outcome: "published" | "not_published") {
    if (!checked || submitting.current || disabled) return;
    submitting.current = true; setBusy(true);
    try {
      const response = await fetch(`/api/publish/jobs/${jobId}/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome, url, confirmed: true, expectedRevision: revision }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        if (response.status === 409) { setChecked(false); setUrl(""); await onResolved(); }
        throw new Error(result.error || "Could not save verification.");
      }
      toast.success(outcome === "published" ? "Live listing recorded." : "Verified not published. You can now retry.");
      await onResolved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save verification.");
    } finally { submitting.current = false; setBusy(false); }
  }

  return <div style={{ width: "100%", padding: "8px 0", display: "flex", flexDirection: "column", gap: 8 }}>
    <span>Check {sku} on {marketplace} before another publishing attempt.</span>
    <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <input type="checkbox" checked={checked} disabled={busy || disabled} onChange={(event) => setChecked(event.target.checked)} />
      I checked this item&apos;s listings on {marketplace}.
    </label>
    <label style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      Live listing URL
      <input type="url" className="input" value={url} disabled={busy || disabled} placeholder={`https://www.${marketplace}.com/...`}
        onChange={(event) => setUrl(event.target.value)} style={{ flex: 1, minWidth: 0, width: '100%' }} />
    </label>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button className="btn" disabled={!checked || !url.trim() || busy || disabled} onClick={() => void resolve("published")}>Record live listing</button>
      <button className="btn" disabled={!checked || !!url.trim() || busy || disabled} onClick={() => void resolve("not_published")}>Confirm not published</button>
    </div>
  </div>;
}
