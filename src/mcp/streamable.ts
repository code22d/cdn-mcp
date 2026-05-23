// -----------------------------------------------------------------------------
// src/mcp/streamable.ts — Streamable HTTP transport for /mcp (no token).
//
// claude.ai's modern Custom Connector flow uses this transport:
//   POST /mcp       JSON-RPC request (response is one JSON envelope)
//   GET  /mcp       SSE event stream so the server can push to the client
//   DELETE /mcp     Optional session termination
//
// All three require Authorization: Bearer <access_token>. On a missing or
// invalid bearer we return 401 + WWW-Authenticate that points at our
// Protected Resource Metadata endpoint — this is the discovery signal
// claude.ai uses to begin the OAuth dance.
// -----------------------------------------------------------------------------

import { CORS_HEADERS, corsResponse } from "../cors";
import { handleMcp } from "./dispatch";
import { verifyJwt, type AccessTokenPayload } from "../oauth/jwt";
import { issuerFromRequest } from "../oauth/metadata";
import { requireSigningKey } from "../oauth/signing-key";
import type { Env } from "../types";

export async function handleStreamable(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method === "POST") return handleStreamablePost(request, env);
  if (request.method === "GET") return handleStreamableGet(request, env);
  if (request.method === "DELETE") return handleStreamableDelete(request, env);
  return corsResponse("Method Not Allowed", { status: 405 });
}

// -----------------------------------------------------------------------------
// POST /mcp — JSON-RPC over a single response.
// -----------------------------------------------------------------------------

async function handleStreamablePost(request: Request, env: Env): Promise<Response> {
  const auth = await requireBearer(request, env);
  if (auth instanceof Response) return auth;
  // The existing handleMcp does the JSON-RPC dispatch and already enforces
  // CORS on its responses. The /mcp/<token> path uses the same function.
  return handleMcp(request, env);
}

// -----------------------------------------------------------------------------
// GET /mcp — SSE keep-alive stream.
//
// We have no server-initiated messages in v1 — every reply is request/response
// over POST. The GET stream exists so claude.ai's client is happy to see a
// 200 + text/event-stream, and stays connected for a future where we push
// notifications/* messages from the server.
//
// Pattern: a TransformStream whose writer we own. We push a ":\n\n" comment
// (legal SSE keep-alive that no client surfaces as an event) every 25s. The
// Worker holds the stream open until the platform terminates the request or
// the client disconnects.
// -----------------------------------------------------------------------------

async function handleStreamableGet(request: Request, env: Env): Promise<Response> {
  const auth = await requireBearer(request, env);
  if (auth instanceof Response) return auth;

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  // Initial comment — flushes the response header to the client immediately.
  writer.write(enc.encode(":connected\n\n")).catch(() => {});

  // writer.close() returns a promise that rejects if the stream has already
  // been closed/errored (e.g. the consumer called reader.cancel()). Swallow
  // both the sync throw and the async rejection — we only ever call this in
  // teardown paths where the failure is informational.
  const closeQuietly = (): void => {
    try {
      writer.close().catch(() => { /* ignore */ });
    } catch { /* ignore */ }
  };

  const interval = setInterval(() => {
    writer.write(enc.encode(":\n\n")).catch(() => {
      clearInterval(interval);
      closeQuietly();
    });
  }, 25_000);

  // If the client disconnects (or the Worker is asked to abort), tear down.
  // request.signal exists on modern Workers; guard for older runtimes.
  const signal = (request as Request & { signal?: AbortSignal }).signal;
  if (signal) {
    signal.addEventListener("abort", () => {
      clearInterval(interval);
      closeQuietly();
    });
  }

  return new Response(readable, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disables nginx-style buffering on intermediaries — Cloudflare doesn't
      // need this, but some intermediate proxies do.
      "X-Accel-Buffering": "no",
    },
  });
}

// -----------------------------------------------------------------------------
// DELETE /mcp — session termination. We have no session state to clear, so
// a 204 is the truthful answer.
// -----------------------------------------------------------------------------

async function handleStreamableDelete(request: Request, env: Env): Promise<Response> {
  const auth = await requireBearer(request, env);
  if (auth instanceof Response) return auth;
  return corsResponse(null, { status: 204 });
}

// -----------------------------------------------------------------------------
// Bearer extraction + verification.
// -----------------------------------------------------------------------------

async function requireBearer(
  request: Request,
  env: Env
): Promise<AccessTokenPayload | Response> {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header) {
    return unauthorized(request, "missing_token", "Authorization header is required");
  }
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) {
    return unauthorized(request, "invalid_token", "Authorization header must be 'Bearer <token>'");
  }
  const token = m[1]!.trim();

  const signingKey = requireSigningKey(env);
  if (signingKey instanceof Response) return signingKey;

  let payload: AccessTokenPayload;
  try {
    payload = await verifyJwt<AccessTokenPayload>(token, signingKey);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return unauthorized(request, "invalid_token", message);
  }
  if (payload.typ !== "access") {
    return unauthorized(request, "invalid_token", "token is not an access token");
  }
  return payload;
}

function unauthorized(
  request: Request,
  error: string,
  description: string
): Response {
  const resourceMetadata = `${issuerFromRequest(request)}/.well-known/oauth-protected-resource`;
  const wwwAuth =
    `Bearer realm="cdn-mcp", ` +
    `error="${error}", ` +
    `error_description="${description.replace(/"/g, "'")}", ` +
    `resource_metadata="${resourceMetadata}"`;
  return new Response(
    JSON.stringify({ error, error_description: description }),
    {
      status: 401,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
        "WWW-Authenticate": wwwAuth,
      },
    }
  );
}
