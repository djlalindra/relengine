import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { fetchMultiplePages } from "@/lib/pipeline/content-extractor";
import { extractEntitiesForPages } from "@/lib/pipeline/gap-report";

/**
 * MCP server implemented as direct JSON-RPC request handling, rather than
 * using the SDK's StreamableHTTPServerTransport. That transport's
 * handleRequest() expects a real Node http.IncomingMessage/ServerResponse
 * pair (it reads/writes via Node's HTTP primitives directly), which doesn't
 * exist in a Next.js App Router route handler (Fetch API Request/Response
 * only) -- attempting to shim it caused the request to hang. Implementing
 * the small JSON-RPC surface needed (initialize, tools/list, tools/call)
 * by hand avoids that mismatch entirely and is fully testable.
 *
 * JSON Schema for each tool is hand-written rather than derived from the
 * zod schema via zod-to-json-schema -- that library's type definitions are
 * incompatible with the zod v4.x that the MCP SDK pulls in (a real
 * dependency mismatch, not a guess), and hand-writing two small schemas is
 * simpler and more reliable than fighting that version conflict.
 */

type ToolDef = {
  name: string;
  description: string;
  zodSchema: z.ZodRawShape;
  jsonSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

const tools: ToolDef[] = [
  {
    name: "scrape_pages",
    description:
      "Fetches one or more URLs and extracts clean main-content text, " +
      "stripping headers/footers/navigation/boilerplate. Returns title, " +
      "word count, and extracted text per URL. Use this before " +
      "extract_entities or any other analysis that needs page content.",
    zodSchema: {
      urls: z.array(z.string().url()).min(1).max(15),
    },
    jsonSchema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string", format: "uri" },
          minItems: 1,
          maxItems: 15,
          description: "List of URLs to scrape (max 15).",
        },
      },
      required: ["urls"],
    },
    handler: async (args) => {
      const { urls } = args as { urls: string[] };
      const pages = await fetchMultiplePages(urls);
      return {
        pages: pages.map((p) => ({
          url: p.url,
          title: p.title,
          wordCount: p.wordCount,
          fetchError: p.fetchError,
          text: p.text,
        })),
      };
    },
  },
  {
    name: "extract_entities",
    description:
      "Runs Google Cloud Natural Language entity extraction on a target " +
      "page plus a set of competitor pages, returning each entity's name, " +
      "type, and salience score (0-1, how central the entity is to that " +
      "page's content). Pass raw text for each page (e.g. from " +
      "scrape_pages output) rather than URLs -- this tool does not fetch " +
      "pages itself. Entities with salience 0 are filtered out as noise.",
    zodSchema: {
      targetUrl: z.string(),
      targetText: z.string(),
      competitors: z
        .array(z.object({ url: z.string(), text: z.string() }))
        .min(0)
        .max(15),
    },
    jsonSchema: {
      type: "object",
      properties: {
        targetUrl: {
          type: "string",
          description: "The target page's URL (for labeling output).",
        },
        targetText: {
          type: "string",
          description: "The target page's extracted text content.",
        },
        competitors: {
          type: "array",
          maxItems: 15,
          items: {
            type: "object",
            properties: {
              url: { type: "string", description: "Competitor page URL." },
              text: { type: "string", description: "Competitor page's extracted text content." },
            },
            required: ["url", "text"],
          },
          description: "Competitor pages with their extracted text.",
        },
      },
      required: ["targetUrl", "targetText", "competitors"],
    },
    handler: async (args) => {
      const { targetUrl, targetText, competitors } = args as {
        targetUrl: string;
        targetText: string;
        competitors: { url: string; text: string }[];
      };

      const target = { url: targetUrl, title: targetUrl, text: targetText, wordCount: 0 };
      const competitorPages = competitors.map((c) => ({
        url: c.url,
        title: c.url,
        text: c.text,
        wordCount: 0,
      }));

      const { targetEntities, competitorEntityLists, errors } =
        await extractEntitiesForPages(target, competitorPages);

      return {
        target: {
          url: targetUrl,
          entities: targetEntities
            .filter((e) => e.salience > 0)
            .sort((a, b) => b.salience - a.salience)
            .slice(0, 30),
        },
        competitors: competitorEntityLists.map((c) => ({
          url: c.url,
          entities: c.entities
            .filter((e) => e.salience > 0)
            .sort((a, b) => b.salience - a.salience)
            .slice(0, 30),
        })),
        errors,
      };
    },
  },
];

import { verifyAccessToken } from "@/lib/oauth";

/**
 * Validates the Bearer access token issued by our self-hosted OAuth 2.1
 * authorization server (see /api/oauth/*). Returns 401 with a
 * WWW-Authenticate header pointing at the protected-resource metadata
 * endpoint when missing/invalid, per the MCP authorization spec -- this is
 * how a client discovers where to start the OAuth flow if it tries calling
 * the tool endpoint without a token first.
 */
async function checkAuth(req: NextRequest): Promise<boolean> {
  const authHeader = req.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  const payload = await verifyAccessToken(match[1]);
  return payload !== null;
}

function unauthorizedResponse(req: NextRequest): NextResponse {
  const origin = req.nextUrl.origin;
  return NextResponse.json(
    { error: "unauthorized" },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      },
    }
  );
}

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
};

function jsonRpcResult(id: number | string | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: number | string | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleJsonRpc(body: JsonRpcRequest) {
  const { id, method, params } = body;

  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "relevance-engineering", version: "1.0.0" },
    });
  }

  if (method === "notifications/initialized") {
    // Notifications have no response per JSON-RPC spec; caller should not
    // expect a body. Handled by the route wrapper (no id => no response).
    return null;
  }

  if (method === "tools/list") {
    return jsonRpcResult(id, {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.jsonSchema,
      })),
    });
  }

  if (method === "tools/call") {
    const toolName = params?.name as string | undefined;
    const toolArgs = (params?.arguments as Record<string, unknown>) ?? {};
    const tool = tools.find((t) => t.name === toolName);

    if (!tool) {
      return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
    }

    const schema = z.object(tool.zodSchema);
    const parsed = schema.safeParse(toolArgs);
    if (!parsed.success) {
      return jsonRpcError(id, -32602, `Invalid arguments: ${parsed.error.message}`);
    }

    try {
      const result = await tool.handler(parsed.data);
      return jsonRpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown tool execution error.";
      return jsonRpcResult(id, {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      });
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

export async function POST(req: NextRequest) {
  if (!(await checkAuth(req))) {
    return unauthorizedResponse(req);
  }

  let body: JsonRpcRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      jsonRpcError(null, -32700, "Parse error: invalid JSON."),
      { status: 400 }
    );
  }

  try {
    const response = await handleJsonRpc(body);
    if (response === null) {
      // Notification, no response body expected.
      return new Response(null, { status: 202 });
    }
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    return NextResponse.json(
      jsonRpcError(body.id ?? null, -32603, `Internal error: ${message}`),
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  if (!(await checkAuth(req))) {
    return unauthorizedResponse(req);
  }
  return NextResponse.json({
    status: "ok",
    server: "relevance-engineering",
    tools: tools.map((t) => t.name),
  });
}
