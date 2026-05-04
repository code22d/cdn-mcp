// -----------------------------------------------------------------------------
// cdn_set_cache_headers — Phase 4+ ships the real handler.
// -----------------------------------------------------------------------------

import type { Tool } from "../../types";
import { stubHandler } from "./_stub";

const NAME = "cdn_set_cache_headers";

export const cdn_set_cache_headers: Tool = {
  name: NAME,
  description:
    "Set a custom Cache-Control header for a file. Useful for assets that need long-lived caching (e.g. immutable versioned assets) or short-lived caching (e.g. frequently updated config files). Affects how Cloudflare's edge and downstream consumers cache the file.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project (folder) name containing the file.",
      },
      name: {
        type: "string",
        description: "Filename within the project.",
      },
      cache_control: {
        type: "string",
        description:
          "Full Cache-Control header value to apply (e.g. 'public, max-age=31536000, immutable' or 'public, max-age=60').",
      },
    },
    required: ["project", "name", "cache_control"],
  },
  handler: stubHandler(NAME),
};
