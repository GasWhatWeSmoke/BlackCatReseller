"use client";
import { parseEvidence } from "@/lib/itemEdits";

/** Descriptive evidence states, never invented numerical confidence scores. */
export function AttributeEvidence({ evidenceJson }: { evidenceJson?: string | null }) {
  const evidence = parseEvidence(evidenceJson);
  const fields = [...new Set(["brand", "size", "measurements", ...Object.keys(evidence)])];
  return <details className="card" style={{ padding: 14, marginTop: 12 }}>
    <summary>Attribute evidence and review</summary>
    <p className="muted">Tagged size comes from a garment label. Dimensions are separate; ambiguous ruler photos require manual measurement.</p>
    <div style={{ overflowX: "auto" }}><table style={{ width: "100%", textAlign: "left" }}><thead><tr><th>Attribute</th><th>Value</th><th>Evidence status</th><th>Source</th></tr></thead>
      <tbody>{fields.map(field => {
        const entry = evidence[field] as (typeof evidence[string] & { sourceEvidence?: unknown }) | undefined;
        return <tr key={field}><td>{field === "size" ? "Tagged size" : field}</td><td>{entry?.value == null ? "Unknown" : String(entry.value)}</td>
          <td>{entry?.status ?? "Needs review"}</td><td>{entry?.sources?.join(", ") || "No supporting evidence"}{entry?.rawOcr && <div>Read: {entry.rawOcr}</div>}{entry?.note && <div>{entry.note}</div>}
            {entry?.sourceEvidence ? <details><summary>Photo regions</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(entry.sourceEvidence, null, 2)}</pre></details> : null}</td></tr>;
      })}</tbody></table></div>
  </details>;
}
