// -----------------------------------------------------------------------------
// test/phase11_2.ts — Phase 11.2 synthetic tests: upload-tool description
// redirects.
//
// Phase 11.2 is a text-only change. The three upload tools (cdn_upload_file,
// cdn_signed_upload_url, cdn_finalize_upload) kept their handlers and their
// FROZEN inputSchemas, but their `description` strings were rewritten to
// redirect callers to the cdn-file-upload skill. Partners were reading the old
// friendly descriptions off the connector and invoking the tools directly —
// base64 small-file uploads, manual signed-URL + curl PUT sequences — instead
// of letting the skill generate a clickable CLI script.
//
// These assertions exist so a future edit can't quietly friendly-ify the
// descriptions again and reopen the anti-pattern:
//   1. All three upload tools carry the "Skill-internal use only" marker.
//   2. All three name the cdn-file-upload skill + cdn-mcp-plugin as the
//      correct route.
//   3. The stale advice that CAUSED the anti-pattern is gone (base64 is
//      "best for" small files, subagent fan-out, "avoid base64 overhead").
//   4. The other 10 tools are untouched — the marker is scoped to uploads.
//   5. The rewritten descriptions actually reach MCP clients through the
//      dispatcher's tools/list, not just the in-process registry.
//   6. The FROZEN inputSchemas survived the description edit.
//   7. /health reports the Phase 11.2 version.
//
// Pure tsx — no test framework. Process exits non-zero on first failure.
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";

import worker from "../src/index";
import { TOOLS } from "../src/mcp/tools/index";
import { handleMcp } from "../src/mcp/dispatch";
import { OWNER_PRINCIPAL } from "../src/principals";
import type { Env } from "../src/types";

const MARKER = "Skill-internal use only";
const EXPECTED_VERSION = "0.1.0-phase11.2";

// The three tools Phase 11.2 redirects. Everything else in the registry must
// keep its own description untouched.
const REDIRECTED_TOOLS = [
  "cdn_upload_file",
  "cdn_signed_upload_url",
  "cdn_finalize_upload",
];

// Phrases from the pre-11.2 descriptions that actively taught the anti-pattern.
// If any of these come back, the redirect has been undone.
const BANNED_PHRASES = [
  "fan out via subagents",
  "Best for files <5MB",
  "avoid base64 round-trip overhead",
];

const stubEnv = {
  ASSETS: {} as unknown as R2Bucket,
  DB: {} as unknown as D1Database,
  PUBLIC_URL_PREFIX: "https://cdn.22d.app",
  MCP_AUTH_TOKEN: "test-token",
  CLOUDFLARE_ACCOUNT_ID: "test-account-id",
  R2_ACCESS_KEY_ID: "TESTACCESSKEYID0000",
  R2_SECRET_ACCESS_KEY: "TestSecretAccessKey0000000000000000000000",
  OAUTH_SIGNING_KEY: "test-oauth-signing-key-32-bytes-of-entropy-padded",
} satisfies Env;

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

function descriptionOf(name: string): string {
  const tool = TOOLS.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} missing from registry`);
  return tool.description;
}

async function toolsListDescriptions(): Promise<Map<string, string>> {
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
  const res = await handleMcp(req, stubEnv, OWNER_PRINCIPAL);
  assert.equal(res.status, 200, `tools/list returned ${res.status}`);
  const body = (await res.json()) as {
    result: { tools: { name: string; description: string }[] };
  };
  return new Map(body.result.tools.map((t) => [t.name, t.description]));
}

async function main(): Promise<void> {
  console.log("Phase 11.2 — upload-tool description redirects");
  console.log("=============================================");

  // ---------------- 1. the marker is present --------------------------------

  for (const name of REDIRECTED_TOOLS) {
    await check(`${name}: description carries the "${MARKER}" marker`, () => {
      const description = descriptionOf(name);
      assert.ok(
        description.includes(MARKER),
        `expected "${MARKER}" in ${name} description, got: ${description}`
      );
    });
  }

  // ---------------- 2. the redirect names the right destination -------------

  for (const name of REDIRECTED_TOOLS) {
    await check(`${name}: description points at the cdn-file-upload skill`, () => {
      const description = descriptionOf(name);
      assert.ok(
        description.includes("cdn-file-upload"),
        `${name} description must name the cdn-file-upload skill`
      );
      assert.ok(
        description.includes("cdn-mcp-plugin"),
        `${name} description must name the cdn-mcp-plugin that ships the skill`
      );
    });
  }

  // ---------------- 3. the anti-pattern advice is gone ----------------------

  await check(
    "no upload tool still recommends base64 sizing or subagent fan-out",
    () => {
      for (const name of REDIRECTED_TOOLS) {
        const description = descriptionOf(name);
        for (const banned of BANNED_PHRASES) {
          assert.ok(
            !description.includes(banned),
            `${name} description reintroduced the pre-11.2 anti-pattern advice: "${banned}"`
          );
        }
      }
    }
  );

  // ---------------- 4. the marker is scoped to the upload tools -------------

  await check("the other 10 tools do NOT carry the redirect marker", () => {
    const leaked = TOOLS.filter(
      (t) => !REDIRECTED_TOOLS.includes(t.name) && t.description.includes(MARKER)
    ).map((t) => t.name);
    assert.deepEqual(
      leaked,
      [],
      `marker leaked onto non-upload tools: ${leaked.join(", ")}`
    );
    // Sanity on the arithmetic: 13 tools total, 3 redirected, 10 untouched.
    assert.equal(TOOLS.length - REDIRECTED_TOOLS.length, 10);
  });

  // ---------------- 5. clients actually see the new text --------------------

  await check(
    "dispatcher tools/list surfaces the redirected descriptions to MCP clients",
    async () => {
      const listed = await toolsListDescriptions();
      assert.equal(listed.size, 13, `expected 13 tools, got ${listed.size}`);
      for (const name of REDIRECTED_TOOLS) {
        const description = listed.get(name);
        assert.ok(description, `${name} missing from tools/list`);
        assert.ok(
          description.includes(MARKER),
          `${name} description over the wire is stale (no "${MARKER}"): ${description}`
        );
        assert.equal(
          description,
          descriptionOf(name),
          `${name} description over the wire diverges from the registry`
        );
      }
    }
  );

  // ---------------- 6. FROZEN inputSchemas survived the edit ----------------

  await check("Phase 11.2 changed text only — inputSchemas are intact", () => {
    const expectedRequired: Record<string, string[]> = {
      cdn_upload_file: ["project", "name", "content_base64"],
      cdn_signed_upload_url: ["project", "name"],
      cdn_finalize_upload: ["project", "name", "content_type", "size_bytes"],
    };
    for (const name of REDIRECTED_TOOLS) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `tool ${name} missing from registry`);
      const schema = tool.inputSchema as {
        type: string;
        required?: string[];
      };
      assert.equal(schema.type, "object", `${name} inputSchema type changed`);
      assert.deepEqual(
        schema.required,
        expectedRequired[name],
        `${name} required fields changed — this must stay a text-only phase`
      );
      assert.equal(
        typeof tool.handler,
        "function",
        `${name} lost its handler`
      );
    }
  });

  // ---------------- 7. version bump ----------------------------------------

  await check(`/health reports ${EXPECTED_VERSION}`, async () => {
    const res = await worker.fetch(
      new Request("https://cdn-mcp.example/health"),
      stubEnv
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { version: string; status: string };
    assert.equal(body.status, "ok");
    assert.equal(body.version, EXPECTED_VERSION);
  });

  console.log("=============================================");
  console.log(`  ${pass} pass / ${fail} fail`);
  if (fail > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("Unhandled error in phase 11.2 tests:", err);
  process.exit(1);
});
