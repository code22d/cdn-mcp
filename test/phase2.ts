// -----------------------------------------------------------------------------
// test/phase2.ts — Phase 2 synthetic tests.
//
// Asserts the new behaviors layered on top of the Phase 1 substrate:
//   - cdn_replace_file: file_not_found on missing row, success bumps version,
//     content_type inference matches cdn_upload_file (Phase 2 A2),
//     metadata_update_failed is asymmetric (bytes stay; row unchanged).
//   - cdn_delete_file: file_not_found on missing row, happy path removes both
//     R2 and D1, project row preserved post-delete (file_count → 0),
//     idempotent retry works after R2 is already gone, metadata_delete_failed
//     leaves the R2 object gone but the row in place.
//   - Validators fire before any I/O.
//
// Mocks live in ./_mock.ts (extracted from phase1.ts during Phase 2). Style
// matches sanity.ts and phase1.ts — node:assert/strict, no framework.
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";

import { cdn_create_project } from "../src/mcp/tools/cdn_create_project";
import { cdn_upload_file } from "../src/mcp/tools/cdn_upload_file";
import { cdn_list_files } from "../src/mcp/tools/cdn_list_files";
import { cdn_list_projects } from "../src/mcp/tools/cdn_list_projects";
import { cdn_replace_file } from "../src/mcp/tools/cdn_replace_file";
import { cdn_delete_file } from "../src/mcp/tools/cdn_delete_file";

import {
  MockStore,
  makeCtx,
  parseResult,
  SAMPLE_PNG_B64,
  SAMPLE_PNG_LEN,
  SAMPLE_PNG_2_B64,
  SAMPLE_PNG_2_LEN,
} from "./_mock";

// -----------------------------------------------------------------------------
// Test runner — same shape as sanity.ts / phase1.ts so output stays uniform.
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

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

async function main() {
  console.log("cdn-mcp Phase 2 tests");
  console.log("=====================");

  // ===================================================================
  // cdn_replace_file
  // ===================================================================

  await check(
    "cdn_replace_file: file_not_found when row does not exist (no R2 write)",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      const res = await cdn_replace_file.handler(
        {
          project: "p",
          name: "missing.png",
          content_base64: SAMPLE_PNG_2_B64,
        },
        ctx
      );
      assert.equal(res.isError, true);
      const payload = parseResult(res) as { error: string; message: string };
      assert.equal(payload.error, "file_not_found");
      assert.match(payload.message, /p\/missing\.png/);
      // Crucially, the existence check must fire BEFORE any I/O — no R2
      // bytes, no project auto-create, no file row.
      assert.equal(store.r2.size, 0);
      assert.equal(store.projects.length, 0);
      assert.equal(store.files.length, 0);
    }
  );

  await check(
    "cdn_replace_file: success bumps version and sets last_replaced_at, URL preserved",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      // Seed via upload (version 1).
      await cdn_upload_file.handler(
        { project: "p", name: "hero.png", content_base64: SAMPLE_PNG_B64 },
        ctx
      );
      assert.equal(store.files[0]!.version, 1);

      const res = await cdn_replace_file.handler(
        { project: "p", name: "hero.png", content_base64: SAMPLE_PNG_2_B64 },
        ctx
      );
      assert.notEqual(res.isError, true, JSON.stringify(res));
      const payload = parseResult(res) as {
        url: string;
        version: number;
        size_bytes: number;
        last_replaced_at: string | null;
        uploaded_at: string;
        content_type: string;
      };
      assert.equal(payload.url, "https://cdn.22d.app/p/hero.png");
      assert.equal(payload.version, 2);
      assert.equal(payload.size_bytes, SAMPLE_PNG_2_LEN);
      assert.ok(payload.last_replaced_at !== null);
      // uploaded_at preserved across replace, only last_replaced_at moves.
      assert.equal(payload.uploaded_at, store.files[0]!.uploaded_at);
      // content_type inferred from extension (Phase 2 A2).
      assert.equal(payload.content_type, "image/png");

      // Row + R2 reflect the new bytes.
      assert.equal(store.files.length, 1);
      assert.equal(store.files[0]!.version, 2);
      assert.equal(store.files[0]!.size_bytes, SAMPLE_PNG_2_LEN);
      assert.equal(store.r2.size, 1);
      assert.equal(store.r2.get("p/hero.png")?.bytes.length, SAMPLE_PNG_2_LEN);
    }
  );

  await check(
    "cdn_replace_file: content_type inference matches upload (omit → image/png from .png)",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      // Seed with an explicit content_type that differs from the extension.
      await cdn_upload_file.handler(
        {
          project: "p",
          name: "hero.png",
          content_base64: SAMPLE_PNG_B64,
          content_type: "application/x-original",
        },
        ctx
      );
      assert.equal(store.files[0]!.content_type, "application/x-original");

      // Replace WITHOUT specifying content_type. Phase 2 A2: this should
      // infer from the extension (image/png), NOT preserve the existing
      // application/x-original. This is the documented divergence from the
      // Phase 0 stub description.
      const res = await cdn_replace_file.handler(
        { project: "p", name: "hero.png", content_base64: SAMPLE_PNG_2_B64 },
        ctx
      );
      assert.notEqual(res.isError, true, JSON.stringify(res));
      const payload = parseResult(res) as { content_type: string };
      assert.equal(payload.content_type, "image/png");
      assert.equal(store.files[0]!.content_type, "image/png");
      assert.equal(store.r2.get("p/hero.png")?.contentType, "image/png");
    }
  );

  await check(
    "cdn_replace_file: explicit content_type overrides inference",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      await cdn_upload_file.handler(
        { project: "p", name: "hero.png", content_base64: SAMPLE_PNG_B64 },
        ctx
      );
      const res = await cdn_replace_file.handler(
        {
          project: "p",
          name: "hero.png",
          content_base64: SAMPLE_PNG_2_B64,
          content_type: "application/x-explicit",
        },
        ctx
      );
      assert.notEqual(res.isError, true, JSON.stringify(res));
      const payload = parseResult(res) as { content_type: string };
      assert.equal(payload.content_type, "application/x-explicit");
      assert.equal(store.r2.get("p/hero.png")?.contentType, "application/x-explicit");
    }
  );

  await check(
    "cdn_replace_file: invalid project / filename validators fire before any I/O",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      // Seed a real row so we know it's the validators (not file_not_found)
      // doing the rejection.
      await cdn_upload_file.handler(
        { project: "p", name: "hero.png", content_base64: SAMPLE_PNG_B64 },
        ctx
      );
      const r1 = await cdn_replace_file.handler(
        {
          project: "with space",
          name: "hero.png",
          content_base64: SAMPLE_PNG_2_B64,
        },
        ctx
      );
      assert.equal(r1.isError, true);
      assert.equal((parseResult(r1) as { error: string }).error, "invalid_project");

      const r2 = await cdn_replace_file.handler(
        {
          project: "p",
          name: "../escape.png",
          content_base64: SAMPLE_PNG_2_B64,
        },
        ctx
      );
      assert.equal(r2.isError, true);
      assert.equal((parseResult(r2) as { error: string }).error, "invalid_name");

      // The existing row + bytes are untouched (still version 1, still 68 B).
      assert.equal(store.files[0]!.version, 1);
      assert.equal(store.files[0]!.size_bytes, SAMPLE_PNG_LEN);
      assert.equal(store.r2.get("p/hero.png")?.bytes.length, SAMPLE_PNG_LEN);
    }
  );

  await check(
    "cdn_replace_file: invalid base64 → invalid_base64, no R2 write",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      await cdn_upload_file.handler(
        { project: "p", name: "hero.png", content_base64: SAMPLE_PNG_B64 },
        ctx
      );
      const res = await cdn_replace_file.handler(
        { project: "p", name: "hero.png", content_base64: "not!base64!" },
        ctx
      );
      assert.equal(res.isError, true);
      assert.equal(
        (parseResult(res) as { error: string }).error,
        "invalid_base64"
      );
      // Row + R2 still hold the original bytes.
      assert.equal(store.files[0]!.version, 1);
      assert.equal(store.r2.get("p/hero.png")?.bytes.length, SAMPLE_PNG_LEN);
    }
  );

  await check(
    "cdn_replace_file: D1 UPDATE failure → metadata_update_failed, bytes left in place (A6 carries)",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      await cdn_upload_file.handler(
        { project: "p", name: "hero.png", content_base64: SAMPLE_PNG_B64 },
        ctx
      );
      const initialVersion = store.files[0]!.version;

      store.failNext = { kind: "update_files", reason: "kaboom" };
      const res = await cdn_replace_file.handler(
        { project: "p", name: "hero.png", content_base64: SAMPLE_PNG_2_B64 },
        ctx
      );
      assert.equal(res.isError, true);
      const payload = parseResult(res) as { error: string; message: string };
      assert.equal(payload.error, "metadata_update_failed");
      assert.match(payload.message, /Bytes were updated at/);
      // New bytes are at R2 (asymmetric per A6).
      assert.equal(store.r2.get("p/hero.png")?.bytes.length, SAMPLE_PNG_2_LEN);
      // Row version did NOT bump.
      assert.equal(store.files[0]!.version, initialVersion);
    }
  );

  // ===================================================================
  // cdn_delete_file
  // ===================================================================

  await check(
    "cdn_delete_file: file_not_found when row does not exist (no R2 delete)",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      // Pre-populate a file at a different (project, name) so we can verify
      // the not-found path doesn't sweep up the wrong object.
      await cdn_upload_file.handler(
        { project: "other", name: "f.png", content_base64: SAMPLE_PNG_B64 },
        ctx
      );

      const res = await cdn_delete_file.handler(
        { project: "p", name: "missing.png" },
        ctx
      );
      assert.equal(res.isError, true);
      assert.equal(
        (parseResult(res) as { error: string }).error,
        "file_not_found"
      );
      // The existing file + R2 object are untouched.
      assert.equal(store.files.length, 1);
      assert.equal(store.r2.size, 1);
    }
  );

  await check(
    "cdn_delete_file: happy path removes R2 + D1 row, preserves project (file_count → 0)",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      await cdn_create_project.handler(
        { name: "phase1-test", description: "kept across delete" },
        ctx
      );
      await cdn_upload_file.handler(
        {
          project: "phase1-test",
          name: "sample.png",
          content_base64: SAMPLE_PNG_B64,
        },
        ctx
      );

      const res = await cdn_delete_file.handler(
        { project: "phase1-test", name: "sample.png" },
        ctx
      );
      assert.notEqual(res.isError, true, JSON.stringify(res));
      const payload = parseResult(res) as {
        project: string;
        name: string;
        deleted_at: string;
      };
      assert.equal(payload.project, "phase1-test");
      assert.equal(payload.name, "sample.png");
      assert.match(payload.deleted_at, /^\d{4}-\d{2}-\d{2}T/);

      // Both layers gone.
      assert.equal(store.r2.size, 0);
      assert.equal(store.files.length, 0);

      // Project row stays (intentional — see handler header comment).
      assert.equal(store.projects.length, 1);
      assert.equal(store.projects[0]!.name, "phase1-test");

      // cdn_list_files for that project is now empty.
      const listFiles = await cdn_list_files.handler(
        { project: "phase1-test" },
        ctx
      );
      const listFilesPayload = parseResult(listFiles) as {
        files: unknown[];
        next_cursor: string | null;
      };
      assert.deepEqual(listFilesPayload.files, []);
      assert.equal(listFilesPayload.next_cursor, null);

      // cdn_list_projects shows the project with file_count: 0, total_size_bytes: 0.
      const listProjects = await cdn_list_projects.handler({}, ctx);
      const listProjectsPayload = parseResult(listProjects) as {
        projects: Array<{
          name: string;
          file_count: number;
          total_size_bytes: number;
        }>;
      };
      const proj = listProjectsPayload.projects.find(
        (p) => p.name === "phase1-test"
      );
      assert.ok(proj, "phase1-test should still appear after delete");
      assert.equal(proj.file_count, 0);
      assert.equal(proj.total_size_bytes, 0);
    }
  );

  await check(
    "cdn_delete_file: idempotent retry — after R2 already gone, second call still cleans up D1",
    async () => {
      // Simulate the failure mode: R2 succeeded on the first call, but D1
      // failed. A retry of cdn_delete_file should still complete cleanly,
      // leaving zero rows and zero objects.
      const store = new MockStore();
      const ctx = makeCtx(store);
      await cdn_upload_file.handler(
        { project: "p", name: "x.png", content_base64: SAMPLE_PNG_B64 },
        ctx
      );

      // First call: poison the D1 DELETE.
      store.failNext = { kind: "delete_files", reason: "transient" };
      const r1 = await cdn_delete_file.handler(
        { project: "p", name: "x.png" },
        ctx
      );
      assert.equal(r1.isError, true);
      assert.equal(
        (parseResult(r1) as { error: string }).error,
        "metadata_delete_failed"
      );
      // R2 is gone (delete ran first), but D1 row is still there.
      assert.equal(store.r2.size, 0);
      assert.equal(store.files.length, 1);

      // Retry. R2 delete should be a no-op on the missing key (idempotent),
      // D1 delete should now succeed.
      const r2 = await cdn_delete_file.handler(
        { project: "p", name: "x.png" },
        ctx
      );
      assert.notEqual(r2.isError, true, JSON.stringify(r2));
      const payload = parseResult(r2) as { project: string; name: string };
      assert.equal(payload.project, "p");
      assert.equal(payload.name, "x.png");
      assert.equal(store.r2.size, 0);
      assert.equal(store.files.length, 0);
    }
  );

  await check(
    "cdn_delete_file: invalid project / filename validators fire before any I/O",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      await cdn_upload_file.handler(
        { project: "p", name: "x.png", content_base64: SAMPLE_PNG_B64 },
        ctx
      );

      const r1 = await cdn_delete_file.handler(
        { project: "with space", name: "x.png" },
        ctx
      );
      assert.equal(r1.isError, true);
      assert.equal((parseResult(r1) as { error: string }).error, "invalid_project");

      const r2 = await cdn_delete_file.handler(
        { project: "p", name: "../escape.png" },
        ctx
      );
      assert.equal(r2.isError, true);
      assert.equal((parseResult(r2) as { error: string }).error, "invalid_name");

      // Nothing got deleted.
      assert.equal(store.r2.size, 1);
      assert.equal(store.files.length, 1);
    }
  );

  await check(
    "cdn_delete_file: missing args fail validation cleanly",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      const r1 = await cdn_delete_file.handler({}, ctx);
      assert.equal(r1.isError, true);
      assert.equal(
        (parseResult(r1) as { error: string }).error,
        "invalid_project"
      );
      const r2 = await cdn_delete_file.handler({ project: "p" }, ctx);
      assert.equal(r2.isError, true);
      assert.equal((parseResult(r2) as { error: string }).error, "invalid_name");
    }
  );

  // ===================================================================
  // Round-trip: upload → replace → delete (covers the live test sequence)
  // ===================================================================

  await check(
    "round-trip: upload → replace → delete leaves R2 and files empty, project preserved",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);

      // Upload — version 1.
      const upload = await cdn_upload_file.handler(
        {
          project: "phase2-test",
          name: "sample.png",
          content_base64: SAMPLE_PNG_B64,
        },
        ctx
      );
      assert.notEqual(upload.isError, true);
      assert.equal((parseResult(upload) as { version: number }).version, 1);

      // Replace — version 2, new bytes, same URL.
      const replace = await cdn_replace_file.handler(
        {
          project: "phase2-test",
          name: "sample.png",
          content_base64: SAMPLE_PNG_2_B64,
        },
        ctx
      );
      assert.notEqual(replace.isError, true);
      const replacePayload = parseResult(replace) as {
        version: number;
        url: string;
        size_bytes: number;
      };
      assert.equal(replacePayload.version, 2);
      assert.equal(replacePayload.url, "https://cdn.22d.app/phase2-test/sample.png");
      assert.equal(replacePayload.size_bytes, SAMPLE_PNG_2_LEN);

      // Delete — both layers gone.
      const del = await cdn_delete_file.handler(
        { project: "phase2-test", name: "sample.png" },
        ctx
      );
      assert.notEqual(del.isError, true);

      assert.equal(store.r2.size, 0);
      assert.equal(store.files.length, 0);
      // Project row preserved.
      assert.equal(store.projects.length, 1);
      assert.equal(store.projects[0]!.name, "phase2-test");
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
  console.error("Unhandled error in phase 2 tests:", err);
  process.exit(1);
});
