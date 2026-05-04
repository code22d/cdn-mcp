// -----------------------------------------------------------------------------
// test/phase3.ts — Phase 3 synthetic tests.
//
// Asserts the new behaviors layered on top of the Phase 1+2 substrate:
//   - cdn_get_file: happy path returns the SAME per-file shape that
//     cdn_list_files emits (verbatim deepEqual against a list entry).
//     Permissive: missing project and missing file both surface as
//     file_not_found (Phase 3 A2). Validators fire before any I/O.
//     Read-after-replace shows the bumped version + last_replaced_at.
//   - cdn_get_stats Mode A (global): empty bucket → all zeros + projects
//     []; with files across multiple projects → totals + sorted breakdown,
//     project_count derived from files (Phase 3 A1) so it always equals
//     projects.length. Empty project rows do NOT count or appear.
//   - cdn_get_stats Mode B (scoped): existing-with-files → real totals;
//     existing-but-empty → zeros (success); never-existed → strict
//     project_not_found error (Phase 3 A3).
//
// Mocks live in ./_mock.ts (extracted Phase 2). Style matches sanity.ts /
// phase1.ts / phase2.ts — node:assert/strict, no framework.
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";

import { cdn_create_project } from "../src/mcp/tools/cdn_create_project";
import { cdn_upload_file } from "../src/mcp/tools/cdn_upload_file";
import { cdn_replace_file } from "../src/mcp/tools/cdn_replace_file";
import { cdn_list_files } from "../src/mcp/tools/cdn_list_files";
import { cdn_get_file } from "../src/mcp/tools/cdn_get_file";
import { cdn_get_stats } from "../src/mcp/tools/cdn_get_stats";

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
// Test runner — same shape as sanity.ts / phase1.ts / phase2.ts.
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
  console.log("cdn-mcp Phase 3 tests");
  console.log("=====================");

  // ===================================================================
  // cdn_get_file
  // ===================================================================

  await check(
    "cdn_get_file: happy path returns the per-file shape verbatim from cdn_list_files",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      await cdn_upload_file.handler(
        { project: "p", name: "hero.png", content_base64: SAMPLE_PNG_B64 },
        ctx
      );

      const got = await cdn_get_file.handler(
        { project: "p", name: "hero.png" },
        ctx
      );
      assert.notEqual(got.isError, true, JSON.stringify(got));
      const getPayload = parseResult(got) as Record<string, unknown>;

      // Field-set + values match a freshly-listed row exactly. This is the
      // contract: a single get and a list entry are deepEqual.
      const list = await cdn_list_files.handler({ project: "p" }, ctx);
      const listPayload = parseResult(list) as { files: Array<Record<string, unknown>> };
      assert.equal(listPayload.files.length, 1);
      assert.deepEqual(getPayload, listPayload.files[0]);

      // Spot-check the individual fields the prompt enumerates.
      assert.equal(getPayload.name, "hero.png");
      assert.equal(getPayload.project, "p");
      assert.equal(getPayload.url, "https://cdn.22d.app/p/hero.png");
      assert.equal(getPayload.size_bytes, SAMPLE_PNG_LEN);
      assert.equal(getPayload.content_type, "image/png");
      assert.equal(getPayload.version, 1);
      assert.equal(getPayload.last_replaced_at, null);
      assert.equal(typeof getPayload.uploaded_at, "string");
    }
  );

  await check(
    "cdn_get_file: file_not_found when the project exists but the file doesn't",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      await cdn_upload_file.handler(
        { project: "p", name: "real.png", content_base64: SAMPLE_PNG_B64 },
        ctx
      );

      const res = await cdn_get_file.handler(
        { project: "p", name: "missing.png" },
        ctx
      );
      assert.equal(res.isError, true);
      const payload = parseResult(res) as { error: string; message: string };
      assert.equal(payload.error, "file_not_found");
      assert.match(payload.message, /p\/missing\.png/);
    }
  );

  await check(
    "cdn_get_file: file_not_found when the project itself does NOT exist (A2 — permissive, no projects-table consult)",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      // Note: no upload, no project — empty store.
      const res = await cdn_get_file.handler(
        { project: "doesnotexist", name: "anything.png" },
        ctx
      );
      assert.equal(res.isError, true);
      const payload = parseResult(res) as { error: string };
      // Both miss reasons collapse to file_not_found — that's the A2 rule.
      assert.equal(payload.error, "file_not_found");
      // No project rows were created as a side-effect of the lookup.
      assert.equal(store.projects.length, 0);
    }
  );

  await check(
    "cdn_get_file: invalid project / filename / missing args validators fire before any I/O",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      // Seed a real row so we can confirm that validators (not file_not_found)
      // are doing the rejection.
      await cdn_upload_file.handler(
        { project: "p", name: "x.png", content_base64: SAMPLE_PNG_B64 },
        ctx
      );

      const r1 = await cdn_get_file.handler(
        { project: "with space", name: "x.png" },
        ctx
      );
      assert.equal(r1.isError, true);
      assert.equal((parseResult(r1) as { error: string }).error, "invalid_project");

      const r2 = await cdn_get_file.handler(
        { project: "p", name: "../escape.png" },
        ctx
      );
      assert.equal(r2.isError, true);
      assert.equal((parseResult(r2) as { error: string }).error, "invalid_name");

      // Missing args entirely.
      const r3 = await cdn_get_file.handler({}, ctx);
      assert.equal(r3.isError, true);
      assert.equal(
        (parseResult(r3) as { error: string }).error,
        "invalid_project"
      );
      const r4 = await cdn_get_file.handler({ project: "p" }, ctx);
      assert.equal(r4.isError, true);
      assert.equal(
        (parseResult(r4) as { error: string }).error,
        "invalid_name"
      );
    }
  );

  await check(
    "cdn_get_file: read-after-replace reflects the bumped version + last_replaced_at",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      await cdn_upload_file.handler(
        { project: "p", name: "h.png", content_base64: SAMPLE_PNG_B64 },
        ctx
      );
      const replaceRes = await cdn_replace_file.handler(
        { project: "p", name: "h.png", content_base64: SAMPLE_PNG_2_B64 },
        ctx
      );
      assert.notEqual(replaceRes.isError, true);
      const replacePayload = parseResult(replaceRes) as {
        version: number;
        last_replaced_at: string;
        size_bytes: number;
      };

      const got = await cdn_get_file.handler(
        { project: "p", name: "h.png" },
        ctx
      );
      assert.notEqual(got.isError, true);
      const payload = parseResult(got) as {
        version: number;
        last_replaced_at: string;
        size_bytes: number;
        url: string;
      };
      assert.equal(payload.version, 2);
      assert.equal(payload.last_replaced_at, replacePayload.last_replaced_at);
      assert.equal(payload.size_bytes, SAMPLE_PNG_2_LEN);
      assert.equal(payload.url, "https://cdn.22d.app/p/h.png");
    }
  );

  // ===================================================================
  // cdn_get_stats — Mode A (global)
  // ===================================================================

  await check(
    "cdn_get_stats Mode A: empty bucket → { project_count: 0, file_count: 0, total_size_bytes: 0, projects: [] }",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      const res = await cdn_get_stats.handler({}, ctx);
      assert.notEqual(res.isError, true, JSON.stringify(res));
      const payload = parseResult(res) as {
        project_count: number;
        file_count: number;
        total_size_bytes: number;
        projects: unknown[];
      };
      assert.equal(payload.project_count, 0);
      assert.equal(payload.file_count, 0);
      assert.equal(payload.total_size_bytes, 0);
      assert.deepEqual(payload.projects, []);
    }
  );

  await check(
    "cdn_get_stats Mode A: multi-project totals, breakdown sorted ASC, project_count === projects.length",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      // Two projects, three files total. Use names whose lexical order
      // doesn't match insertion order so the sort is exercised.
      await cdn_upload_file.handler(
        {
          project: "phase3-stats-b",
          name: "b1.png",
          content_base64: SAMPLE_PNG_B64,
        },
        ctx
      );
      await cdn_upload_file.handler(
        {
          project: "phase3-stats-a",
          name: "a1.png",
          content_base64: SAMPLE_PNG_B64,
        },
        ctx
      );
      await cdn_upload_file.handler(
        {
          project: "phase3-stats-a",
          name: "a2.png",
          content_base64: SAMPLE_PNG_2_B64,
        },
        ctx
      );

      const res = await cdn_get_stats.handler({}, ctx);
      assert.notEqual(res.isError, true);
      const payload = parseResult(res) as {
        project_count: number;
        file_count: number;
        total_size_bytes: number;
        projects: Array<{ name: string; file_count: number; total_size_bytes: number }>;
      };
      assert.equal(payload.project_count, 2);
      assert.equal(payload.file_count, 3);
      assert.equal(
        payload.total_size_bytes,
        SAMPLE_PNG_LEN + SAMPLE_PNG_LEN + SAMPLE_PNG_2_LEN
      );
      // Sorted ASC.
      assert.deepEqual(
        payload.projects.map((p) => p.name),
        ["phase3-stats-a", "phase3-stats-b"]
      );
      // Per-project breakdown.
      assert.deepEqual(payload.projects[0], {
        name: "phase3-stats-a",
        file_count: 2,
        total_size_bytes: SAMPLE_PNG_LEN + SAMPLE_PNG_2_LEN,
      });
      assert.deepEqual(payload.projects[1], {
        name: "phase3-stats-b",
        file_count: 1,
        total_size_bytes: SAMPLE_PNG_LEN,
      });
      // Internal-consistency rule (A1): project_count === projects.length.
      assert.equal(payload.project_count, payload.projects.length);
    }
  );

  await check(
    "cdn_get_stats Mode A: empty project rows do NOT count toward project_count and do NOT appear in breakdown (A1)",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      // Pre-create two empty projects (modeling the real D1 state from
      // Run 3: phase1-test + phase2-verify both with file_count: 0).
      await cdn_create_project.handler(
        { name: "empty-one", description: "no files" },
        ctx
      );
      await cdn_create_project.handler({ name: "empty-two" }, ctx);
      // Then one project with one file.
      await cdn_upload_file.handler(
        {
          project: "with-files",
          name: "f.png",
          content_base64: SAMPLE_PNG_B64,
        },
        ctx
      );

      const res = await cdn_get_stats.handler({}, ctx);
      assert.notEqual(res.isError, true);
      const payload = parseResult(res) as {
        project_count: number;
        file_count: number;
        total_size_bytes: number;
        projects: Array<{ name: string }>;
      };
      // A1: project_count counts only projects WITH files.
      assert.equal(payload.project_count, 1);
      assert.equal(payload.file_count, 1);
      assert.equal(payload.total_size_bytes, SAMPLE_PNG_LEN);
      assert.deepEqual(
        payload.projects.map((p) => p.name),
        ["with-files"]
      );
      // The store still has 3 project rows total (the assertion is about the
      // stats output, not about cleanup).
      assert.equal(store.projects.length, 3);
    }
  );

  // ===================================================================
  // cdn_get_stats — Mode B (scoped)
  // ===================================================================

  await check(
    "cdn_get_stats Mode B: existing project with files → real totals",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      await cdn_upload_file.handler(
        { project: "p", name: "a.png", content_base64: SAMPLE_PNG_B64 },
        ctx
      );
      await cdn_upload_file.handler(
        { project: "p", name: "b.png", content_base64: SAMPLE_PNG_2_B64 },
        ctx
      );

      const res = await cdn_get_stats.handler({ project: "p" }, ctx);
      assert.notEqual(res.isError, true);
      const payload = parseResult(res) as {
        project: string;
        file_count: number;
        total_size_bytes: number;
      };
      assert.equal(payload.project, "p");
      assert.equal(payload.file_count, 2);
      assert.equal(
        payload.total_size_bytes,
        SAMPLE_PNG_LEN + SAMPLE_PNG_2_LEN
      );
      // Mode B response does NOT carry project_count or projects[].
      assert.equal((payload as Record<string, unknown>).project_count, undefined);
      assert.equal((payload as Record<string, unknown>).projects, undefined);
    }
  );

  await check(
    "cdn_get_stats Mode B: existing-but-empty project → { file_count: 0, total_size_bytes: 0 } (success, not error)",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      await cdn_create_project.handler(
        { name: "phase1-test", description: "kept across phases" },
        ctx
      );

      const res = await cdn_get_stats.handler(
        { project: "phase1-test" },
        ctx
      );
      assert.notEqual(res.isError, true, JSON.stringify(res));
      const payload = parseResult(res) as {
        project: string;
        file_count: number;
        total_size_bytes: number;
      };
      assert.equal(payload.project, "phase1-test");
      assert.equal(payload.file_count, 0);
      assert.equal(payload.total_size_bytes, 0);
    }
  );

  await check(
    "cdn_get_stats Mode B: never-existed project → project_not_found (A3 — strict)",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      // Seed an unrelated project to confirm we're checking the right name.
      await cdn_create_project.handler({ name: "exists" }, ctx);

      const res = await cdn_get_stats.handler(
        { project: "doesnotexist" },
        ctx
      );
      assert.equal(res.isError, true);
      const payload = parseResult(res) as { error: string; message: string };
      assert.equal(payload.error, "project_not_found");
      assert.match(payload.message, /doesnotexist/);
    }
  );

  await check(
    "cdn_get_stats Mode B: invalid project name → invalid_project (validator fires before existence check)",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);
      const res = await cdn_get_stats.handler(
        { project: "with space" },
        ctx
      );
      assert.equal(res.isError, true);
      assert.equal(
        (parseResult(res) as { error: string }).error,
        "invalid_project"
      );
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
  console.error("Unhandled error in phase 3 tests:", err);
  process.exit(1);
});
