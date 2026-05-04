// -----------------------------------------------------------------------------
// cdn_rename_file — Phase 4+ ships the real handler.
//
// Renames a file within the same project. Note: this CHANGES the public URL,
// so consumers holding the old URL will 404. Use sparingly. For stable URLs
// across content updates, prefer cdn_replace_file.
// -----------------------------------------------------------------------------

import type { Tool } from "../../types";
import { stubHandler } from "./_stub";

const NAME = "cdn_rename_file";

export const cdn_rename_file: Tool = {
  name: NAME,
  description:
    "Rename a file within a project. The R2 key, public URL, and file id all change — anyone holding the old URL will get 404. Use sparingly. For overwriting bytes while preserving the URL, use cdn_replace_file instead. Same-project only; cross-project moves are not supported in v1.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project (folder) name containing the file.",
      },
      name: {
        type: "string",
        description: "Current filename within the project.",
      },
      new_name: {
        type: "string",
        description: "New filename within the same project.",
      },
    },
    required: ["project", "name", "new_name"],
  },
  handler: stubHandler(NAME),
};
