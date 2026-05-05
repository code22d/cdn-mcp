// -----------------------------------------------------------------------------
// test/phase5a.ts — Phase 5.0a synthetic tests.
//
// Phase 5.0a is a docs phase. Two deliverables:
//   1. cdn_help — new tool returning the verbatim Usage Guide content.
//   2. Six existing tools' top-level descriptions hardened with operational
//      guidance (sandbox-egress gotcha, file-size patterns, error semantics).
//      The schema *shape* (parameters, types, required[]) of those tools is
//      unchanged — only the description text moves. Per Build Plan rule 2:
//      shape is contract, description is documentation.
//
// What this file asserts:
//   cdn_help:
//     - Registered in TOOLS under the name "cdn_help".
//     - Returns content[0].text non-empty (real string, not the stub
//       "not_yet_implemented" payload).
//     - Returned text contains key phrases from the Usage Guide so we know
//       the actual guide content is being served, not a placeholder.
//     - topic: <any value> is accepted without error and produces the same
//       full guide. Matches v1's ignore-topic contract.
//     - isError is NOT set — the help response is a successful tool result,
//       not a tool error.
//
//   Description hardening (6 tools):
//     - Each tool's `description` field contains a distinctive substring
//       chosen so a typo, revert, or unrelated rewrite would fail the test:
//         cdn_upload_file        → "subagents"
//         cdn_signed_upload_url  → "r2.cloudflarestorage.com"
//         cdn_finalize_upload    → "r2_object_not_found"
//         cdn_replace_file       → "?v="
//         cdn_delete_file        → "idempotent"
//         cdn_list_files         → "DESC then `id` ASC"
//                                    (covers both sort keys; the old Phase 0
//                                     description never mentioned sort order)
//
//   Schema-shape freeze (regression guard for rule 2):
//     - inputSchema.required arrays of all 6 hardened tools match the
//       deployed Phase 4.1 contract. If a builder accidentally edits
//       schema shape, this fires.
//
// Style matches sanity.ts / phase1–4 — node:assert/strict, no framework.
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";

import { TOOLS } from "../src/mcp/tools/index";
import { cdn_help } from "../src/mcp/tools/cdn_help";
import { cdn_upload_file } from "../src/mcp/tools/cdn_upload_file";
import { cdn_signed_upload_url } from "../src/mcp/tools/cdn_signed_upload_url";
import { cdn_finalize_upload } from "../src/mcp/tools/cdn_finalize_upload";
import { cdn_replace_file } from "../src/mcp/tools/cdn_replace_file";
import { cdn_delete_file } from "../src/mcp/tools/cdn_delete_file";
import { cdn_list_files } from "../src/mcp/tools/cdn_list_files";

import { MockStore, makeCtx } from "./_mock";

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
  console.log("cdn-mcp Phase 5.0a tests");
  console.log("========================");

  // ===================================================================
  // cdn_help — registration
  // ===================================================================

  await check("cdn_help: registered in TOOLS", () => {
    const names = TOOLS.map((t) => t.name);
    assert.ok(names.includes("cdn_help"), "cdn_help missing from TOOLS");
    // The tool exported from the file is the same instance the registry
    // imports — sanity check the identity, not just the name.
    const fromRegistry = TOOLS.find((t) => t.name === "cdn_help");
    assert.equal(fromRegistry, cdn_help, "cdn_help registry entry is not the exported tool");
  });

  await check("cdn_help: schema is { type: 'object', properties: { topic } } with no required[]", () => {
    const schema = cdn_help.inputSchema as {
      type: string;
      properties: { topic?: { type: string } };
      required?: string[];
    };
    assert.equal(schema.type, "object");
    assert.equal(typeof schema.properties, "object");
    assert.equal(schema.properties.topic?.type, "string");
    // No `required` array — `topic` is optional. Per Phase 4 A2.
    assert.equal(
      schema.required,
      undefined,
      "cdn_help.inputSchema.required must not be set; topic is optional"
    );
  });

  // ===================================================================
  // cdn_help — handler behavior
  // ===================================================================

  await check("cdn_help: returns non-empty content text (no args)", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    const res = await cdn_help.handler({}, ctx);
    assert.notEqual(res.isError, true, "cdn_help should not return isError");
    assert.ok(Array.isArray(res.content), "content must be an array");
    assert.equal(res.content.length, 1);
    assert.equal(res.content[0]?.type, "text");
    const text = res.content[0]?.text ?? "";
    assert.ok(text.length > 1000, `expected substantial content, got ${text.length} chars`);
  });

  await check("cdn_help: response contains key Usage Guide phrases", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    const res = await cdn_help.handler({}, ctx);
    const text = res.content[0]?.text ?? "";
    // A handful of distinctive phrases that pin the response to the actual
    // Usage Guide content rather than a placeholder. If any of these drift,
    // the help string was tampered with and we want to know.
    const expectedPhrases = [
      "CDN w MCP — Usage Guide",
      "Pattern A",
      "Pattern B",
      "Pattern C",
      "cdn_signed_upload_url",
      "sandbox",
      "cdn.22d.app",
      "Quick reference",
    ];
    for (const phrase of expectedPhrases) {
      assert.ok(
        text.includes(phrase),
        `cdn_help response missing expected phrase: "${phrase}"`
      );
    }
  });

  await check("cdn_help: topic argument is accepted and ignored (v1)", async () => {
    const store = new MockStore();
    const ctx = makeCtx(store);
    // Multiple topic shapes — string, unknown topic, even a non-string —
    // should all return the same full guide without error. v1 ignores topic.
    const r1 = await cdn_help.handler({ topic: "uploads" }, ctx);
    const r2 = await cdn_help.handler({ topic: "anything" }, ctx);
    const r3 = await cdn_help.handler({ topic: 123 as unknown as string }, ctx);
    assert.notEqual(r1.isError, true);
    assert.notEqual(r2.isError, true);
    assert.notEqual(r3.isError, true);
    const t1 = r1.content[0]?.text ?? "";
    const t2 = r2.content[0]?.text ?? "";
    const t3 = r3.content[0]?.text ?? "";
    assert.equal(t1, t2, "different topics returned different content (v1 must ignore topic)");
    assert.equal(t1, t3, "non-string topic returned different content (v1 should not validate)");
  });

  await check("cdn_help: response is plain markdown text, not JSON-stringified", async () => {
    // Phase 5.0a contract: the response IS markdown. Not JSON.stringify'd.
    // If a future refactor accidentally wraps it via okResult(), this fires.
    const store = new MockStore();
    const ctx = makeCtx(store);
    const res = await cdn_help.handler({}, ctx);
    const text = res.content[0]?.text ?? "";
    assert.ok(
      text.startsWith("# CDN w MCP"),
      `expected markdown starting with H1, got: ${text.slice(0, 80)}`
    );
    // Make sure it's NOT a JSON string of an object — those start with { or [.
    assert.ok(!text.startsWith("{"), "cdn_help text appears to be JSON-stringified");
    assert.ok(!text.startsWith("["), "cdn_help text appears to be JSON-stringified");
  });

  // ===================================================================
  // Description hardening (6 tools)
  //
  // Each substring is distinctive — picked so that a casual rewrite or a
  // revert to the Phase 0–4 wording wouldn't accidentally preserve it.
  // ===================================================================

  await check("cdn_upload_file: description mentions subagent fan-out", () => {
    assert.ok(
      cdn_upload_file.description.includes("subagents"),
      `cdn_upload_file description missing "subagents":\n${cdn_upload_file.description}`
    );
  });

  await check("cdn_signed_upload_url: description names the R2 S3 hostname", () => {
    assert.ok(
      cdn_signed_upload_url.description.includes("r2.cloudflarestorage.com"),
      `cdn_signed_upload_url description missing "r2.cloudflarestorage.com":\n${cdn_signed_upload_url.description}`
    );
  });

  await check("cdn_finalize_upload: description names the r2_object_not_found error", () => {
    assert.ok(
      cdn_finalize_upload.description.includes("r2_object_not_found"),
      `cdn_finalize_upload description missing "r2_object_not_found":\n${cdn_finalize_upload.description}`
    );
  });

  await check("cdn_replace_file: description mentions the ?v= cache-buster pattern", () => {
    assert.ok(
      cdn_replace_file.description.includes("?v="),
      `cdn_replace_file description missing "?v=":\n${cdn_replace_file.description}`
    );
  });

  await check("cdn_delete_file: description calls out R2 idempotency", () => {
    assert.ok(
      cdn_delete_file.description.includes("idempotent"),
      `cdn_delete_file description missing "idempotent":\n${cdn_delete_file.description}`
    );
  });

  await check("cdn_list_files: description specifies the secondary sort key (id ASC tiebreak)", () => {
    // The description says: "Sorted by `uploaded_at` DESC then `id` ASC ..."
    // Backticks around `uploaded_at` mean the literal "uploaded_at DESC" never
    // appears as one substring. We assert on "DESC then" (and the id-ASC
    // tiebreak) — both are unique to the new text and absent from the
    // Phase 0–4 description, which never mentioned sort order.
    assert.ok(
      cdn_list_files.description.includes("DESC then"),
      `cdn_list_files description missing "DESC then":\n${cdn_list_files.description}`
    );
    assert.ok(
      cdn_list_files.description.includes("id` ASC"),
      `cdn_list_files description missing "id\` ASC":\n${cdn_list_files.description}`
    );
  });

  // ===================================================================
  // Schema-shape freeze guard
  //
  // Phase 5.0a only edited description STRINGS. The inputSchema.required
  // arrays are part of the API contract and must match the deployed
  // Phase 4.1 contract verbatim. This block fails loudly if a builder
  // edits a schema by mistake.
  // ===================================================================

  await check("schema-shape freeze: required[] arrays match Phase 4.1 contract", () => {
    const expected: Record<string, string[] | undefined> = {
      cdn_upload_file: ["project", "name", "content_base64"],
      cdn_signed_upload_url: ["project", "name"],
      cdn_finalize_upload: ["project", "name", "content_type", "size_bytes"],
      cdn_replace_file: ["project", "name", "content_base64"],
      cdn_delete_file: ["project", "name"],
      cdn_list_files: undefined, // no required[] — all params optional
    };
    const actuals: Record<string, { inputSchema: { required?: string[] } }> = {
      cdn_upload_file,
      cdn_signed_upload_url,
      cdn_finalize_upload,
      cdn_replace_file,
      cdn_delete_file,
      cdn_list_files,
    };
    for (const name of Object.keys(expected)) {
      const got = actuals[name]!.inputSchema.required;
      const want = expected[name];
      assert.deepEqual(got, want, `${name}.inputSchema.required drifted`);
    }
  });

  // ===================================================================
  // Done
  // ===================================================================
  console.log("========================");
  console.log(`  ${pass} pass / ${fail} fail`);
  if (fail > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("Unhandled error in phase 5a tests:", err);
  process.exit(1);
});
