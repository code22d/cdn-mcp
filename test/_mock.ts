// -----------------------------------------------------------------------------
// test/_mock.ts — shared in-memory D1 + R2 mocks for the test suite.
//
// Phase 1 introduced these mocks inline in test/phase1.ts. Phase 2 extracted
// them here so each phase's test file can stay focused on its phase-specific
// assertions. Phases 3+ should also import from this module — keep it the one
// place where the SQL fixtures and R2 surface live.
//
// Conventions in use across the test suite:
//   - Error payloads use snake_case identifiers: invalid_project, file_exists,
//     file_not_found, metadata_insert_failed, metadata_update_failed,
//     metadata_delete_failed, etc. New tools should follow the same pattern.
//   - SQL is matched by exact post-normalize string OR a small set of
//     well-defined substrings. Adding a new SQL shape to a handler means
//     adding a branch here too — that's intentional, it forces test-side
//     awareness of every SQL change.
// -----------------------------------------------------------------------------

import type { Env, ToolContext, ToolResult } from "../src/types";

// -----------------------------------------------------------------------------
// Row shapes — match the D1 migration in migrations/0001_init.sql.
// -----------------------------------------------------------------------------

export interface ProjectRow {
  name: string;
  description: string | null;
  created_at: string;
}

export interface FileRow {
  id: string;
  project: string;
  name: string;
  r2_key: string;
  content_type: string | null;
  size_bytes: number;
  public_url: string;
  uploaded_at: string;
  last_replaced_at: string | null;
  version: number;
}

// -----------------------------------------------------------------------------
// MockStore — owns the in-memory state for one test scenario.
//
// `failNext` is a single-shot failure injector consumed by the next matching
// MockStatement.run() call. Used by the metadata_*_failed assertions.
// -----------------------------------------------------------------------------

export class MockStore {
  projects: ProjectRow[] = [];
  files: FileRow[] = [];
  r2 = new Map<
    string,
    {
      bytes: Uint8Array;
      contentType: string | undefined;
      cacheControl: string | undefined;
    }
  >();

  failNext:
    | { kind: "insert_files" | "update_files" | "delete_files"; reason?: string }
    | null = null;
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

// -----------------------------------------------------------------------------
// MockStatement — matches the production D1Statement surface our handlers use:
// .bind(...args) returns a new statement, .first<T>() and .run() and .all<T>()
// resolve to the response shapes documented by @cloudflare/workers-types.
// -----------------------------------------------------------------------------

export class MockStatement {
  constructor(
    private store: MockStore,
    private sql: string,
    private boundArgs: unknown[] = []
  ) {}

  bind(...args: unknown[]): MockStatement {
    return new MockStatement(this.store, this.sql, args);
  }

  async first<T = unknown>(): Promise<T | null> {
    const sql = normalize(this.sql);

    if (sql === "SELECT name FROM projects WHERE name = ?") {
      const [n] = this.boundArgs as [string];
      const p = this.store.projects.find((r) => r.name === n);
      return p ? ({ name: p.name } as unknown as T) : null;
    }

    if (
      sql ===
      "SELECT id, version, uploaded_at FROM files WHERE project = ? AND name = ?"
    ) {
      const [proj, name] = this.boundArgs as [string, string];
      const f = this.store.files.find(
        (r) => r.project === proj && r.name === name
      );
      return f
        ? ({
            id: f.id,
            version: f.version,
            uploaded_at: f.uploaded_at,
          } as unknown as T)
        : null;
    }

    // Phase 4 cdn_signed_upload_url — minimal existence probe at
    // (project, name). We only need to know whether the row exists to
    // decide whether the file_exists guard fires.
    if (sql === "SELECT id FROM files WHERE project = ? AND name = ?") {
      const [proj, name] = this.boundArgs as [string, string];
      const f = this.store.files.find(
        (r) => r.project === proj && r.name === name
      );
      return f ? ({ id: f.id } as unknown as T) : null;
    }

    // Phase 2 cdn_delete_file — looks up r2_key for the row to delete.
    if (
      sql ===
      "SELECT id, r2_key FROM files WHERE project = ? AND name = ?"
    ) {
      const [proj, name] = this.boundArgs as [string, string];
      const f = this.store.files.find(
        (r) => r.project === proj && r.name === name
      );
      return f ? ({ id: f.id, r2_key: f.r2_key } as unknown as T) : null;
    }

    // Phase 3 cdn_get_file — single-row lookup by (project, name) returning
    // the full per-file shape that cdn_list_files emits.
    if (
      sql ===
      "SELECT id, project, name, public_url, content_type, size_bytes, uploaded_at, last_replaced_at, version FROM files WHERE project = ? AND name = ?"
    ) {
      const [proj, name] = this.boundArgs as [string, string];
      const f = this.store.files.find(
        (r) => r.project === proj && r.name === name
      );
      return f
        ? ({
            id: f.id,
            project: f.project,
            name: f.name,
            public_url: f.public_url,
            content_type: f.content_type,
            size_bytes: f.size_bytes,
            uploaded_at: f.uploaded_at,
            last_replaced_at: f.last_replaced_at,
            version: f.version,
          } as unknown as T)
        : null;
    }

    // Phase 3 cdn_get_stats Mode B — strict project-existence probe.
    // Returns { one: 1 } if the project row exists, null otherwise.
    if (sql === "SELECT 1 AS one FROM projects WHERE name = ?") {
      const [n] = this.boundArgs as [string];
      const p = this.store.projects.find((r) => r.name === n);
      return p ? ({ one: 1 } as unknown as T) : null;
    }

    // Phase 3 cdn_get_stats Mode A — global totals across the files table.
    // project_count = distinct projects with ≥ 1 file (Phase 3 A1).
    if (
      sql ===
      "SELECT COUNT(DISTINCT project) AS project_count, COUNT(*) AS file_count, COALESCE(SUM(size_bytes), 0) AS total_size_bytes FROM files"
    ) {
      const distinctProjects = new Set(this.store.files.map((f) => f.project));
      const file_count = this.store.files.length;
      const total_size_bytes = this.store.files.reduce(
        (s, f) => s + f.size_bytes,
        0
      );
      return {
        project_count: distinctProjects.size,
        file_count,
        total_size_bytes,
      } as unknown as T;
    }

    // Phase 3 cdn_get_stats Mode B — totals scoped to a single project.
    if (
      sql ===
      "SELECT COUNT(*) AS file_count, COALESCE(SUM(size_bytes), 0) AS total_size_bytes FROM files WHERE project = ?"
    ) {
      const [proj] = this.boundArgs as [string];
      const matching = this.store.files.filter((f) => f.project === proj);
      const file_count = matching.length;
      const total_size_bytes = matching.reduce(
        (s, f) => s + f.size_bytes,
        0
      );
      return { file_count, total_size_bytes } as unknown as T;
    }

    throw new Error(`MockD1.first: unhandled SQL: ${sql}`);
  }

  async run(): Promise<{ success: true }> {
    const sql = normalize(this.sql);

    if (
      sql === "INSERT INTO projects (name, description, created_at) VALUES (?, ?, ?)"
    ) {
      const [name, description, created_at] = this.boundArgs as [
        string,
        string | null,
        string
      ];
      if (this.store.projects.some((p) => p.name === name)) {
        throw new Error("UNIQUE constraint failed: projects.name");
      }
      this.store.projects.push({ name, description, created_at });
      return { success: true };
    }

    if (
      sql ===
      "INSERT OR IGNORE INTO projects (name, description, created_at) VALUES (?, NULL, ?)"
    ) {
      const [name, created_at] = this.boundArgs as [string, string];
      if (!this.store.projects.some((p) => p.name === name)) {
        this.store.projects.push({ name, description: null, created_at });
      }
      return { success: true };
    }

    if (
      sql ===
      "INSERT INTO files (id, project, name, r2_key, content_type, size_bytes, public_url, uploaded_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)"
    ) {
      if (this.store.failNext?.kind === "insert_files") {
        const reason = this.store.failNext.reason ?? "simulated INSERT failure";
        this.store.failNext = null;
        throw new Error(reason);
      }
      const [
        id,
        project,
        name,
        r2_key,
        content_type,
        size_bytes,
        public_url,
        uploaded_at,
      ] = this.boundArgs as [
        string,
        string,
        string,
        string,
        string | null,
        number,
        string,
        string
      ];
      if (
        this.store.files.some((f) => f.project === project && f.name === name)
      ) {
        throw new Error("UNIQUE constraint failed: files(project,name)");
      }
      this.store.files.push({
        id,
        project,
        name,
        r2_key,
        content_type,
        size_bytes,
        public_url,
        uploaded_at,
        last_replaced_at: null,
        version: 1,
      });
      return { success: true };
    }

    if (
      sql ===
      "UPDATE files SET content_type = ?, size_bytes = ?, last_replaced_at = ?, version = version + 1 WHERE project = ? AND name = ?"
    ) {
      if (this.store.failNext?.kind === "update_files") {
        const reason = this.store.failNext.reason ?? "simulated UPDATE failure";
        this.store.failNext = null;
        throw new Error(reason);
      }
      const [content_type, size_bytes, last_replaced_at, project, name] =
        this.boundArgs as [string | null, number, string, string, string];
      const f = this.store.files.find(
        (r) => r.project === project && r.name === name
      );
      if (!f) throw new Error("UPDATE matched 0 rows (row does not exist)");
      f.content_type = content_type;
      f.size_bytes = size_bytes;
      f.last_replaced_at = last_replaced_at;
      f.version += 1;
      return { success: true };
    }

    // Phase 2 cdn_delete_file
    if (sql === "DELETE FROM files WHERE project = ? AND name = ?") {
      if (this.store.failNext?.kind === "delete_files") {
        const reason = this.store.failNext.reason ?? "simulated DELETE failure";
        this.store.failNext = null;
        throw new Error(reason);
      }
      const [project, name] = this.boundArgs as [string, string];
      const before = this.store.files.length;
      this.store.files = this.store.files.filter(
        (f) => !(f.project === project && f.name === name)
      );
      // Match D1's behavior: DELETE returns success even if 0 rows matched.
      // Our handlers always look up first, so a 0-row DELETE indicates a
      // race that's acceptable to ignore (idempotent retry semantics).
      void before;
      return { success: true };
    }

    throw new Error(`MockD1.run: unhandled SQL: ${sql}`);
  }

  async all<T = unknown>(): Promise<{ results: T[]; success: true }> {
    const sql = normalize(this.sql);

    // cdn_list_files
    if (
      sql.startsWith(
        "SELECT id, project, name, public_url, content_type, size_bytes, uploaded_at, last_replaced_at, version FROM files"
      )
    ) {
      let rows = [...this.store.files];
      let i = 0;
      if (sql.includes("project = ?")) {
        const proj = this.boundArgs[i++] as string;
        rows = rows.filter((r) => r.project === proj);
      }
      if (sql.includes("uploaded_at < ?")) {
        const upLT = this.boundArgs[i++] as string;
        const upEQ = this.boundArgs[i++] as string;
        const idGT = this.boundArgs[i++] as string;
        rows = rows.filter(
          (r) =>
            r.uploaded_at < upLT ||
            (r.uploaded_at === upEQ && r.id > idGT)
        );
      }
      rows.sort((a, b) => {
        if (a.uploaded_at !== b.uploaded_at) {
          return a.uploaded_at < b.uploaded_at ? 1 : -1; // DESC
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // ASC
      });
      const limit = this.boundArgs[i++] as number;
      return {
        success: true,
        results: rows.slice(0, limit) as unknown as T[],
      };
    }

    // Phase 3 cdn_get_stats Mode A — per-project breakdown grouped from
    // the files table. Empty projects do NOT appear here (consistent with
    // A1: project_count = projects with files).
    if (
      sql ===
      "SELECT project, COUNT(*) AS file_count, COALESCE(SUM(size_bytes), 0) AS total_size_bytes FROM files GROUP BY project ORDER BY project ASC"
    ) {
      const byProject = new Map<
        string,
        { project: string; file_count: number; total_size_bytes: number }
      >();
      for (const f of this.store.files) {
        const cur = byProject.get(f.project);
        if (cur === undefined) {
          byProject.set(f.project, {
            project: f.project,
            file_count: 1,
            total_size_bytes: f.size_bytes,
          });
        } else {
          cur.file_count += 1;
          cur.total_size_bytes += f.size_bytes;
        }
      }
      const rows = [...byProject.values()].sort((a, b) =>
        a.project < b.project ? -1 : a.project > b.project ? 1 : 0
      );
      return { success: true, results: rows as unknown as T[] };
    }

    // cdn_list_projects
    if (sql.includes("FROM projects p") && sql.includes("LEFT JOIN files f")) {
      let projects = [...this.store.projects];
      let i = 0;
      if (sql.includes("WHERE p.name > ?")) {
        const cur = this.boundArgs[i++] as string;
        projects = projects.filter((p) => p.name > cur);
      }
      projects.sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      );
      const limit = this.boundArgs[i++] as number;
      const page = projects.slice(0, limit);
      const aggregated = page.map((p) => {
        const files = this.store.files.filter((f) => f.project === p.name);
        const total_size_bytes = files.reduce((s, f) => s + f.size_bytes, 0);
        return {
          name: p.name,
          description: p.description,
          created_at: p.created_at,
          file_count: files.length,
          total_size_bytes,
        };
      });
      return { success: true, results: aggregated as unknown as T[] };
    }

    throw new Error(`MockD1.all: unhandled SQL: ${sql}`);
  }
}

export class MockD1 {
  constructor(private store: MockStore) {}
  prepare(sql: string): MockStatement {
    return new MockStatement(this.store, sql);
  }
}

export class MockR2 {
  constructor(private store: MockStore) {}
  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | Uint8Array,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string };
    }
  ): Promise<void> {
    let bytes: Uint8Array;
    if (value instanceof Uint8Array) {
      bytes = value;
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else {
      throw new Error("MockR2.put: unsupported value type");
    }
    this.store.r2.set(key, {
      bytes,
      contentType: options?.httpMetadata?.contentType,
      cacheControl: options?.httpMetadata?.cacheControl,
    });
  }
  async delete(key: string): Promise<void> {
    // R2's real delete() is idempotent — it does NOT throw on missing keys.
    // Map.delete() also returns silently for missing keys, so this is a
    // faithful reproduction.
    this.store.r2.delete(key);
  }

  /**
   * Phase 4: cdn_finalize_upload uses head() to verify bytes exist before
   * committing the metadata row. The real R2Object surface has many fields;
   * we only stub `size` and `httpMetadata` since those are the only fields
   * any handler reads. Returns null on missing key — same shape as the real
   * R2's head() (it returns null, not throws).
   */
  async head(
    key: string
  ): Promise<{
    size: number;
    httpMetadata: {
      contentType: string | undefined;
      cacheControl: string | undefined;
    };
  } | null> {
    const obj = this.store.r2.get(key);
    if (!obj) return null;
    return {
      size: obj.bytes.length,
      httpMetadata: {
        contentType: obj.contentType,
        cacheControl: obj.cacheControl,
      },
    };
  }
}

// -----------------------------------------------------------------------------
// Convenience constructors used by every handler test.
// -----------------------------------------------------------------------------

export function makeEnv(store: MockStore): Env {
  return {
    ASSETS: new MockR2(store) as unknown as R2Bucket,
    DB: new MockD1(store) as unknown as D1Database,
    PUBLIC_URL_PREFIX: "https://cdn.22d.app",
    MCP_AUTH_TOKEN: "test-token",
    // Phase 4: required by cdn_signed_upload_url + cdn_finalize_upload.
    // Real values live in wrangler.toml ([vars]) and `wrangler secret put`.
    // Test values are syntactically valid but not bound to any real R2
    // bucket — the SigV4 helper just needs them to produce a URL.
    CLOUDFLARE_ACCOUNT_ID: "test-account-id-1ca89091477fe859962f0e9a14e8942e",
    R2_ACCESS_KEY_ID: "TESTACCESSKEYID0000",
    R2_SECRET_ACCESS_KEY: "TestSecretAccessKey0000000000000000000000",
    // Phase 11: present so the satisfies-Env shape compiles. Phase 1–5a tests
    // never reach OAuth code paths, but Env's shape changed when this field
    // was added.
    OAUTH_SIGNING_KEY: "test-oauth-signing-key-32-bytes-of-entropy-padded",
  };
}

/**
 * Seed bytes directly into the mock R2 store, simulating a successful
 * presigned PUT from a client. Used by Phase 4's cdn_finalize_upload tests
 * — the real flow is "client gets URL, client PUTs to R2, then client calls
 * finalize"; the mock collapses the middle step into this helper.
 */
export function seedR2(
  store: MockStore,
  key: string,
  bytes: Uint8Array,
  contentType?: string,
  cacheControl?: string
): void {
  store.r2.set(key, { bytes, contentType, cacheControl });
}

export function makeCtx(store: MockStore): ToolContext {
  return {
    env: makeEnv(store),
    request: new Request("https://cdn-mcp.example/mcp/test-token", {
      method: "POST",
    }),
  };
}

export function parseResult(res: ToolResult): unknown {
  const text = res.content[0]?.text ?? "";
  return JSON.parse(text);
}

// -----------------------------------------------------------------------------
// Test fixtures shared across phases.
// -----------------------------------------------------------------------------

/** Phase 1's sample 1×1 transparent PNG. Decoded length 68. */
export const SAMPLE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
export const SAMPLE_PNG_LEN = 68;

/**
 * Phase 2's sample 1×1 black opaque PNG. Decoded length 70.
 * sha256 = 418cc5deff5297f419fd302e44ab4dee8f8381eba42c932edeccd2d8e262a781
 */
export const SAMPLE_PNG_2_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwAEOQHNmnaaOAAAAABJRU5ErkJggg==";
export const SAMPLE_PNG_2_LEN = 70;
