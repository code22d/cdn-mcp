// -----------------------------------------------------------------------------
// JSON-RPC 2.0 dispatcher for the MCP protocol over Streamable HTTP.
//
// Methods handled:
//   - initialize                  → returns protocolVersion + capabilities + serverInfo
//   - notifications/initialized   → acknowledged with HTTP 200 + no body (MCP spec)
//   - notifications/*             → silently acknowledged
//   - tools/list                  → returns the registered tool surface
//   - tools/call                  → invokes a tool handler, wraps result
//
// Anything else → JSON-RPC -32601 "Method not found".
// Parse errors  → JSON-RPC -32700.
// Internal errs → JSON-RPC -32603.
//
// Pattern lifted from notion-multi-mcp + the Custom MCP Connection guide.
// We do NOT pull in @modelcontextprotocol/sdk — raw fetch + JSON-RPC is the
// proven path for these Workers (~150 LOC of explicit handling).
// -----------------------------------------------------------------------------

import { jsonResponse, corsResponse } from "../cors";
import type {
  Env,
  JsonRpcRequest,
  JsonRpcResponse,
  Tool,
  ToolContext,
  ToolResult,
} from "../types";
import { TOOLS } from "./tools/index";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "cdn-mcp", version: "0.1.0-phase4.1" };

/**
 * Top-level handler for POST /mcp/<token>. The router has already verified
 * the token matches env.MCP_AUTH_TOKEN before this is called.
 */
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return corsResponse("Method Not Allowed", { status: 405 });
  }

  let payload: JsonRpcRequest | JsonRpcRequest[];
  try {
    payload = (await request.json()) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return jsonResponse(rpcError(null, -32700, "Parse error"));
  }

  const ctx: ToolContext = { env, request };

  // Batch support per JSON-RPC 2.0
  if (Array.isArray(payload)) {
    const results = await Promise.all(payload.map((p) => dispatch(p, ctx)));
    const filtered = results.filter((r): r is JsonRpcResponse => r !== null);
    if (filtered.length === 0) return corsResponse(null, { status: 204 });
    return jsonResponse(filtered);
  }

  const res = await dispatch(payload, ctx);
  if (res === null) {
    // Notifications: HTTP 200 + empty body, per MCP spec.
    return corsResponse(null, { status: 200 });
  }
  return jsonResponse(res);
}

// -----------------------------------------------------------------------------
// Dispatch one request → one response (or null for notifications)
// -----------------------------------------------------------------------------

async function dispatch(
  req: JsonRpcRequest,
  ctx: ToolContext
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;

  // Notifications never produce a response.
  if (req.method.startsWith("notifications/")) {
    return null;
  }

  try {
    switch (req.method) {
      case "initialize":
        return rpcOk(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });

      case "ping":
        return rpcOk(id, {});

      case "tools/list": {
        const tools = TOOLS.map((t: Tool) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        return rpcOk(id, { tools });
      }

      case "tools/call": {
        const params = (req.params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        const tool = TOOLS.find((t: Tool) => t.name === params.name);
        if (!tool) {
          return rpcOk(id, {
            content: [
              { type: "text", text: `Unknown tool: ${String(params.name)}` },
            ],
            isError: true,
          } satisfies ToolResult);
        }
        const result = await invokeTool(tool, params.arguments ?? {}, ctx);
        return rpcOk(id, result);
      }

      default:
        return rpcError(id, -32601, `Method not found: ${req.method}`);
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return rpcError(id, -32603, `Internal error: ${message}`);
  }
}

async function invokeTool(
  tool: Tool,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  try {
    return await tool.handler(args, ctx);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      isError: true,
      content: [{ type: "text", text: `Tool error: ${message}` }],
    };
  }
}

// -----------------------------------------------------------------------------
// JSON-RPC envelope helpers
// -----------------------------------------------------------------------------

function rpcOk(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}
