// -----------------------------------------------------------------------------
// Shared helpers for Phase 1+ tool handlers.
//
// Everything here is pure (no I/O) so unit tests can exercise it directly:
//   - Project + filename validators
//   - Strict base64 → Uint8Array decoder
//   - Filename → MIME inference (fallback application/octet-stream)
//   - Cursor encode/decode (base64-of-JSON; lets us evolve the inner shape
//     without breaking persisted cursors)
//   - Success/error ToolResult builders matching the Phase 0 envelope shape
//
// Schema/validation rules per Phase 1 head-session decisions:
//   A4: project name regex ^[a-zA-Z0-9_-]+$, length 1–64. No dots.
//   A5: filename — non-empty, ≤256 chars, no leading slash, no leading dot,
//       no `..` segments, no NUL bytes, no backslashes. Internal `/` allowed.
// -----------------------------------------------------------------------------

import type { ToolResult } from "../types";

// -----------------------------------------------------------------------------
// Constants shared across the write-side path.
// -----------------------------------------------------------------------------

/**
 * Default Cache-Control header value for R2 objects.
 *
 * Phase 4.1 fix for the edge-cache-staleness issue surfaced in Run 5:
 * without explicit Cache-Control, R2 returns no header and Cloudflare's
 * edge caches with default TTLs that hold stale bytes >30 s after a
 * replace. With this value, the edge re-validates within 60 s.
 *
 * Used by:
 *   - performUpload (cdn_upload_file, cdn_replace_file): set as
 *     `httpMetadata.cacheControl` on the R2 PUT.
 *   - buildPresignedPut (cdn_signed_upload_url): signed into the SigV4
 *     URL so the client's PUT must include the matching header (and R2
 *     stores it on the resulting object).
 *
 * Tune by changing this single value. A future cdn_set_cache_headers
 * (still a stub) will let per-asset overrides happen at runtime.
 */
export const DEFAULT_CACHE_CONTROL = "public, max-age=60";

// -----------------------------------------------------------------------------
// Validators
// -----------------------------------------------------------------------------

const PROJECT_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
const PROJECT_NAME_MAX = 64;
const FILENAME_MAX = 256;

/** Returns null if `name` is a valid project name, else a human-readable error. */
export function validateProjectName(name: unknown): string | null {
  if (typeof name !== "string") return "project name must be a string";
  if (name.length === 0) return "project name must be non-empty";
  if (name.length > PROJECT_NAME_MAX)
    return `project name must be ≤ ${PROJECT_NAME_MAX} characters (got ${name.length})`;
  if (!PROJECT_NAME_REGEX.test(name))
    return "project name must match /^[a-zA-Z0-9_-]+$/ (letters, digits, underscore, hyphen)";
  return null;
}

/** Returns null if `name` is a valid filename, else a human-readable error. */
export function validateFileName(name: unknown): string | null {
  if (typeof name !== "string") return "filename must be a string";
  if (name.length === 0) return "filename must be non-empty";
  if (name.length > FILENAME_MAX)
    return `filename must be ≤ ${FILENAME_MAX} characters (got ${name.length})`;
  if (name.includes("\0")) return "filename must not contain NUL bytes";
  if (name.includes("\\")) return "filename must not contain backslashes (use forward slashes)";
  if (name.startsWith("/")) return "filename must not start with a slash";
  if (name.startsWith(".")) return "filename must not start with a dot";
  // Reject any `..` path segment anywhere.
  for (const segment of name.split("/")) {
    if (segment === "..") return "filename must not contain `..` segments";
    if (segment === "") return "filename must not contain empty path segments (consecutive or trailing slashes)";
  }
  return null;
}

// -----------------------------------------------------------------------------
// Base64 decode
// -----------------------------------------------------------------------------

const BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strict base64 → bytes. Rejects whitespace, URL-safe alphabet, and any
 * non-canonical input. Throws on invalid input.
 */
export function decodeBase64(input: unknown): Uint8Array {
  if (typeof input !== "string") {
    throw new Error("content_base64 must be a string");
  }
  // Length must be a multiple of 4.
  if (input.length % 4 !== 0) {
    throw new Error("invalid base64: length must be a multiple of 4");
  }
  if (!BASE64_REGEX.test(input)) {
    throw new Error("invalid base64: contains non-base64 characters");
  }
  let binary: string;
  try {
    binary = atob(input);
  } catch {
    throw new Error("invalid base64: failed to decode");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// -----------------------------------------------------------------------------
// MIME inference
// -----------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "application/javascript",
  json: "application/json",
  txt: "text/plain",
  pdf: "application/pdf",
};

/** Pick MIME from the last `.ext` segment. Fallback `application/octet-stream`. */
export function inferContentType(filename: string): string {
  // Use the basename only — extensions inside subpath segments shouldn't count.
  const basename = filename.includes("/")
    ? filename.slice(filename.lastIndexOf("/") + 1)
    : filename;
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) {
    return "application/octet-stream";
  }
  const ext = basename.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

// -----------------------------------------------------------------------------
// Cursor encode/decode — base64(JSON.stringify(obj))
//
// Opaque to the caller, but lets the server evolve the inner shape without
// breaking previously-issued cursors (additive fields tolerated). On any
// decode failure we return null so the handler can return a clean error
// instead of crashing.
// -----------------------------------------------------------------------------

export function encodeCursor(payload: unknown): string {
  return btoa(JSON.stringify(payload));
}

export function decodeCursor<T>(encoded: unknown): T | null {
  if (typeof encoded !== "string" || encoded.length === 0) return null;
  let json: string;
  try {
    json = atob(encoded);
  } catch {
    return null;
  }
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Response shape helpers
//
// MCP `tools/call` returns `result.content[0].text` with a JSON-stringified
// payload. Phase 0 stubs set `isError: true`. We keep the same shape so the
// connector UI handles errors consistently (red badge, etc.).
// -----------------------------------------------------------------------------

export function okResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

export function errorResult(payload: unknown): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}
