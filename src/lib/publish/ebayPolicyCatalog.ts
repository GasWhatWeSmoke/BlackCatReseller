import type { AppSettingsData } from "../types.ts";

export type EbayPolicyKind = "shipping" | "return" | "payment";
export interface EbayPolicy { kind: EbayPolicyKind; name: string; isDefault: boolean }
export interface EbayPolicyCatalog { readAt: string; complete: true; policies: EbayPolicy[] }
export const EBAY_POLICY_FIELDS = ["shippingPolicyName", "returnPolicyName", "paymentPolicyName"] as const;
export const EBAY_POLICY_KINDS = { shippingPolicyName: "shipping", returnPolicyName: "return", paymentPolicyName: "payment" } as const;

function policies(value: unknown): EbayPolicy[] {
  if (!Array.isArray(value) || value.length > 200) throw Error("eBay policies were incomplete; no preferences were changed.");
  const rows: EbayPolicy[] = value.map(row => {
    if (!row || !["shipping", "return", "payment"].includes(row.kind) || typeof row.name !== "string" || !row.name.trim() ||
        row.name.length > 200 || /[\u0000-\u001f]/.test(row.name) || typeof row.isDefault !== "boolean") throw Error("eBay returned an invalid policy.");
    return { kind: row.kind, name: row.name.trim(), isDefault: row.isDefault };
  });
  if (new Set(rows.map(row => `${row.kind}:${row.name.toLocaleLowerCase()}`)).size !== rows.length)
    throw Error("eBay has duplicate policy names; automatic selection needs review.");
  return rows;
}
export function validateEbayPolicyResult(value: unknown): EbayPolicyCatalog {
  const result = value as Record<string, unknown> | null;
  if (result?.ok !== true) throw Error(typeof result?.error === "string" ? result.error : "eBay policy reading did not complete.");
  if (result.complete !== true) throw Error("eBay policies were incomplete; no preferences were changed.");
  return { readAt: new Date().toISOString(), complete: true, policies: policies(result.policies) };
}
export function savedEbayPolicyCatalog(value: unknown): EbayPolicyCatalog | undefined {
  if (value == null) return undefined;
  const catalog = value as Record<string, unknown>;
  if (catalog.complete !== true || typeof catalog.readAt !== "string" || !Number.isFinite(Date.parse(catalog.readAt)))
    throw Error("Saved eBay policy choices are incomplete. Refresh policies.");
  return { readAt: catalog.readAt, complete: true, policies: policies(catalog.policies) };
}
export function ebayPolicyNames(settings: AppSettingsData): Record<typeof EBAY_POLICY_FIELDS[number], string> {
  return Object.fromEntries(EBAY_POLICY_FIELDS.map(field => [field, settings.publish?.ebayBrowser?.[field]?.trim() || ""])) as Record<typeof EBAY_POLICY_FIELDS[number], string>;
}

/** Preserve manual choices and edits made while the read-only browser lookup ran.
 * Only an unchanged empty field receives a sole or uniquely defaulted policy. */
export function mergeEbayPolicies(current: AppSettingsData, before: AppSettingsData, catalog: EbayPolicyCatalog): Partial<AppSettingsData> {
  if (current.dataRoot !== before.dataRoot) throw Error("The settings workspace changed. Refresh before linking policies.");
  const previous = ebayPolicyNames(before), latest = ebayPolicyNames(current), patch: Record<string, string> = {};
  for (const field of EBAY_POLICY_FIELDS) {
    if (latest[field] || latest[field] !== previous[field]) continue;
    const choices = catalog.policies.filter(policy => policy.kind === EBAY_POLICY_KINDS[field]);
    const defaults = choices.filter(policy => policy.isDefault);
    const selected = defaults.length === 1 ? defaults[0] : choices.length === 1 ? choices[0] : null;
    if (selected) patch[field] = selected.name;
  }
  return { publish: { ...current.publish, ebayPolicyCatalog: catalog,
    ebayBrowser: { enabled: current.publish?.ebayBrowser?.enabled ?? false, ...current.publish?.ebayBrowser, ...patch } } };
}
