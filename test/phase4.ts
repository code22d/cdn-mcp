// -----------------------------------------------------------------------------
// test/phase4.ts — Phase 4 synthetic tests.
//
// Asserts the new behaviors layered on top of the Phase 1+2+3 substrate:
//
//   cdn_signed_upload_url:
//     - Happy path returns a URL hosted on the right R2 endpoint, with the
//       expected SigV4 query params (Algorithm, Credential, Date, Expires,
//       SignedHeaders, Signature). NO D1 row is written.
//     - file_exists guard fires when (project, name) row exists and replace
//       is not true. Bypassed by replace: true.
//     - Validators fire before any I/O.
//     - expires_in_seconds default 900, range [60, 3600].
//     - required_headers always present — populated when content_type is
//       provided, empty {} otherwise (Phase 4 A2).
//     - expires_at is roughly now + expires_in_seconds (Phase 4 A3).
//     - SignatureVerification is NOT tested — that's the live integration
//       layer's job. We assert URL shape, not crypto correctness.
//
//   cdn_finalize_upload:
//     - r2_object_not_found when no R2 head() match.
//     - size_mismatch when reported size diverges from R2's.
//     - Happy INSERT path: version 1, last_replaced_at null.
//     - Happy UPDATE path: version 2, last_replaced_at set, content_type
//       from finalize wins on replace (Phase 4 A5).
//     - Validators fire before any I/O.
//     - size_bytes: 0 allowed (Phase 4 A4).
//     - rollbackOnInsertFailure: false — INSERT failure does NOT delete
//       bytes (the finalize-side don't-rollback contract).
//     - Idempotent retry: a second finalize after a transient INSERT failure
//       commits cleanly without re-uploading bytes.
//
// Style matches sanity.ts / phase1–3 — node:assert/strict, no framework.
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";

import { cdn_signed_upload_url } from "../src/mcp/tools/cdn_signed_upload_url";
import { cdn_finalize_upload } from "../src/mcp/tools/cdn_finalize_upload";
import { cdn_get_file } from "../src/mcp/tools/cdn_get_file";
import { cdn_list_files } from "../src/mcp/tools/cdn_list_files";
import { cdn_upload_file } from "../src/mcp/tools/cdn_upload_file";

import {
  MockStore,
  makeCtx,
  parseResult,
  seedR2,
  SAMPLE_PNG_B64,
  SAMPLE_PNG_LEN,
} from "./_mock";

// -----------------------------------------------------------------------------
// Test runner — same shape as the rest of the suite.
// -----------------------------------------------------------------------------

let pass = 0;
let fail = 0;

function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        console.log(`  ✓ ${label}`);
        pass++;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.log(`  ✗ ${label}\n    ${message}`);
        fail++;
      }
    );
}

// Helper: decode base64 → bytes, no validation. Used for the INSERT-failure
// retry test where we need to seed bytes that match a known size.
function b64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const SAMPLE_PNG = b64Bytes(SAMPLE_PNG_B64);

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

async function main() {
  console.log("cdn-mcp Phase 4 tests");
  console.log("=====================");

  // ===================================================================
  // cdn_signed_upload_url
  // ===================================================================

  await check(
    "cdn_signed_upload_url: happy path returns a URL on the R2 endpoint with SigV4 query params",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);

      const res = await cdn_signed_upload_url.handler(
        {
          project: "phase4-test",
          name: "fixture.bin",
          content_type: "application/octet-stream",
        },
        ctx
      );
      assert.notEqual(res.isError, true, JSON.stringify(res));
      const payload = parseResult(res) as {
        upload_url: string;
        method: string;
        expires_at: string;
        expires_in_seconds: number;
        project: string;
        name: string;
        public_url_after_finalize: string;
        required_headers: Record<string, string>;
      };

      // URL targets the right R2 endpoint + bucket + key.
      const url = new URL(payload.upload_url);
      assert.match(
        url.hostname,
        /^test-account-id-[a-z0-9]+\.r2\.cloudflarestorage\.com$/,
        `unexpected hostname: ${url.hostname}`
      );
      assert.equal(
        url.pathname,
        "/cdn-assets/phase4-test/fixture.bin",
        "path-style URL: /<bucket>/<key>"
      );

      // SigV4 query params are all there. We don't verify the signature
      // cryptographically — that's the live test's job.
      assert.equal(
        url.searchParams.get("X-Amz-Algorithm"),
        "AWS4-HMAC-SHA256"
      );
      assert.match(
        url.searchParams.get("X-Amz-Credential") ?? "",
        /TESTACCESSKEYID0000\/\d{8}\/auto\/s3\/aws4_request/
      );
      assert.match(url.searchParams.get("X-Amz-Date") ?? "", /^\d{8}T\d{6}Z$/);
      assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
      assert.ok(
        url.searchParams.get("X-Amz-SignedHeaders")?.includes("host"),
        "X-Amz-SignedHeaders must include host"
      );
      assert.ok(
        url.searchParams.get("X-Amz-SignedHeaders")?.includes("content-type"),
        "X-Amz-SignedHeaders must include content-type when content_type was provided"
      );
      assert.match(
        url.searchParams.get("X-Amz-Signature") ?? "",
        /^[a-f0-9]{64}$/
      );

      // Phase 4.1: Cache-Control is always signed alongside whatever else.
      assert.ok(
        url.searchParams.get("X-Amz-SignedHeaders")?.includes("cache-control"),
        "X-Amz-SignedHeaders must include cache-control (Phase 4.1)"
      );

      // Method + scalar fields.
      assert.equal(payload.method, "PUT");
      assert.equal(payload.expires_in_seconds, 900);
      assert.equal(payload.project, "phase4-test");
      assert.equal(payload.name, "fixture.bin");
      assert.equal(
        payload.public_url_after_finalize,
        "https://cdn.22d.app/phase4-test/fixture.bin"
      );

      // Phase 4 A2 + Phase 4.1: required_headers always present, populated
      // with Content-Type when content_type was provided AND with
      // Cache-Control unconditionally.
      assert.deepEqual(payload.required_headers, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "public, max-age=60",
      });

      // expires_at ~ now + 900s. Allow a 5-second clock-skew tolerance.
      const expiresAt = Date.parse(payload.expires_at);
      const target = Date.now() + 900_000;
      assert.ok(
        Math.abs(expiresAt - target) < 5_000,
        `expires_at (${payload.expires_at}) not within 5s of now+900s`
      );

      // Crucially: NO D1 row was written.
      assert.equal(store.files.length, 0, "presign must not create D1 row");
      assert.equal(
        store.projects.length,
        0,
        "presign must not auto-create project"
      );
    }
  );

  await check(
    "cdn_signed_upload_url: required_headers carries Cache-Control alone when content_type omitted (Phase 4.1)",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      const res = await cdn_signed_upload_url.handler(
        { project: "phase4-test", name: "untyped.bin" },
        ctx
      );
      assert.notEqual(res.isError, true);
      const payload = parseResult(res) as {
        required_headers: Record<string, string>;
        upload_url: string;
      };
      // Phase 4.1: Cache-Control always present even without content_type.
      assert.deepEqual(payload.required_headers, {
        "Cache-Control": "public, max-age=60",
      });

      // SignedHeaders should include cache-control + host but NOT content-type.
      const url = new URL(payload.upload_url);
      const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders") ?? "";
      assert.equal(
        signedHeaders.includes("content-type"),
        false,
        "content-type must NOT be in SignedHeaders when omitted"
      );
      assert.ok(
        signedHeaders.includes("cache-control"),
        "cache-control must always be in SignedHeaders (Phase 4.1)"
      );
      assert.ok(
        signedHeaders.includes("host"),
        "host must always be in SignedHeaders"
      );
    }
  );

  await check(
    "cdn_signed_upload_url: file_exists guard fires when row exists and replace is not true",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      // Seed a real row via cdn_upload_file.
      await cdn_upload_file.handler(
        {
          project: "phase4-test",
          name: "occupied.png",
          content_base64: SAMPLE_PNG_B64,
        },
        ctx
      );

      const res = await cdn_signed_upload_url.handler(
        { project: "phase4-test", name: "occupied.png" },
        ctx
      );
      assert.equal(res.isError, true);
      const payload = parseResult(res) as { error: string; message: string };
      assert.equal(payload.error, "file_exists");
      assert.match(payload.message, /phase4-test\/occupied\.png/);
    }
  );

  await check(
    "cdn_signed_upload_url: replace: true bypasses file_exists guard",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      await cdn_upload_file.handler(
        {
          project: "phase4-test",
          name: "occupied.png",
          content_base64: SAMPLE_PNG_B64,
        },
        ctx
      );

      const res = await cdn_signed_upload_url.handler(
        { project: "phase4-test", name: "occupied.png", replace: true },
        ctx
      );
      assert.notEqual(res.isError, true, JSON.stringify(res));
      const payload = parseResult(res) as { upload_url: string };
      assert.match(payload.upload_url, /^https:\/\//);
    }
  );

  await check(
    "cdn_signed_upload_url: validators fire before any I/O",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);

      const r1 = await cdn_signed_upload_url.handler(
        { project: "with space", name: "x.bin" },
        ctx
      );
      assert.equal(r1.isError, true);
      assert.equal((parseResult(r1) as { error: string }).error, "invalid_project");

      const r2 = await cdn_signed_upload_url.handler(
        { project: "p", name: "../escape.bin" },
        ctx
      );
      assert.equal(r2.isError, true);
      assert.equal((parseResult(r2) as { error: string }).error, "invalid_name");

      // Missing args.
      const r3 = await cdn_signed_upload_url.handler({}, ctx);
      assert.equal(r3.isError, true);
      assert.equal((parseResult(r3) as { error: string }).error, "invalid_project");
    }
  );

  await check(
    "cdn_signed_upload_url: expires_in_seconds bounds enforced [60, 3600], integer required",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);

      // Below min.
      const tooShort = await cdn_signed_upload_url.handler(
        { project: "p", name: "x.bin", expires_in_seconds: 30 },
        ctx
      );
      assert.equal(tooShort.isError, true);
      assert.equal(
        (parseResult(tooShort) as { error: string }).error,
        "invalid_expires_in_seconds"
      );

      // Above max.
      const tooLong = await cdn_signed_upload_url.handler(
        { project: "p", name: "x.bin", expires_in_seconds: 7200 },
        ctx
      );
      assert.equal(tooLong.isError, true);

      // Non-integer.
      const fractional = await cdn_signed_upload_url.handler(
        { project: "p", name: "x.bin", expires_in_seconds: 60.5 },
        ctx
      );
      assert.equal(fractional.isError, true);

      // Lower bound is fine.
      const minOk = await cdn_signed_upload_url.handler(
        { project: "p", name: "x.bin", expires_in_seconds: 60 },
        ctx
      );
      assert.notEqual(minOk.isError, true, JSON.stringify(minOk));
      assert.equal(
        (parseResult(minOk) as { expires_in_seconds: number }).expires_in_seconds,
        60
      );

      // Upper bound is fine.
      const maxOk = await cdn_signed_upload_url.handler(
        { project: "p", name: "x.bin", expires_in_seconds: 3600 },
        ctx
      );
      assert.notEqual(maxOk.isError, true);
      assert.equal(
        (parseResult(maxOk) as { expires_in_seconds: number }).expires_in_seconds,
        3600
      );
    }
  );

  await check(
    "cdn_signed_upload_url: empty content_type rejected with invalid_content_type",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      const res = await cdn_signed_upload_url.handler(
        { project: "p", name: "x.bin", content_type: "" },
        ctx
      );
      assert.equal(res.isError, true);
      assert.equal(
        (parseResult(res) as { error: string }).error,
        "invalid_content_type"
      );
    }
  );

  // ===================================================================
  // cdn_finalize_upload
  // ===================================================================

  await check(
    "cdn_finalize_upload: r2_object_not_found when bytes were never PUT",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);

      const res = await cdn_finalize_upload.handler(
        {
          project: "phase4-test",
          name: "missing.bin",
          content_type: "application/octet-stream",
          size_bytes: 100,
        },
        ctx
      );
      assert.equal(res.isError, true);
      const payload = parseResult(res) as { error: string; message: string };
      assert.equal(payload.error, "r2_object_not_found");
      assert.match(payload.message, /phase4-test\/missing\.bin/);
      // No D1 side effects.
      assert.equal(store.files.length, 0);
      assert.equal(store.projects.length, 0);
    }
  );

  await check(
    "cdn_finalize_upload: size_mismatch when reported size differs from R2's actual",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      seedR2(store, "phase4-test/partial.bin", SAMPLE_PNG, "application/octet-stream");

      const res = await cdn_finalize_upload.handler(
        {
          project: "phase4-test",
          name: "partial.bin",
          content_type: "application/octet-stream",
          size_bytes: 9999, // lies — R2 has SAMPLE_PNG_LEN bytes.
        },
        ctx
      );
      assert.equal(res.isError, true);
      const payload = parseResult(res) as { error: string; message: string };
      assert.equal(payload.error, "size_mismatch");
      assert.match(payload.message, new RegExp(`${SAMPLE_PNG_LEN}`));
      // No D1 side effects.
      assert.equal(store.files.length, 0);
      assert.equal(store.projects.length, 0);
      // R2 bytes UNTOUCHED — we don't sweep bytes the client put.
      assert.equal(store.r2.size, 1);
    }
  );

  await check(
    "cdn_finalize_upload: happy INSERT path — version 1, last_replaced_at null, project auto-created",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      seedR2(
        store,
        "phase4-test/fixture.bin",
        SAMPLE_PNG,
        "application/octet-stream"
      );

      const res = await cdn_finalize_upload.handler(
        {
          project: "phase4-test",
          name: "fixture.bin",
          content_type: "application/octet-stream",
          size_bytes: SAMPLE_PNG_LEN,
        },
        ctx
      );
      assert.notEqual(res.isError, true, JSON.stringify(res));
      const payload = parseResult(res) as {
        url: string;
        project: string;
        name: string;
        size_bytes: number;
        content_type: string;
        uploaded_at: string;
        last_replaced_at: string | null;
        version: number;
      };
      assert.equal(payload.url, "https://cdn.22d.app/phase4-test/fixture.bin");
      assert.equal(payload.project, "phase4-test");
      assert.equal(payload.name, "fixture.bin");
      assert.equal(payload.size_bytes, SAMPLE_PNG_LEN);
      assert.equal(payload.content_type, "application/octet-stream");
      assert.match(payload.uploaded_at, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(payload.last_replaced_at, null);
      assert.equal(payload.version, 1);

      // D1 row exists, project auto-created.
      assert.equal(store.files.length, 1);
      assert.equal(store.projects.length, 1);
      assert.equal(store.projects[0]!.name, "phase4-test");

      // Listable + gettable, in the same shape as cdn_upload_file's outputs.
      const listed = await cdn_list_files.handler(
        { project: "phase4-test" },
        ctx
      );
      const listedPayload = parseResult(listed) as {
        files: Array<Record<string, unknown>>;
      };
      assert.equal(listedPayload.files.length, 1);

      const got = await cdn_get_file.handler(
        { project: "phase4-test", name: "fixture.bin" },
        ctx
      );
      const gotPayload = parseResult(got) as Record<string, unknown>;
      assert.deepEqual(gotPayload, listedPayload.files[0]);
      assert.equal(gotPayload.size_bytes, SAMPLE_PNG_LEN);
    }
  );

  await check(
    "cdn_finalize_upload: happy UPDATE path — version 2, last_replaced_at set, content_type from finalize wins (A5)",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);

      // First commit — version 1 with explicit content_type.
      seedR2(store, "phase4-test/dyn.bin", SAMPLE_PNG, "application/x-original");
      const r1 = await cdn_finalize_upload.handler(
        {
          project: "phase4-test",
          name: "dyn.bin",
          content_type: "application/x-original",
          size_bytes: SAMPLE_PNG_LEN,
        },
        ctx
      );
      assert.notEqual(r1.isError, true);
      assert.equal((parseResult(r1) as { version: number }).version, 1);

      // Simulate the presigned-replace path: client PUT new bytes (we just
      // overwrite the seed) AND reports a different content_type at finalize.
      const NEW_BYTES_LEN = 1234;
      const newBytes = new Uint8Array(NEW_BYTES_LEN);
      seedR2(store, "phase4-test/dyn.bin", newBytes, "application/x-new");

      const r2 = await cdn_finalize_upload.handler(
        {
          project: "phase4-test",
          name: "dyn.bin",
          content_type: "application/x-new",
          size_bytes: NEW_BYTES_LEN,
        },
        ctx
      );
      assert.notEqual(r2.isError, true, JSON.stringify(r2));
      const payload = parseResult(r2) as {
        version: number;
        last_replaced_at: string | null;
        content_type: string;
        size_bytes: number;
        url: string;
        uploaded_at: string;
      };
      assert.equal(payload.version, 2);
      assert.ok(
        payload.last_replaced_at !== null,
        "last_replaced_at must be set on UPDATE"
      );
      // A5: finalize's content_type wins.
      assert.equal(payload.content_type, "application/x-new");
      assert.equal(payload.size_bytes, NEW_BYTES_LEN);
      assert.equal(payload.url, "https://cdn.22d.app/phase4-test/dyn.bin");

      // uploaded_at preserved across replace.
      assert.equal(store.files.length, 1);
      assert.equal(store.files[0]!.content_type, "application/x-new");
      assert.equal(store.files[0]!.size_bytes, NEW_BYTES_LEN);
      assert.equal(store.files[0]!.version, 2);
    }
  );

  await check(
    "cdn_finalize_upload: size_bytes: 0 is allowed (A4 — empty files are valid)",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      seedR2(store, "phase4-test/empty.txt", new Uint8Array(0), "text/plain");

      const res = await cdn_finalize_upload.handler(
        {
          project: "phase4-test",
          name: "empty.txt",
          content_type: "text/plain",
          size_bytes: 0,
        },
        ctx
      );
      assert.notEqual(res.isError, true, JSON.stringify(res));
      const payload = parseResult(res) as { size_bytes: number; version: number };
      assert.equal(payload.size_bytes, 0);
      assert.equal(payload.version, 1);
    }
  );

  await check(
    "cdn_finalize_upload: validators fire before any I/O (no head() if validation fails)",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      // Seed bytes — if a validator slipped, head() would find them and we'd
      // get a different error than invalid_*.
      seedR2(store, "p/x.bin", SAMPLE_PNG, "application/octet-stream");

      const r1 = await cdn_finalize_upload.handler(
        {
          project: "with space",
          name: "x.bin",
          content_type: "application/octet-stream",
          size_bytes: 1,
        },
        ctx
      );
      assert.equal(r1.isError, true);
      assert.equal(
        (parseResult(r1) as { error: string }).error,
        "invalid_project"
      );

      const r2 = await cdn_finalize_upload.handler(
        {
          project: "p",
          name: "../escape.bin",
          content_type: "application/octet-stream",
          size_bytes: 1,
        },
        ctx
      );
      assert.equal(r2.isError, true);
      assert.equal(
        (parseResult(r2) as { error: string }).error,
        "invalid_name"
      );

      const r3 = await cdn_finalize_upload.handler(
        {
          project: "p",
          name: "x.bin",
          content_type: "",
          size_bytes: 1,
        },
        ctx
      );
      assert.equal(r3.isError, true);
      assert.equal(
        (parseResult(r3) as { error: string }).error,
        "invalid_content_type"
      );

      const r4 = await cdn_finalize_upload.handler(
        {
          project: "p",
          name: "x.bin",
          content_type: "application/octet-stream",
          size_bytes: -1,
        },
        ctx
      );
      assert.equal(r4.isError, true);
      assert.equal(
        (parseResult(r4) as { error: string }).error,
        "invalid_size_bytes"
      );

      // Non-integer size.
      const r5 = await cdn_finalize_upload.handler(
        {
          project: "p",
          name: "x.bin",
          content_type: "application/octet-stream",
          size_bytes: 12.5,
        },
        ctx
      );
      assert.equal(r5.isError, true);
      assert.equal(
        (parseResult(r5) as { error: string }).error,
        "invalid_size_bytes"
      );
    }
  );

  await check(
    "cdn_finalize_upload: INSERT failure does NOT delete R2 bytes (rollback off, idempotent retry works)",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      seedR2(
        store,
        "phase4-test/retry.bin",
        SAMPLE_PNG,
        "application/octet-stream"
      );

      // Poison the next INSERT.
      store.failNext = { kind: "insert_files", reason: "transient D1 error" };

      const r1 = await cdn_finalize_upload.handler(
        {
          project: "phase4-test",
          name: "retry.bin",
          content_type: "application/octet-stream",
          size_bytes: SAMPLE_PNG_LEN,
        },
        ctx
      );
      assert.equal(r1.isError, true);
      const payload = parseResult(r1) as { error: string; message: string };
      assert.equal(payload.error, "metadata_insert_failed");
      // Don't-rollback contract: the message DOES NOT say "Bytes have been
      // removed" — finalize never sweeps bytes it didn't put.
      assert.match(payload.message, /Bytes remain at the public URL/);
      assert.doesNotMatch(payload.message, /Bytes have been removed/);

      // R2 still has the bytes.
      assert.equal(store.r2.size, 1);
      assert.equal(store.r2.get("phase4-test/retry.bin")?.bytes.length, SAMPLE_PNG_LEN);
      // No file row was committed.
      assert.equal(store.files.length, 0);

      // Idempotent retry: a second finalize with identical args succeeds
      // because head() still finds the same bytes.
      const r2 = await cdn_finalize_upload.handler(
        {
          project: "phase4-test",
          name: "retry.bin",
          content_type: "application/octet-stream",
          size_bytes: SAMPLE_PNG_LEN,
        },
        ctx
      );
      assert.notEqual(r2.isError, true, JSON.stringify(r2));
      const okPayload = parseResult(r2) as { version: number };
      assert.equal(okPayload.version, 1);
      assert.equal(store.files.length, 1);
    }
  );

  await check(
    "cdn_finalize_upload: matches cdn_upload_file's response envelope shape (deepEqual on the keys)",
    async () => {
      // Phase 4 contract: finalize and upload are indistinguishable to the
      // connector once the bytes are in R2. Same keys, same value types.
      const storeA = new MockStore();
      const ctxA = makeCtx(storeA);
      const upload = await cdn_upload_file.handler(
        {
          project: "p",
          name: "u.png",
          content_base64: SAMPLE_PNG_B64,
        },
        ctxA
      );
      const uploadKeys = Object.keys(parseResult(upload) as object).sort();

      const storeB = new MockStore();
      const ctxB = makeCtx(storeB);
      seedR2(storeB, "p/u.png", SAMPLE_PNG, "image/png");
      const finalize = await cdn_finalize_upload.handler(
        {
          project: "p",
          name: "u.png",
          content_type: "image/png",
          size_bytes: SAMPLE_PNG_LEN,
        },
        ctxB
      );
      const finalizeKeys = Object.keys(parseResult(finalize) as object).sort();

      assert.deepEqual(finalizeKeys, uploadKeys);
    }
  );

  // ===================================================================
  // Phase 4.1 — Cache-Control on R2 PUT (edge-cache-staleness fix)
  // ===================================================================

  await check(
    "Phase 4.1: cdn_upload_file sets Cache-Control on R2 (Worker-side PUT path)",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      await cdn_upload_file.handler(
        { project: "p", name: "x.png", content_base64: SAMPLE_PNG_B64 },
        ctx
      );
      const r2 = store.r2.get("p/x.png");
      assert.ok(r2, "R2 must hold the bytes");
      assert.equal(r2.cacheControl, "public, max-age=60");
      assert.equal(r2.contentType, "image/png");
    }
  );

  // ===================================================================
  // Done
  // ===================================================================
  console.log("=====================");
  console.log(`  ${pass} pass / ${fail} fail`);
  if (fail > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("Unhandled error in phase 4 tests:", err);
  process.exit(1);
});
