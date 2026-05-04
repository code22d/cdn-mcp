// -----------------------------------------------------------------------------
// test/phase1.ts — Phase 1 synthetic tests.
//
// Two tiers:
//   1. Pure-helper assertions (validators, base64, MIME, cursor) — no mocks.
//   2. Handler assertions against in-memory mock D1 + mock R2.
//
// Phase 0's test/sanity.ts continues to pass; this file is additive. The
// `npm test` script runs both.
//
// Same minimal-tsx style as sanity.ts — node:assert/strict, no framework.
//
// Phase 2 update: the in-memory MockStore / MockD1 / MockR2 + helpers were
// extracted to ./_mock.ts so Phase 2+ test files can share them. This file's
// behavior is unchanged — only the imports moved.
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";

import {
  decodeBase64,
  decodeCursor,
  encodeCursor,
  inferContentType,
  validateFileName,
  validateProjectName,
} from "../src/mcp/util";

import { cdn_create_project } from "../src/mcp/tools/cdn_create_project";
import { cdn_upload_file } from "../src/mcp/tools/cdn_upload_file";
import { cdn_list_files } from "../src/mcp/tools/cdn_list_files";
import { cdn_list_projects } from "../src/mcp/tools/cdn_list_projects";

import {
  MockStore,
  makeCtx,
  parseResult,
  SAMPLE_PNG_B64,
  SAMPLE_PNG_LEN,
} from "./_mock";

// -----------------------------------------------------------------------------
// Test runner
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
  console.log("cdn-mcp Phase 1 tests");
  console.log("=====================");

  // ===================================================================
  // Tier 1: pure helpers
  // ===================================================================

  await check("validateProjectName: valid names", () => {
    assert.equal(validateProjectName("blog"), null);
    assert.equal(validateProjectName("phase1-test"), null);
    assert.equal(validateProjectName("a_b-C-9"), null);
    assert.equal(validateProjectName("X"), null);
    assert.equal(validateProjectName("a".repeat(64)), null);
  });

  await check("validateProjectName: invalid names", () => {
    assert.ok(validateProjectName("") !== null);
    assert.ok(validateProjectName("a".repeat(65)) !== null);
    assert.ok(validateProjectName("with space") !== null);
    assert.ok(validateProjectName("with.dot") !== null);
    assert.ok(validateProjectName("with/slash") !== null);
    assert.ok(validateProjectName("emoji🚀") !== null);
    assert.ok(validateProjectName(123) !== null);
    assert.ok(validateProjectName(null) !== null);
    assert.ok(validateProjectName(undefined) !== null);
  });

  await check("validateFileName: valid names (incl. internal slashes)", () => {
    assert.equal(validateFileName("hero.png"), null);
    assert.equal(validateFileName("subdir/hero.png"), null);
    assert.equal(validateFileName("a/b/c/d.html"), null);
    assert.equal(validateFileName("file-with-dashes_and_underscores.mp4"), null);
    assert.equal(validateFileName("a".repeat(256)), null);
  });

  await check("validateFileName: rejects bad inputs (A5)", () => {
    assert.ok(validateFileName("") !== null);
    assert.ok(validateFileName("a".repeat(257)) !== null);
    assert.ok(validateFileName("/leading-slash.png") !== null);
    assert.ok(validateFileName(".hidden") !== null);
    assert.ok(validateFileName("../escape.png") !== null);
    assert.ok(validateFileName("dir/../escape.png") !== null);
    assert.ok(validateFileName("dir//double.png") !== null);
    assert.ok(validateFileName("dir\\back.png") !== null);
    assert.ok(validateFileName("nul\0byte.png") !== null);
    assert.ok(validateFileName(42) !== null);
  });

  await check("decodeBase64: round-trips the sample PNG (68 bytes)", () => {
    const bytes = decodeBase64(SAMPLE_PNG_B64);
    assert.equal(bytes.length, SAMPLE_PNG_LEN, "decoded length must be 68");
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A
    assert.equal(bytes[0], 0x89);
    assert.equal(bytes[1], 0x50);
    assert.equal(bytes[2], 0x4e);
    assert.equal(bytes[3], 0x47);
  });

  await check("decodeBase64: rejects malformed input", () => {
    assert.throws(() => decodeBase64("not!base64!"));
    assert.throws(() => decodeBase64("AAAA AAAA")); // whitespace
    assert.throws(() => decodeBase64("AAA")); // length not multiple of 4
    assert.throws(() => decodeBase64(123 as unknown as string));
  });

  await check("inferContentType: known + fallback", () => {
    assert.equal(inferContentType("hero.png"), "image/png");
    assert.equal(inferContentType("clip.MP4"), "video/mp4");
    assert.equal(inferContentType("page.html"), "text/html");
    assert.equal(inferContentType("style.css"), "text/css");
    assert.equal(inferContentType("data.json"), "application/json");
    assert.equal(inferContentType("photo.jpeg"), "image/jpeg");
    assert.equal(inferContentType("photo.JPG"), "image/jpeg");
    assert.equal(inferContentType("img.svg"), "image/svg+xml");
    assert.equal(inferContentType("doc.pdf"), "application/pdf");
    assert.equal(inferContentType("noext"), "application/octet-stream");
    assert.equal(inferContentType("trailing."), "application/octet-stream");
    assert.equal(inferContentType("dir/sub.png"), "image/png");
  });

  await check("encode/decodeCursor: round-trip and tamper rejection", () => {
    const original = { uploaded_at: "2026-05-01T00:00:00.000Z", id: "abc" };
    const cur = encodeCursor(original);
    const back = decodeCursor<typeof original>(cur);
    assert.deepEqual(back, original);
    assert.equal(decodeCursor("not-base64-???"), null);
    assert.equal(decodeCursor(""), null);
    assert.equal(decodeCursor(undefined), null);
  });

  // ===================================================================
  // Tier 2: handlers against mock D1 + R2
  // ===================================================================

  // ---- cdn_create_project ----
  await check("cdn_create_project: success returns name + description + created_at", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    const res = await cdn_create_project.handler(
      { name: "blog", description: "long-form posts" },
      ctx
    );
    assert.notEqual(res.isError, true);
    const payload = parseResult(res) as {
      name: string;
      description: string;
      created_at: string;
    };
    assert.equal(payload.name, "blog");
    assert.equal(payload.description, "long-form posts");
    assert.match(payload.created_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(store.projects.length, 1);
    assert.equal(store.projects[0]!.name, "blog");
  });

  await check("cdn_create_project: duplicate → error project_exists", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    await cdn_create_project.handler({ name: "blog" }, ctx);
    const res = await cdn_create_project.handler({ name: "blog" }, ctx);
    assert.equal(res.isError, true);
    const p = parseResult(res) as { error: string };
    assert.equal(p.error, "project_exists");
  });

  await check("cdn_create_project: invalid name → error invalid_name", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    const res = await cdn_create_project.handler({ name: "with space" }, ctx);
    assert.equal(res.isError, true);
    const p = parseResult(res) as { error: string };
    assert.equal(p.error, "invalid_name");
    assert.equal(store.projects.length, 0);
  });

  // ---- cdn_upload_file ----
  await check("cdn_upload_file: new upload inserts file + auto-creates project", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    const res = await cdn_upload_file.handler(
      {
        project: "phase1-test",
        name: "sample.png",
        content_base64: SAMPLE_PNG_B64,
      },
      ctx
    );
    assert.notEqual(res.isError, true, JSON.stringify(res));
    const payload = parseResult(res) as {
      url: string;
      size_bytes: number;
      content_type: string;
      version: number;
      last_replaced_at: string | null;
    };
    assert.equal(payload.url, "https://cdn.22d.app/phase1-test/sample.png");
    assert.equal(payload.size_bytes, SAMPLE_PNG_LEN);
    assert.equal(payload.content_type, "image/png"); // inferred
    assert.equal(payload.version, 1);
    assert.equal(payload.last_replaced_at, null);

    // Project auto-created
    assert.equal(store.projects.length, 1);
    assert.equal(store.projects[0]!.name, "phase1-test");

    // File row + R2 object
    assert.equal(store.files.length, 1);
    assert.equal(store.files[0]!.size_bytes, SAMPLE_PNG_LEN);
    assert.equal(store.r2.size, 1);
    const r2Obj = store.r2.get("phase1-test/sample.png");
    assert.ok(r2Obj);
    assert.equal(r2Obj.bytes.length, SAMPLE_PNG_LEN);
    assert.equal(r2Obj.contentType, "image/png");
  });

  await check("cdn_upload_file: duplicate without replace → file_exists, no R2 write", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    await cdn_upload_file.handler(
      {
        project: "p",
        name: "f.png",
        content_base64: SAMPLE_PNG_B64,
      },
      ctx
    );
    const res = await cdn_upload_file.handler(
      {
        project: "p",
        name: "f.png",
        content_base64: SAMPLE_PNG_B64,
      },
      ctx
    );
    assert.equal(res.isError, true);
    const payload = parseResult(res) as { error: string };
    assert.equal(payload.error, "file_exists");
    // Only one R2 object, version still 1
    assert.equal(store.r2.size, 1);
    assert.equal(store.files[0]!.version, 1);
  });

  await check("cdn_upload_file: replace=true bumps version + sets last_replaced_at", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    await cdn_upload_file.handler(
      {
        project: "p",
        name: "f.png",
        content_base64: SAMPLE_PNG_B64,
      },
      ctx
    );
    // Different bytes (the trailing ZQ== makes this 1 byte: 0x65)
    const res = await cdn_upload_file.handler(
      {
        project: "p",
        name: "f.png",
        content_base64: "ZQ==",
        replace: true,
        content_type: "application/octet-stream",
      },
      ctx
    );
    assert.notEqual(res.isError, true, JSON.stringify(res));
    const payload = parseResult(res) as {
      version: number;
      last_replaced_at: string | null;
      size_bytes: number;
      url: string;
    };
    assert.equal(payload.version, 2);
    assert.ok(payload.last_replaced_at !== null);
    assert.equal(payload.size_bytes, 1);
    // URL unchanged
    assert.equal(payload.url, "https://cdn.22d.app/p/f.png");
    // File row updated, R2 contents replaced
    assert.equal(store.files.length, 1);
    assert.equal(store.files[0]!.version, 2);
    assert.equal(store.r2.get("p/f.png")?.bytes.length, 1);
  });

  await check("cdn_upload_file: invalid base64 → invalid_base64, no D1/R2 write", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    const res = await cdn_upload_file.handler(
      {
        project: "p",
        name: "f.png",
        content_base64: "not!valid!",
      },
      ctx
    );
    assert.equal(res.isError, true);
    const p = parseResult(res) as { error: string };
    assert.equal(p.error, "invalid_base64");
    assert.equal(store.projects.length, 0);
    assert.equal(store.files.length, 0);
    assert.equal(store.r2.size, 0);
  });

  await check("cdn_upload_file: invalid project + filename validators fire before any I/O", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);

    const bad1 = await cdn_upload_file.handler(
      {
        project: "with space",
        name: "f.png",
        content_base64: SAMPLE_PNG_B64,
      },
      ctx
    );
    assert.equal(bad1.isError, true);
    assert.equal((parseResult(bad1) as { error: string }).error, "invalid_project");

    const bad2 = await cdn_upload_file.handler(
      {
        project: "p",
        name: "../escape.png",
        content_base64: SAMPLE_PNG_B64,
      },
      ctx
    );
    assert.equal(bad2.isError, true);
    assert.equal((parseResult(bad2) as { error: string }).error, "invalid_name");

    assert.equal(store.r2.size, 0);
    assert.equal(store.files.length, 0);
  });

  await check("cdn_upload_file: explicit content_type overrides extension inference", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    const res = await cdn_upload_file.handler(
      {
        project: "p",
        name: "weird.png",
        content_base64: SAMPLE_PNG_B64,
        content_type: "application/x-custom",
      },
      ctx
    );
    assert.notEqual(res.isError, true);
    const payload = parseResult(res) as { content_type: string };
    assert.equal(payload.content_type, "application/x-custom");
    assert.equal(store.r2.get("p/weird.png")?.contentType, "application/x-custom");
  });

  await check("cdn_upload_file: D1 INSERT failure rolls back R2 (best-effort)", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    store.failNext = { kind: "insert_files", reason: "boom" };
    const res = await cdn_upload_file.handler(
      {
        project: "p",
        name: "f.png",
        content_base64: SAMPLE_PNG_B64,
      },
      ctx
    );
    assert.equal(res.isError, true);
    const payload = parseResult(res) as { error: string; detail?: string };
    assert.equal(payload.error, "metadata_insert_failed");
    assert.match(String(payload.detail), /boom/);
    // R2 was rolled back
    assert.equal(store.r2.size, 0);
    assert.equal(store.files.length, 0);
  });

  await check("cdn_upload_file: D1 UPDATE failure leaves bytes + returns metadata_update_failed", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    // First a successful upload
    await cdn_upload_file.handler(
      {
        project: "p",
        name: "f.png",
        content_base64: SAMPLE_PNG_B64,
      },
      ctx
    );
    const initialVersion = store.files[0]!.version;
    // Now break the UPDATE for the replace
    store.failNext = { kind: "update_files", reason: "kaboom" };
    const res = await cdn_upload_file.handler(
      {
        project: "p",
        name: "f.png",
        content_base64: "ZQ==",
        replace: true,
      },
      ctx
    );
    assert.equal(res.isError, true);
    const payload = parseResult(res) as { error: string; message: string };
    assert.equal(payload.error, "metadata_update_failed");
    assert.match(payload.message, /Bytes were updated at/);
    // Bytes were replaced (asymmetric per A6) but row version did NOT bump
    assert.equal(store.r2.get("p/f.png")?.bytes.length, 1);
    assert.equal(store.files[0]!.version, initialVersion);
  });

  // ---- cdn_list_files ----
  await check("cdn_list_files: empty store returns empty list + null cursor", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    const res = await cdn_list_files.handler({}, ctx);
    assert.notEqual(res.isError, true);
    const payload = parseResult(res) as {
      files: unknown[];
      next_cursor: string | null;
    };
    assert.deepEqual(payload.files, []);
    assert.equal(payload.next_cursor, null);
  });

  await check("cdn_list_files: returns uploaded files in newest-first order", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    // Three files with controlled timestamps via direct push (bypassing handler)
    store.projects.push({ name: "p", description: null, created_at: "2026-05-01T00:00:00.000Z" });
    store.files.push(
      { id: "id-a", project: "p", name: "a.png", r2_key: "p/a.png", content_type: "image/png", size_bytes: 10, public_url: "https://cdn.22d.app/p/a.png", uploaded_at: "2026-05-01T00:00:00.000Z", last_replaced_at: null, version: 1 },
      { id: "id-b", project: "p", name: "b.png", r2_key: "p/b.png", content_type: "image/png", size_bytes: 20, public_url: "https://cdn.22d.app/p/b.png", uploaded_at: "2026-05-01T00:00:01.000Z", last_replaced_at: null, version: 1 },
      { id: "id-c", project: "p", name: "c.png", r2_key: "p/c.png", content_type: "image/png", size_bytes: 30, public_url: "https://cdn.22d.app/p/c.png", uploaded_at: "2026-05-01T00:00:02.000Z", last_replaced_at: null, version: 1 }
    );
    const res = await cdn_list_files.handler({}, ctx);
    const payload = parseResult(res) as {
      files: Array<{ name: string; size_bytes: number }>;
      next_cursor: string | null;
    };
    assert.equal(payload.files.length, 3);
    assert.equal(payload.files[0]!.name, "c.png"); // newest first
    assert.equal(payload.files[1]!.name, "b.png");
    assert.equal(payload.files[2]!.name, "a.png");
    assert.equal(payload.next_cursor, null);
  });

  await check("cdn_list_files: project filter + cursor pagination", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    store.projects.push(
      { name: "p1", description: null, created_at: "2026-05-01T00:00:00.000Z" },
      { name: "p2", description: null, created_at: "2026-05-01T00:00:00.000Z" }
    );
    for (let i = 0; i < 5; i++) {
      const ts = `2026-05-01T00:00:0${i}.000Z`;
      store.files.push({
        id: `p1-${i}`,
        project: "p1",
        name: `f${i}.png`,
        r2_key: `p1/f${i}.png`,
        content_type: "image/png",
        size_bytes: 10,
        public_url: `https://cdn.22d.app/p1/f${i}.png`,
        uploaded_at: ts,
        last_replaced_at: null,
        version: 1,
      });
      store.files.push({
        id: `p2-${i}`,
        project: "p2",
        name: `g${i}.png`,
        r2_key: `p2/g${i}.png`,
        content_type: "image/png",
        size_bytes: 20,
        public_url: `https://cdn.22d.app/p2/g${i}.png`,
        uploaded_at: ts,
        last_replaced_at: null,
        version: 1,
      });
    }
    // Filter to p1, page size 2
    const r1 = await cdn_list_files.handler({ project: "p1", limit: 2 }, ctx);
    const p1 = parseResult(r1) as {
      files: Array<{ name: string; project: string }>;
      next_cursor: string | null;
    };
    assert.equal(p1.files.length, 2);
    assert.equal(p1.files[0]!.project, "p1");
    assert.equal(p1.files[1]!.project, "p1");
    assert.equal(p1.files[0]!.name, "f4.png"); // newest in p1
    assert.equal(p1.files[1]!.name, "f3.png");
    assert.ok(p1.next_cursor !== null);

    // Page 2
    const r2 = await cdn_list_files.handler(
      { project: "p1", limit: 2, cursor: p1.next_cursor },
      ctx
    );
    const p2 = parseResult(r2) as {
      files: Array<{ name: string }>;
      next_cursor: string | null;
    };
    assert.equal(p2.files.length, 2);
    assert.equal(p2.files[0]!.name, "f2.png");
    assert.equal(p2.files[1]!.name, "f1.png");
    assert.ok(p2.next_cursor !== null);

    // Page 3 — final, no next cursor
    const r3 = await cdn_list_files.handler(
      { project: "p1", limit: 2, cursor: p2.next_cursor },
      ctx
    );
    const p3 = parseResult(r3) as {
      files: Array<{ name: string }>;
      next_cursor: string | null;
    };
    assert.equal(p3.files.length, 1);
    assert.equal(p3.files[0]!.name, "f0.png");
    assert.equal(p3.next_cursor, null);
  });

  await check("cdn_list_files: invalid limit / cursor / project all error cleanly", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    const r1 = await cdn_list_files.handler({ limit: 0 }, ctx);
    assert.equal((parseResult(r1) as { error: string }).error, "invalid_limit");
    const r2 = await cdn_list_files.handler({ limit: 1001 }, ctx);
    assert.equal((parseResult(r2) as { error: string }).error, "invalid_limit");
    const r3 = await cdn_list_files.handler({ cursor: "###" }, ctx);
    assert.equal((parseResult(r3) as { error: string }).error, "invalid_cursor");
    const r4 = await cdn_list_files.handler({ project: "with space" }, ctx);
    assert.equal((parseResult(r4) as { error: string }).error, "invalid_project");
  });

  // ---- cdn_list_projects ----
  await check("cdn_list_projects: aggregates count + size, includes empty projects", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    // Two projects, only one has files
    await cdn_create_project.handler({ name: "empty-proj" }, ctx);
    await cdn_upload_file.handler(
      { project: "active-proj", name: "a.png", content_base64: SAMPLE_PNG_B64 },
      ctx
    );
    await cdn_upload_file.handler(
      { project: "active-proj", name: "b.png", content_base64: SAMPLE_PNG_B64 },
      ctx
    );

    const res = await cdn_list_projects.handler({}, ctx);
    const payload = parseResult(res) as {
      projects: Array<{
        name: string;
        file_count: number;
        total_size_bytes: number;
      }>;
      next_cursor: string | null;
    };
    assert.equal(payload.projects.length, 2);
    // Sorted alphabetically: active-proj, empty-proj
    assert.equal(payload.projects[0]!.name, "active-proj");
    assert.equal(payload.projects[0]!.file_count, 2);
    assert.equal(payload.projects[0]!.total_size_bytes, SAMPLE_PNG_LEN * 2);
    assert.equal(payload.projects[1]!.name, "empty-proj");
    assert.equal(payload.projects[1]!.file_count, 0);
    assert.equal(payload.projects[1]!.total_size_bytes, 0);
    assert.equal(payload.next_cursor, null);
  });

  await check("cdn_list_projects: cursor pagination by name", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    for (const n of ["a", "b", "c", "d", "e"]) {
      await cdn_create_project.handler({ name: n }, ctx);
    }
    const r1 = await cdn_list_projects.handler({ limit: 2 }, ctx);
    const p1 = parseResult(r1) as {
      projects: Array<{ name: string }>;
      next_cursor: string | null;
    };
    assert.deepEqual(
      p1.projects.map((p) => p.name),
      ["a", "b"]
    );
    assert.ok(p1.next_cursor !== null);

    const r2 = await cdn_list_projects.handler(
      { limit: 2, cursor: p1.next_cursor },
      ctx
    );
    const p2 = parseResult(r2) as {
      projects: Array<{ name: string }>;
      next_cursor: string | null;
    };
    assert.deepEqual(
      p2.projects.map((p) => p.name),
      ["c", "d"]
    );
    assert.ok(p2.next_cursor !== null);

    const r3 = await cdn_list_projects.handler(
      { limit: 2, cursor: p2.next_cursor },
      ctx
    );
    const p3 = parseResult(r3) as {
      projects: Array<{ name: string }>;
      next_cursor: string | null;
    };
    assert.deepEqual(
      p3.projects.map((p) => p.name),
      ["e"]
    );
    assert.equal(p3.next_cursor, null);
  });

  await check("cdn_list_projects: invalid limit / cursor error cleanly", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    const r1 = await cdn_list_projects.handler({ limit: 0 }, ctx);
    assert.equal((parseResult(r1) as { error: string }).error, "invalid_limit");
    const r2 = await cdn_list_projects.handler({ cursor: "###" }, ctx);
    assert.equal((parseResult(r2) as { error: string }).error, "invalid_cursor");
  });

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
  console.error("Unhandled error in phase 1 tests:", err);
  process.exit(1);
});
