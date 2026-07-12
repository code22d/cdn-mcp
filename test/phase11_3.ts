// -----------------------------------------------------------------------------
// test/phase11_3.ts — Phase 11.3: cdn_upload_file is hard-rejected.
//
// Phase 11.2 rewrote the upload tools' descriptions to redirect callers to the
// cdn-file-upload skill. Wording did not hold: Claude sessions kept calling
// cdn_upload_file and base64-chunking files into /tmp when the user named the
// MCP explicitly (observed 2026-07-12). Phase 11.3 replaces persuasion with
// enforcement — the handler rejects before touching R2 or D1.
//
// What these tests pin:
//   1. The tool still EXISTS (registry + tools/list) — we reject calls, we
//      don't remove the surface. A vanished tool would look like a broken
//      connector; a rejecting tool teaches the caller what to do instead.
//   2. Calling it returns isError: true with error tool_deprecated_for_external_use.
//   3. The error names the cdn-file-upload skill, so the caller can self-correct.
//   4. It writes NOTHING — D1 row count and R2 object count are unchanged, even
//      for a payload that would have been a perfectly valid upload in 11.2.
//   5. It rejects the same way through the dispatcher (what MCP clients hit),
//      not just via a direct handler call.
//   6. The two tools the skill's zero-click path and the CLI depend on —
//      cdn_signed_upload_url and cdn_finalize_upload — are NOT locked down.
//      This is the regression that would silently break every legitimate
//      upload, so it gets a real end-to-end presign → PUT → finalize assertion.
//   7. The FROZEN inputSchema and the 11.2 description survived (11.3 is a
//      behavior change only).
//
// Pure tsx — no test framework. Process exits non-zero on first failure.
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";

import worker from "../src/index";
import { TOOLS } from "../src/mcp/tools/index";
import { cdn_upload_file } from "../src/mcp/tools/cdn_upload_file";
import { cdn_signed_upload_url } from "../src/mcp/tools/cdn_signed_upload_url";
import { cdn_finalize_upload } from "../src/mcp/tools/cdn_finalize_upload";
import { handleMcp } from "../src/mcp/dispatch";
import { OWNER_PRINCIPAL } from "../src/principals";
import { MockStore, makeCtx, makeEnv, parseResult, seedR2 } from "./_mock";

const EXPECTED_ERROR = "tool_deprecated_for_external_use";
const EXPECTED_VERSION = "0.1.0-phase11.3";

// A payload that WOULD have uploaded cleanly under Phase 11.2 — valid project,
// valid filename, valid base64. The point is that validity buys you nothing:
// the rejection happens before any of it is looked at.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const VALID_ARGS = {
  project: "Test",
  name: "x.txt",
  content_base64: Buffer.from(PNG_BYTES).toString("base64"),
  content_type: "text/plain",
};

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
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ ${label}`);
        console.error(`      ${message}`);
        fail++;
      }
    );
}

/** Row count in the mock D1 `files` table. */
function fileRowCount(store: MockStore): number {
  return store.files.length;
}

/** Object count in the mock R2 bucket. */
function r2ObjectCount(store: MockStore): number {
  return store.r2.size;
}

async function callViaDispatcher(
  store: MockStore,
  args: Record<string, unknown>
): Promise<{ isError?: boolean; text: string }> {
  const req = new Request("https://cdn-mcp.example/mcp/test-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "cdn_upload_file", arguments: args },
    }),
  });
  const res = await handleMcp(req, makeEnv(store), OWNER_PRINCIPAL);
  assert.equal(res.status, 200, `dispatcher returned ${res.status}`);
  const body = (await res.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  return {
    isError: body.result.isError,
    text: body.result.content[0]?.text ?? "",
  };
}

async function main(): Promise<void> {
  console.log("Phase 11.3 — cdn_upload_file hard-rejects external callers");
  console.log("=========================================================");

  // ---------------- 1. the tool surface still exists ------------------------

  await check("cdn_upload_file is still registered (rejecting, not removed)", () => {
    const tool = TOOLS.find((t) => t.name === "cdn_upload_file");
    assert.ok(tool, "cdn_upload_file vanished from the registry");
    assert.equal(typeof tool.handler, "function");
    assert.equal(TOOLS.length, 13, "tool count changed — 11.3 removes nothing");
  });

  // ---------------- 2 + 3. it rejects, and says why -------------------------

  await check("cdn_upload_file: direct call returns isError: true", async () => {
    const store = new MockStore();
    const res = await cdn_upload_file.handler(VALID_ARGS, makeCtx(store));
    assert.equal(res.isError, true, "expected isError: true");
  });

  await check(
    `cdn_upload_file: error payload contains "${EXPECTED_ERROR}"`,
    async () => {
      const store = new MockStore();
      const res = await cdn_upload_file.handler(VALID_ARGS, makeCtx(store));
      const text = res.content[0]?.text ?? "";
      assert.ok(
        text.includes(EXPECTED_ERROR),
        `expected "${EXPECTED_ERROR}" in payload, got: ${text}`
      );
      const payload = parseResult(res) as { error: string };
      assert.equal(payload.error, EXPECTED_ERROR);
    }
  );

  await check(
    'cdn_upload_file: error payload names the "cdn-file-upload skill"',
    async () => {
      const store = new MockStore();
      const res = await cdn_upload_file.handler(VALID_ARGS, makeCtx(store));
      const text = res.content[0]?.text ?? "";
      assert.ok(
        text.includes("cdn-file-upload skill"),
        `error must point the caller at the skill, got: ${text}`
      );
    }
  );

  // ---------------- 4. it writes NOTHING ------------------------------------

  await check(
    "cdn_upload_file: no D1 rows and no R2 objects created (before === after)",
    async () => {
      const store = new MockStore();

      const d1Before = fileRowCount(store);
      const r2Before = r2ObjectCount(store);

      const res = await cdn_upload_file.handler(VALID_ARGS, makeCtx(store));
      assert.equal(res.isError, true);

      const d1After = fileRowCount(store);
      const r2After = r2ObjectCount(store);

      assert.equal(d1After, d1Before, `D1 files rows changed: ${d1Before} → ${d1After}`);
      assert.equal(r2After, r2Before, `R2 objects changed: ${r2Before} → ${r2After}`);
      assert.equal(d1After, 0, "no file row should exist");
      assert.equal(r2After, 0, "no R2 object should exist");
    }
  );

  await check(
    "cdn_upload_file: rejects even with replace: true against an existing file",
    async () => {
      const store = new MockStore();

      // Seed a real file the 11.2 handler would happily have overwritten.
      seedR2(store, "Test/x.txt", PNG_BYTES, "text/plain");
      await cdn_finalize_upload.handler(
        {
          project: "Test",
          name: "x.txt",
          content_type: "text/plain",
          size_bytes: PNG_BYTES.length,
        },
        makeCtx(store)
      );
      const d1Before = fileRowCount(store);
      const r2Before = r2ObjectCount(store);
      assert.equal(d1Before, 1, "seed failed — expected one row");

      const res = await cdn_upload_file.handler(
        { ...VALID_ARGS, replace: true, content_base64: "aGk=" },
        makeCtx(store)
      );
      assert.equal(res.isError, true);

      // The seeded bytes and row are untouched — no overwrite, no version bump.
      assert.equal(fileRowCount(store), d1Before);
      assert.equal(r2ObjectCount(store), r2Before);
      assert.deepEqual(store.r2.get("Test/x.txt")?.bytes, PNG_BYTES);
    }
  );

  // ---------------- 5. it rejects over the wire too --------------------------

  await check(
    "cdn_upload_file: dispatcher (tools/call) rejects — what MCP clients actually hit",
    async () => {
      const store = new MockStore();
      const { isError, text } = await callViaDispatcher(store, VALID_ARGS);
      assert.equal(isError, true, "dispatcher did not surface isError");
      assert.ok(text.includes(EXPECTED_ERROR), `payload over the wire: ${text}`);
      assert.equal(r2ObjectCount(store), 0, "dispatcher path wrote to R2");
      assert.equal(fileRowCount(store), 0, "dispatcher path wrote to D1");
    }
  );

  // ---------------- 6. the legitimate paths still work -----------------------

  await check(
    "cdn_signed_upload_url: NOT locked down (skill zero-click + CLI depend on it)",
    async () => {
      const store = new MockStore();
      const res = await cdn_signed_upload_url.handler(
        { project: "Test", name: "probe.txt", content_type: "text/plain" },
        makeCtx(store)
      );
      assert.notEqual(res.isError, true, `presign errored: ${res.content[0]?.text}`);
      const payload = parseResult(res) as {
        upload_url: string;
        required_headers: Record<string, string>;
      };
      assert.ok(payload.upload_url.startsWith("https://"), "no presigned URL returned");
      assert.ok(payload.required_headers, "required_headers missing");
    }
  );

  await check(
    "cdn_finalize_upload: NOT locked down — full presign → PUT → finalize still lands a file",
    async () => {
      const store = new MockStore();
      const ctx = makeCtx(store);

      // 1. Presign (the skill's step 3).
      const presign = await cdn_signed_upload_url.handler(
        { project: "Test", name: "zero-click.png", content_type: "image/png" },
        ctx
      );
      assert.notEqual(presign.isError, true);

      // 2. The client PUTs the bytes (the skill's step 4 — mocked).
      seedR2(store, "Test/zero-click.png", PNG_BYTES, "image/png");

      // 3. Finalize (the skill's step 5).
      const finalize = await cdn_finalize_upload.handler(
        {
          project: "Test",
          name: "zero-click.png",
          content_type: "image/png",
          size_bytes: PNG_BYTES.length,
        },
        ctx
      );
      assert.notEqual(
        finalize.isError,
        true,
        `finalize errored: ${finalize.content[0]?.text}`
      );

      const payload = parseResult(finalize) as { url: string; project: string };
      assert.equal(payload.project, "Test");
      assert.ok(
        payload.url.endsWith("/Test/zero-click.png"),
        `unexpected public URL: ${payload.url}`
      );

      // The row is really there — the zero-click path is intact end to end.
      assert.equal(fileRowCount(store), 1);
    }
  );

  // ---------------- 7. schema + description unchanged -----------------------

  await check(
    "Phase 11.3 is behavior-only — FROZEN inputSchema and the 11.2 description survive",
    () => {
      const schema = cdn_upload_file.inputSchema as {
        type: string;
        required?: string[];
      };
      assert.equal(schema.type, "object");
      assert.deepEqual(schema.required, ["project", "name", "content_base64"]);
      assert.ok(
        cdn_upload_file.description.includes("Skill-internal use only"),
        "the Phase 11.2 redirect marker was dropped from the description"
      );
      assert.ok(
        cdn_upload_file.description.includes("cdn-file-upload"),
        "the description must still name the skill"
      );
    }
  );

  // ---------------- 8. version bump ----------------------------------------

  await check(`/health reports ${EXPECTED_VERSION}`, async () => {
    const res = await worker.fetch(
      new Request("https://cdn-mcp.example/health"),
      makeEnv(new MockStore())
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { version: string; status: string };
    assert.equal(body.status, "ok");
    assert.equal(body.version, EXPECTED_VERSION);
  });

  console.log("=========================================================");
  console.log(`  ${pass} pass / ${fail} fail`);
  if (fail > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("Unhandled error in phase 11.3 tests:", err);
  process.exit(1);
});
