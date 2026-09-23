# Module MCP

Start the API with `npm run dev`. The MCP client launches `node apps/mcp/index.mjs` over stdio; do not run it as an HTTP service.

```json
{"mcpServers":{"rt-app":{"command":"node","args":["/absolute/project/apps/mcp/index.mjs"],"env":{"RT_APP_PROJECT_ROOT":"/absolute/project"}}}}
```

Optional environment: `RT_APP_API_URL` and `RT_APP_ADMIN_TOKEN` for authenticated remote access. Restart the MCP connection to discover newly registered module actions. See `rt-app/AGENTS.md`.
