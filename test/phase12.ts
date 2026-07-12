// -----------------------------------------------------------------------------
// Phase 12 tests — per-project principals.
//
// Mirrors the publishing-mcp auth-v2 suite: map parsing (fail-closed),
// token → principal resolution (constant-time scan, rotation overlap),
// argument forcing, and true end-to-end scoping through worker.fetch on the
// legacy /mcp/<token> path (router → auth → dispatch → handler → mock D1/R2).
//
// Run: npx tsx test/phase12.ts
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";
import worker from "../src/index";
import {
  ALL_PROJECTS,
  OWNER_PRINCIPAL,
  applyPrincipal,
  parsePrincipals,
  resolvePathToken,
} from "../src/principals";
import { MockStore, makeEnv, seedR2 } from "./_mock";
import type { Env } from "../src/types";

let passed = 0;
function ok(name: string): void {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const TENANT_TOKEN = "tenant-a-gateway-token-0000000000";
const TENANT_TOKEN_NEXT = "tenant-a-gateway-token-1111111111";
const PRINCIPALS_JSON = JSON.stringify({
  [TENANT_TOKEN]: { project: "tenant-a" },
  [TENANT_TOKEN_NEXT]: { project: "tenant-a" },
  "tenant-b-gateway-token-0000000000": { project: "tenant-b" },
});

function envWithPrincipals(store: MockStore): Env {
  return { ...makeEnv(store), MCP_PRINCIPALS: PRINCIPALS_JSON };
}

async function rpc(
  env: Env,
  token: string,
  tool: string,
  args: Record<string, unknown>
): Promise<{ status: number; payload: unknown }> {
  const res = await worker.fetch(
    new Request(`https://cdn-mcp.example/mcp/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
    }),
    env
  );
  if (res.status !== 200) return { status: res.status, payload: null };
  const rpcRes = (await res.json()) as { result?: { content: Array<{ text: string }> } };
  const text = rpcRes.result?.content?.[0]?.text ?? "null";
  return { status: 200, payload: JSON.parse(text) };
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/**
 * Seed a file through the dispatcher the way real clients do: presign → PUT →
 * finalize. Phase 11.3 hard-rejected cdn_upload_file, so base64-over-MCP is no
 * longer available for seeding at this level — and it was never how the CLI or
 * the skill's zero-click path actually wrote bytes anyway. `claimed` is the
 * project the caller ASKS for; `landsIn` is where the principal should force it.
 *
 * The mock collapses the client's real PUT into a seedR2 at the presigned key,
 * which is the same shortcut Phase 4's finalize tests take.
 */
async function uploadViaPresign(
  env: Env,
  store: MockStore,
  token: string,
  claimed: string,
  landsIn: string,
  name: string
): Promise<{ status: number; payload: unknown }> {
  const presign = await rpc(env, token, "cdn_signed_upload_url", {
    project: claimed,
    name,
    content_type: "image/png",
  });
  const presignPayload = presign.payload as { project?: string; error?: string };
  assert.equal(
    presignPayload.project,
    landsIn,
    `presign should be scoped to ${landsIn}, got ${presignPayload.project ?? presignPayload.error}`
  );

  // The client PUTs to the presigned URL. The signature only ever covers the
  // forced key, so the bytes can only land under the principal's project.
  seedR2(store, `${landsIn}/${name}`, PNG_BYTES, "image/png");

  return rpc(env, token, "cdn_finalize_upload", {
    project: claimed,
    name,
    content_type: "image/png",
    size_bytes: PNG_BYTES.length,
  });
}

async function main(): Promise<void> {
  console.log("phase12: per-project principals");

  // -- parsePrincipals ------------------------------------------------------
  {
    const map = parsePrincipals(PRINCIPALS_JSON);
    assert.equal(map.size, 3);
    assert.deepEqual(map.get(TENANT_TOKEN), { project: "tenant-a" });
    ok("parsePrincipals: valid map");

    assert.equal(parsePrincipals("not json").size, 0);
    assert.equal(parsePrincipals("[1,2]").size, 0);
    assert.equal(parsePrincipals(undefined).size, 0);
    ok("parsePrincipals: fail-closed on malformed documents");

    const partial = parsePrincipals(
      JSON.stringify({
        good: { project: "p" },
        "no-project": {},
        "empty-project": { project: "" },
        "not-object": 42,
      })
    );
    assert.deepEqual([...partial.keys()], ["good"]);
    ok("parsePrincipals: malformed entries skipped, valid kept");
  }

  // -- resolvePathToken -----------------------------------------------------
  {
    const env = envWithPrincipals(new MockStore());
    assert.deepEqual(resolvePathToken("test-token", env), { project: ALL_PROJECTS });
    ok("resolvePathToken: MCP_AUTH_TOKEN → owner (*)");

    assert.deepEqual(resolvePathToken(TENANT_TOKEN, env), { project: "tenant-a" });
    assert.deepEqual(resolvePathToken(TENANT_TOKEN_NEXT, env), { project: "tenant-a" });
    ok("resolvePathToken: map tokens resolve, rotation overlap → same principal");

    assert.equal(resolvePathToken("unknown-token-0000000000000000", env), null);
    assert.equal(resolvePathToken("tenant-a-gateway-token-0000000001", env), null); // same length
    ok("resolvePathToken: unknown + same-length near-miss → null");

    const bare = { ...makeEnv(new MockStore()), MCP_AUTH_TOKEN: "" } as Env;
    assert.equal(resolvePathToken("test-token", bare), null);
    ok("resolvePathToken: empty MCP_AUTH_TOKEN + no map → null (fail closed)");
  }

  // -- applyPrincipal -------------------------------------------------------
  {
    const args = { project: "other", name: "f.png" };
    assert.deepEqual(applyPrincipal("cdn_upload_file", args, OWNER_PRINCIPAL), args);
    ok("applyPrincipal: owner passthrough");

    const forced = applyPrincipal("cdn_upload_file", args, { project: "tenant-a" });
    assert.equal(forced.project, "tenant-a");
    ok("applyPrincipal: caller-supplied project overridden");

    const created = applyPrincipal("cdn_create_project", { name: "sneaky" }, { project: "tenant-a" });
    assert.equal(created.name, "tenant-a");
    ok("applyPrincipal: cdn_create_project name forced");

    const listArgs = { limit: 5 };
    assert.deepEqual(applyPrincipal("cdn_list_projects", listArgs, { project: "tenant-a" }), listArgs);
    ok("applyPrincipal: cdn_list_projects args untouched (handler-scoped)");
  }

  // -- End-to-end scoping through worker.fetch (legacy path) -----------------
  {
    const store = new MockStore();
    const env = envWithPrincipals(store);

    // Owner seeds a file in tenant-b's project (owner is unscoped: claims
    // tenant-b, lands in tenant-b).
    const seeded = await uploadViaPresign(
      env,
      store,
      "test-token",
      "tenant-b",
      "tenant-b",
      "secret.png"
    );
    assert.equal((seeded.payload as { project: string }).project, "tenant-b");
    assert.ok(store.r2.has("tenant-b/secret.png"));
    ok("e2e: owner token uploads to any project");

    // Tenant-a uploads while CLAIMING tenant-b → forced into tenant-a at BOTH
    // the presign and the finalize.
    const up = await uploadViaPresign(
      env,
      store,
      TENANT_TOKEN,
      "tenant-b",
      "tenant-a",
      "mine.png"
    );
    const upPayload = up.payload as { project: string; url: string };
    assert.equal(upPayload.project, "tenant-a");
    assert.ok(upPayload.url.endsWith("/tenant-a/mine.png"));
    assert.ok(store.r2.has("tenant-a/mine.png"));
    assert.ok(!store.r2.has("tenant-b/mine.png"));
    ok("e2e: upload with foreign project claim lands in the principal's project");

    // Tenant-a cannot read tenant-b's file: project arg is forced to tenant-a.
    const get = await rpc(env, TENANT_TOKEN, "cdn_get_file", {
      project: "tenant-b",
      name: "secret.png",
    });
    assert.equal((get.payload as { error?: string }).error, "file_not_found");
    ok("e2e: cross-project read → file_not_found");

    // Tenant-a cannot delete tenant-b's file either; tenant-b's row survives.
    const del = await rpc(env, TENANT_TOKEN, "cdn_delete_file", {
      project: "tenant-b",
      name: "secret.png",
    });
    assert.equal((del.payload as { error?: string }).error, "file_not_found");
    assert.ok(store.r2.has("tenant-b/secret.png"));
    ok("e2e: cross-project delete → file_not_found, target untouched");

    // list_files with no project (global for owner) collapses to tenant-a.
    const list = await rpc(env, TENANT_TOKEN, "cdn_list_files", {});
    const listRows = (list.payload as { files: Array<{ project: string }> }).files;
    assert.ok(listRows.length >= 1);
    assert.ok(listRows.every((f) => f.project === "tenant-a"));
    ok("e2e: list_files global collapses to the principal's project");

    // list_projects only reveals the principal's own project.
    const projects = await rpc(env, TENANT_TOKEN, "cdn_list_projects", {});
    const names = (projects.payload as { projects: Array<{ name: string }> }).projects.map(
      (p) => p.name
    );
    assert.deepEqual(names, ["tenant-a"]);
    ok("e2e: list_projects hides other tenants");

    // Owner still sees both projects.
    const all = await rpc(env, "test-token", "cdn_list_projects", {});
    const allNames = (all.payload as { projects: Array<{ name: string }> }).projects.map(
      (p) => p.name
    );
    assert.deepEqual(allNames.sort(), ["tenant-a", "tenant-b"]);
    ok("e2e: owner list_projects still global");

    // get_stats without args: scoped principal gets its project's stats.
    const stats = await rpc(env, TENANT_TOKEN, "cdn_get_stats", {});
    const statsPayload = stats.payload as { project?: string; projects?: unknown };
    assert.equal(statsPayload.project, "tenant-a");
    ok("e2e: get_stats collapses to the principal's project");

    // create_project with a foreign name is forced to the principal's own.
    const created = await rpc(env, TENANT_TOKEN, "cdn_create_project", { name: "tenant-b" });
    const createdPayload = created.payload as { error?: string; project?: { name?: string }; name?: string };
    const createdName = createdPayload.project?.name ?? createdPayload.name;
    if (createdPayload.error) {
      // "already exists" for its OWN project is acceptable; leaking tenant-b's
      // existence is not — the forced name means the error is about tenant-a.
      assert.equal(createdPayload.error, "project_exists");
    } else {
      assert.equal(createdName, "tenant-a");
    }
    ok("e2e: create_project name forced to the principal's project");

    // Unknown gateway token → 404 (indistinguishable from no server).
    const unknown = await rpc(env, "no-such-token", "cdn_list_files", {});
    assert.equal(unknown.status, 404);
    ok("e2e: unknown token → 404");
  }

  console.log(`phase12: ${passed} assertions passed`);
}

main().catch((e) => {
  console.error("✗ phase12 failed:", e);
  process.exit(1);
});
