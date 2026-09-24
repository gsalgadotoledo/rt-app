import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {fileURLToPath} from "node:url";
import { moduleClient } from "@gsalgadotoledo/rt-app-cli/module-tools";

/** One process per MCP client; uses the existing API instead of another DB writer. */
const client = await moduleClient(
  process.env.RT_APP_PROJECT_ROOT ?? fileURLToPath(new URL("../../", import.meta.url)),
);
const server = new McpServer({ name: "rt-app-modules", version: "0.2.0" });

// Every enabled module contributes documented actions to this same catalog.
for (const tool of client.tools) {
  server.registerTool(
    tool.name,
    {
      description:
        tool.description +
        (tool.example ? ` Example: ${JSON.stringify(tool.example)}` : ""),
      inputSchema: {
        params: z
          .record(z.string())
          .optional()
          .describe("Route parameters, such as id"),
        query: z
          .record(z.string())
          .optional()
          .describe("Filters and pagination cursor"),
        body: z
          .record(z.unknown())
          .optional()
          .describe("Request fields documented by this action"),
      },
      annotations: {
        readOnlyHint: tool.method === "GET",
        destructiveHint: tool.method !== "GET",
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(await client.call(tool.name, input)),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error.message }],
        };
      }
    },
  );
}

// stdout is reserved exclusively for MCP protocol messages.
await server.connect(new StdioServerTransport());
