// -----------------------------------------------------------------------------
// test/sanity.ts — minimal Phase 0 sanity assertions.
//
// Run via: npm test  (which runs `tsx test/sanity.ts`)
//
// Asserts:
//   1. All 13 expected tool names are present in the registry.
//      (Phase 0 = 12; Phase 5.0a added cdn_help for 13 total.)
//   2. Each tool has name + description + inputSchema + handler.
//   3. No duplicate tool names.
//   4. The dispatcher returns a well-formed JSON-RPC `tools/list` response
//      listing all 13 tools with name + description + inputSchema.
//   5. The dispatcher returns a `tools/call` stub response with
//      result.content[0].text containing "not_yet_implemented" AND
//      result.isError === true. Asserts against a tool that is STILL a stub
//      (cdn_set_cache_headers — Phase 4+); Phase 1 swapped the cdn_list_*,
//      cdn_create_project, and cdn_upload_file handlers to real ones.
//
// Pure tsx — no test framework. Process exits non-zero on first failure
// (assert throws), zero on success.
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";
import { TOOLS } from "../src/mcp/tools/index";
import { handleMcp } from "../src/mcp/dispatch";
import type { Env } from "../src/types";

const EXPECTED_TOOL_NAMES = [
  // v1 (8)
  "cdn_upload_file",
  "cdn_replace_file",
  "cdn_list_files",
  "cdn_list_projects",
  "cdn_get_file",
  "cdn_delete_file",
  "cdn_get_stats",
  "cdn_create_project",
  // Phase 4+ (4)
  "cdn_signed_upload_url",
  "cdn_finalize_upload",
  "cdn_rename_file",
  "cdn_set_cache_headers",
  // Meta — Phase 5.0a (1)
  "cdn_help",
];

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
        console.log(`  ✗ ${label}\n    ${message}`);
        fail++;
      }
    );
}

// A minimal stub Env — neither R2 nor D1 is touched by Phase 0 stub handlers.
// We cast through `unknown` so this compiles under strict mode without needing
// to mock the full R2Bucket / D1Database surface.
const stubEnv = {
  ASSETS: {} as unknown as R2Bucket,
  DB: {} as unknown as D1Database,
  PUBLIC_URL_PREFIX: "https://cdn.22d.app",
  MCP_AUTH_TOKEN: "test-token",
  // Phase 4 added these to Env. Sanity tests don't actually exercise the
  // SigV4 path — they just need the satisfies-Env shape to compile.
  CLOUDFLARE_ACCOUNT_ID: "test-account-id",
  R2_ACCESS_KEY_ID: "TESTACCESSKEYID0000",
  R2_SECRET_ACCESS_KEY: "TestSecretAccessKey0000000000000000000000",
} satisfies Env;

async function main() {
  console.log("cdn-mcp sanity tests");
  console.log("====================");

  // -----------------------------------------------------------------
  // Assertion 1: all 13 expected tool names present
  // (Phase 5.0a bumped this from 12 to 13 by adding cdn_help.)
  // -----------------------------------------------------------------
  await check("all 13 expected tool names registered", () => {
    const names = TOOLS.map((t) => t.name).sort();
    const expected = [...EXPECTED_TOOL_NAMES].sort();
    assert.deepEqual(names, expected, "tool name set mismatch");
    assert.equal(TOOLS.length, 13, "expected exactly 13 tools");
  });

  // -----------------------------------------------------------------
  // Assertion 2: each tool has the four required properties
  // -----------------------------------------------------------------
  await check("every tool has name + description + inputSchema + handler", () => {
    for (const t of TOOLS) {
      assert.equal(typeof t.name, "string", `${t.name}: name not a string`);
      assert.ok(t.name.length > 0, `${t.name}: empty name`);
      assert.equal(
        typeof t.description,
        "string",
        `${t.name}: description not a string`
      );
      assert.ok(t.description.length > 0, `${t.name}: empty description`);
      assert.equal(
        typeof t.inputSchema,
        "object",
        `${t.name}: inputSchema not an object`
      );
      assert.ok(t.inputSchema !== null, `${t.name}: inputSchema is null`);
      assert.equal(
        (t.inputSchema as { type?: unknown }).type,
        "object",
        `${t.name}: inputSchema.type !== "object"`
      );
      assert.equal(typeof t.handler, "function", `${t.name}: handler not a function`);
    }
  });

  // -----------------------------------------------------------------
  // Assertion 3: no duplicate tool names
  // -----------------------------------------------------------------
  await check("no duplicate tool names", () => {
    const seen = new Set<string>();
    for (const t of TOOLS) {
      assert.ok(!seen.has(t.name), `duplicate tool name: ${t.name}`);
      seen.add(t.name);
    }
  });

  // -----------------------------------------------------------------
  // Assertion 4: dispatcher tools/list returns a well-formed envelope
  // -----------------------------------------------------------------
  await check(
    "dispatcher tools/list returns well-formed JSON-RPC envelope with all 13 tools",
    async () => {
      const req = new Request("https://cdn-mcp.example/mcp/test-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      const res = await handleMcp(req, stubEnv);
      assert.equal(res.status, 200, `expected 200, got ${res.status}`);
      assert.equal(
        res.headers.get("Access-Control-Allow-Origin"),
        "*",
        "missing CORS header on tools/list"
      );
      const body = (await res.json()) as {
        jsonrpc: string;
        id: number;
        result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
      };
      assert.equal(body.jsonrpc, "2.0");
      assert.equal(body.id, 1);
      assert.ok(Array.isArray(body.result?.tools), "result.tools is not an array");
      assert.equal(body.result.tools.length, 13, "expected 13 tools in tools/list");
      for (const tool of body.result.tools) {
        assert.equal(typeof tool.name, "string");
        assert.equal(typeof tool.description, "string");
        assert.equal(typeof tool.inputSchema, "object");
      }
    }
  );

  // -----------------------------------------------------------------
  // Assertion 5: dispatcher tools/call returns the stub payload
  // -----------------------------------------------------------------
  await check(
    "dispatcher tools/call returns stub payload with isError: true",
    async () => {
      const req = new Request("https://cdn-mcp.example/mcp/test-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "cdn_set_cache_headers",
            arguments: {},
          },
        }),
      });
      const res = await handleMcp(req, stubEnv);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        jsonrpc: string;
        id: number;
        result: {
          content: Array<{ type: string; text: string }>;
          isError?: boolean;
        };
      };
      assert.equal(body.jsonrpc, "2.0");
      assert.equal(body.id, 2);
      assert.ok(body.result, "missing result");
      assert.equal(body.result.isError, true, "expected isError: true on stub");
      assert.ok(
        Array.isArray(body.result.content) && body.result.content.length > 0,
        "expected non-empty content array"
      );
      const text = body.result.content[0]?.text ?? "";
      assert.ok(
        text.includes("not_yet_implemented"),
        `expected "not_yet_implemented" in text, got: ${text}`
      );
      const parsed = JSON.parse(text) as {
        error: string;
        phase: string;
        tool: string;
      };
      assert.equal(parsed.error, "not_yet_implemented");
      assert.equal(parsed.phase, "0");
      assert.equal(parsed.tool, "cdn_set_cache_headers");
    }
  );

  console.log("====================");
  console.log(`  ${pass} pass / ${fail} fail`);
  if (fail > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("Unhandled error in sanity tests:", err);
  process.exit(1);
});
