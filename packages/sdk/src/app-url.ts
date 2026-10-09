/**
 * Where the Flaggr app's routes are for a client's apiUrl.
 *
 * The hosted data plane, https://api.flaggr.dev (the client's default
 * apiUrl), serves only evaluation. The app's routes, such as
 * GET /api/sdk-config (remote config) and POST /api/analytics/sdk-telemetry
 * (the telemetry plugin), are at https://flaggr.dev. Any other apiUrl (the app
 * itself, a self-hosted deployment or a same-origin proxy) serves them at
 * the apiUrl.
 */

/** The hosted data plane (the client's default apiUrl): evaluation only. */
export const HOSTED_DATA_PLANE_HOST = "api.flaggr.dev";
/** The hosted Flaggr app. */
export const HOSTED_APP_ORIGIN = "https://flaggr.dev";

/**
 * The base URL of the Flaggr app for `apiUrl`, without a trailing slash. An
 * unset apiUrl stands for the client's default, the hosted data plane. An
 * empty one (or "/") is the page's own origin: "".
 */
export function appBaseUrl(apiUrl: string | undefined): string {
  if (apiUrl === undefined) return HOSTED_APP_ORIGIN;
  const base = apiUrl.replace(/\/+$/, "");
  let host = "";
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    /* not an absolute URL: the app is next to it */
  }
  return host === HOSTED_DATA_PLANE_HOST ? HOSTED_APP_ORIGIN : base;
}
