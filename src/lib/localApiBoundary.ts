export const LOCAL_APP_HOST = "127.0.0.1:41999";
export const LOCAL_APP_ORIGIN = `http://${LOCAL_APP_HOST}`;

type HeaderReader = {
  get(name: string): string | null;
};

export type LocalApiBoundaryDecision =
  | { ok: true }
  | { ok: false; status: 403 | 421; error: "FORBIDDEN_ORIGIN" | "INVALID_HOST"; message: string };

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Enforce the desktop app's fixed loopback origin without breaking local CLI and
 * test clients, which legitimately omit browser-only Origin/Fetch-Metadata headers.
 */
export function checkLocalApiBoundary(
  method: string,
  headers: HeaderReader,
  options: { preview?: boolean; previewPort?: string } = {},
): LocalApiBoundaryDecision {
  const previewPort = Number(options.previewPort);
  const validPreview = options.preview === true && Number.isInteger(previewPort) && previewPort >= 49152 && previewPort <= 65535;
  if (options.preview === true && !validPreview) {
    return { ok: false, status: 421, error: "INVALID_HOST", message: "This preview requires an explicit loopback port from 49152 through 65535." };
  }
  const expectedHost = validPreview ? `127.0.0.1:${previewPort}` : LOCAL_APP_HOST;
  const expectedOrigin = `http://${expectedHost}`;
  const host = headers.get("host")?.trim().toLowerCase() ?? "";
  if (host !== expectedHost) {
    return {
      ok: false,
      status: 421,
      error: "INVALID_HOST",
      message: `This API is available only at ${expectedOrigin}.`,
    };
  }

  if (SAFE_METHODS.has(method.toUpperCase())) return { ok: true };

  const origin = headers.get("origin");
  if (origin !== null && origin !== expectedOrigin) {
    return {
      ok: false,
      status: 403,
      error: "FORBIDDEN_ORIGIN",
      message: "Cross-origin API requests are not allowed.",
    };
  }

  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite.trim().toLowerCase() !== "same-origin") {
    return {
      ok: false,
      status: 403,
      error: "FORBIDDEN_ORIGIN",
      message: "Cross-site API requests are not allowed.",
    };
  }

  return { ok: true };
}
