// -----------------------------------------------------------------------------
// SigV4 presigned-URL helper for R2's S3-compatible API.
//
// Used by cdn_signed_upload_url to produce a short-lived URL that a browser /
// curl can PUT bytes to directly, bypassing the Worker's ~100MB request-body
// limit. The signing logic itself is delegated to `aws4fetch` (Workers-native,
// ~5 KB, well-tested with R2). This module is just a thin wrapper that:
//   1. Builds the R2 endpoint URL in the canonical form
//      https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
//   2. Sets the X-Amz-Expires query param BEFORE signing (aws4fetch reads it
//      from the URL, doesn't expose it as a sign() option).
//   3. Signs with `signQuery: true` so the result is a self-contained
//      presigned URL — no separate Authorization header for the client to
//      worry about.
//   4. Optionally includes Content-Type in the signed headers so we can pin
//      the MIME the client must PUT with.
//
// Build Plan rule 1 reminder: schema parameter shape is the contract. This
// helper is internal — its function signature can evolve freely; the tool's
// inputSchema is what's frozen.
// -----------------------------------------------------------------------------

import { AwsClient } from "aws4fetch";

import type { Env } from "../types";
import { DEFAULT_CACHE_CONTROL } from "./util";

/** R2's S3 API uses bucket `cdn-assets` (Build Plan, Resolved). */
const R2_BUCKET = "cdn-assets";

export interface PresignedPutOpts {
  /** R2 key path under the bucket — `${project}/${name}`. */
  r2Key: string;
  /** MIME the client MUST PUT with. Omit to leave Content-Type unsigned/free. */
  contentType?: string;
  /** Validity window in seconds. Caller validates the 60–3600 range. */
  expiresInSeconds: number;
}

export interface PresignedPutResult {
  /** The full presigned URL — already includes X-Amz-* query params. */
  url: string;
  /**
   * Headers the client MUST send when PUTing to this URL. Empty object when
   * no extra headers are required (host is implicit). Always present so
   * callers can iterate without null-check (Phase 4 A2).
   */
  requiredHeaders: Record<string, string>;
}

/**
 * Build a presigned PUT URL for the given R2 key.
 *
 * Throws if env.CLOUDFLARE_ACCOUNT_ID, env.R2_ACCESS_KEY_ID, or
 * env.R2_SECRET_ACCESS_KEY is missing. The handler upstream catches this and
 * returns a clean error envelope. We don't validate the credentials' actual
 * permissions here — if the keys can't sign, the live PUT will fail loudly.
 */
export async function buildPresignedPut(
  env: Env,
  opts: PresignedPutOpts
): Promise<PresignedPutResult> {
  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID env var is not set");
  }
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error(
      "R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY secrets are not set — " +
        "create an R2 API token (Object Read & Write on cdn-assets) and run " +
        "`wrangler secret put R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY`."
    );
  }

  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });

  // R2's S3 endpoint format: <account>.r2.cloudflarestorage.com/<bucket>/<key>.
  // Note: account ID in the hostname, bucket in the path. Path-style URLs
  // (the only form R2 supports) require this.
  //
  // Encode each segment of r2Key separately so spaces / unicode / etc. survive
  // signing. Project + filename validators upstream forbid most special
  // characters anyway, but this is cheap correctness insurance.
  const encodedKey = opts.r2Key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const url = new URL(
    `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${encodedKey}`
  );
  // aws4fetch reads X-Amz-Expires from the URL when signQuery is true.
  url.searchParams.set("X-Amz-Expires", String(opts.expiresInSeconds));

  const headers: Record<string, string> = {};
  if (opts.contentType) {
    // Embedded in X-Amz-SignedHeaders. The client MUST send this exact
    // Content-Type header when PUTing — otherwise R2 rejects with a
    // SignatureDoesNotMatch error.
    headers["Content-Type"] = opts.contentType;
  }

  // Phase 4.1: always sign a Cache-Control header so R2 stores it on the
  // resulting object. Without it, R2 returns no Cache-Control on public
  // reads and Cloudflare's edge falls back to long defaults that hold
  // stale bytes >30 s after a replace. The client MUST send the matching
  // header on PUT (surfaced via requiredHeaders below). Symmetric with
  // performUpload.ts's R2 PUT, which also sets cacheControl: DEFAULT_CACHE_CONTROL.
  headers["Cache-Control"] = DEFAULT_CACHE_CONTROL;

  // aws4fetch quirk: by default Content-Type (and a few other headers) are
  // in its UNSIGNABLE_HEADERS set, so they get filtered out of the signed
  // headers list even when present on the request. For our use case we
  // WANT them signed so R2 enforces "the client must PUT with the headers
  // we promised." Passing allHeaders: true overrides the unsignable list.
  // Cache-Control isn't in UNSIGNABLE_HEADERS, but allHeaders: true is a
  // no-op for it either way — keeping the flag for the Content-Type case.
  const signed = await aws.sign(url.toString(), {
    method: "PUT",
    headers,
    aws: { signQuery: true, allHeaders: true },
  });

  return {
    url: signed.url,
    // Mirror the request-side requirement: callers iterate this map and set
    // these on their PUT. Always at least { Cache-Control: ... }; populated
    // with Content-Type when contentType was provided.
    requiredHeaders: { ...headers },
  };
}
