#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";

const API_BASE = "https://api.glyphic.ai/v1";
const API_KEY = process.env.GLYPHIC_API_KEY;

if (!API_KEY) {
  console.error("GLYPHIC_API_KEY environment variable is required");
  process.exit(1);
}

// -- Helper ------------------------------------------------------------------

async function glyphicFetch(path: string, options?: RequestInit): Promise<unknown> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "x-api-key": API_KEY!,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Glyphic API error ${res.status}: ${body}`);
  }

  return res.json();
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "";
  return "?" + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

// -- Server ------------------------------------------------------------------

function createServer(): McpServer {
  const s = new McpServer({ name: "glyphic", version: "1.0.0" });

  s.tool("ping", "Test connectivity to the Glyphic API", {}, async () => {
    const data = await glyphicFetch("/test/ping");
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });

  s.tool(
    "list_calls",
    "List calls from Glyphic with optional filters. Returns call previews with pagination.",
    {
      participant_email: z.string().optional().describe("Filter by participant email (case insensitive)"),
      start_time_from: z.string().optional().describe("Filter calls from this time (UTC ISO 8601, e.g. 2024-01-01T00:00:00Z)"),
      start_time_to: z.string().optional().describe("Filter calls up to this time (UTC ISO 8601)"),
      title_filter: z.string().optional().describe("Filter calls by title"),
      cursor: z.string().optional().describe("Pagination cursor from previous response"),
      limit: z.number().min(1).max(100).optional().describe("Items per page (default 20, max 100)"),
      direction: z.enum(["next", "prev"]).optional().describe("Pagination direction"),
    },
    async (params) => {
      const query = qs({
        participant_email: params.participant_email,
        start_time_from: params.start_time_from,
        start_time_to: params.start_time_to,
        title_filter: params.title_filter,
        cursor: params.cursor,
        limit: params.limit,
        direction: params.direction,
      });
      const data = await glyphicFetch(`/calls/${query}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  s.tool(
    "get_call",
    "Get full details of a specific call including transcript, summary, insights, and participants.",
    { call_id: z.string().length(24).describe("The 24-character hex call ID") },
    async ({ call_id }) => {
      const data = await glyphicFetch(`/calls/${call_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  s.tool(
    "get_call_media",
    "Get the media URL (audio/video) for a specific call. URL expires in 24 hours.",
    { call_id: z.string().length(24).describe("The 24-character hex call ID") },
    async ({ call_id }) => {
      const data = await glyphicFetch(`/calls/${call_id}/media`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  s.tool(
    "get_call_snippets",
    "Get snippets from a call, sorted by newest first. Includes transcript turns within the snippet time range.",
    { call_id: z.string().length(24).describe("The 24-character hex call ID") },
    async ({ call_id }) => {
      const data = await glyphicFetch(`/calls/${call_id}/snippets`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  s.tool(
    "join_call",
    "Send a Glyphic bot to join and record a meeting. Only one bot per meeting URL within 2 minutes.",
    {
      meeting_url: z.string().describe("The meeting URL to join (Google Meet, Zoom, etc.)"),
      title: z.string().optional().describe("Title for the meeting"),
      participants: z
        .array(z.object({
          name: z.string().optional().describe("Participant name"),
          email: z.string().optional().describe("Participant email"),
        }))
        .optional()
        .describe("List of meeting participants"),
    },
    async (params) => {
      const body: Record<string, unknown> = { meeting_url: params.meeting_url };
      if (params.title) body.title = params.title;
      if (params.participants) body.participants = params.participants;
      const data = await glyphicFetch("/call_bots", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  return s;
}

const MODE = process.env.TRANSPORT ?? "stdio";

async function main() {
  if (MODE === "http") {
    const PORT = parseInt(process.env.PORT ?? "3000", 10);
    const app = createMcpExpressApp({ host: "0.0.0.0" });

    app.post("/mcp", async (req, res) => {
      const s = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await s.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => { transport.close(); s.close(); });
    });

    app.get("/mcp", (_req, res) => {
      res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    });

    app.delete("/mcp", (_req, res) => {
      res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    });

    app.get("/health", (_req, res) => { res.json({ status: "ok" }); });

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Glyphic MCP server listening on http://0.0.0.0:${PORT}/mcp`);
    });
  } else {
    const s = createServer();
    const transport = new StdioServerTransport();
    await s.connect(transport);
    console.error("Glyphic MCP server running on stdio");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
