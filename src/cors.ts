// -----------------------------------------------------------------------------
// CORS — every response from this Worker (including 404s and errors) must
// carry these headers. Lessons-page rule: "the most common silent failure".
//
// MCP clients (including Claude's Custom Connector) need permissive CORS to
// complete the JSON-RPC handshake. We don't restrict origins here — auth is
// handled by the path-embedded MCP_AUTH_TOKEN.
// -----------------------------------------------------------------------------

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

/** Build a Response with CORS headers merged in. */
export function corsResponse(
  body: BodyInit | null,
  init: ResponseInit = {}
): Response {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(body, { ...init, headers });
}

/** Build a JSON Response with CORS headers + content-type set. */
export function jsonResponse(
  body: unknown,
  init: ResponseInit = {}
): Response {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}
