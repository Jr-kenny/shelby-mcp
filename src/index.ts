import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  formatPage,
  formatPageList,
  formatSearchResults,
  ShelbyDocsService
} from "./shelbyDocs.js";

const service = new ShelbyDocsService();

export function createDocsServer(): McpServer {
  const server = new McpServer(
    {
      name: "shelby-docs-mcp",
      version: "1.0.0",
      websiteUrl: "https://docs.shelby.xyz/",
      description: "Read-only MCP server for Shelby documentation search and retrieval."
    },
    {
      capabilities: {
        logging: {}
      }
    }
  );

  server.registerTool(
    "search_shelby_docs",
    {
      title: "Search Shelby Docs",
      description: "Search the Shelby documentation bundle and return the most relevant pages.",
      inputSchema: {
        query: z.string().min(1).describe("Search query for the Shelby docs."),
        limit: z.number().int().min(1).max(10).default(5).describe("Maximum number of results to return.")
      },
      annotations: {
        title: "Search Shelby Docs",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ query, limit }) => {
      const snapshot = await service.getSnapshot();
      const results = await service.search(query, limit);

      return {
        content: [
          {
            type: "text",
            text: formatSearchResults(query, snapshot, results)
          }
        ]
      };
    }
  );

  server.registerTool(
    "read_shelby_doc",
    {
      title: "Read Shelby Doc",
      description: "Read a Shelby documentation page by exact path, title, URL, page ID, or fuzzy query.",
      inputSchema: {
        page: z.string().min(1).describe("Page path, title, URL, page ID, or fuzzy lookup query."),
        maxChars: z.number().int().min(500).max(40000).default(6000).describe("Maximum characters to return.")
      },
      annotations: {
        title: "Read Shelby Doc",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ page, maxChars }) => {
      const match = await service.readPage(page);
      if (!match) {
        return {
          content: [
            {
              type: "text",
              text: `No Shelby documentation page matched "${page}".`
            }
          ]
        };
      }

      return {
        content: [
          {
            type: "text",
            text: formatPage(match, maxChars)
          }
        ]
      };
    }
  );

  server.registerTool(
    "get_shelby_doc_chunk",
    {
      title: "Get Shelby Doc Chunk",
      description: "Read a specific Shelby documentation page by its exact chunk ID.",
      inputSchema: {
        id: z.string().min(1).describe("Exact page ID returned by search_shelby_docs."),
        maxChars: z.number().int().min(500).max(40000).default(6000).describe("Maximum characters to return.")
      },
      annotations: {
        title: "Get Shelby Doc Chunk",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ id, maxChars }) => {
      const match = await service.getPageById(id);
      if (!match) {
        return {
          content: [
            {
              type: "text",
              text: `No Shelby documentation page matched id "${id}".`
            }
          ]
        };
      }

      return {
        content: [
          {
            type: "text",
            text: formatPage(match, maxChars)
          }
        ]
      };
    }
  );

  server.registerTool(
    "list_shelby_doc_pages",
    {
      title: "List Shelby Doc Pages",
      description: "List available Shelby documentation pages, optionally filtered by path or title text.",
      inputSchema: {
        prefix: z.string().optional().describe("Optional path or title filter."),
        limit: z.number().int().min(1).max(200).default(50).describe("Maximum number of pages to list.")
      },
      annotations: {
        title: "List Shelby Doc Pages",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ prefix, limit }) => {
      const pages = await service.listPages(prefix, limit);
      return {
        content: [
          {
            type: "text",
            text: formatPageList(pages, prefix)
          }
        ]
      };
    }
  );

  return server;
}

export async function startServer(): Promise<void> {
  if (process.argv.includes("--check")) {
    const snapshot = await service.getSnapshot();
    console.error(`Loaded ${snapshot.pages.length} Shelby docs pages from ${snapshot.source}.`);
    console.error(`Example page: ${snapshot.pages[0]?.title ?? "none"} (${snapshot.pages[0]?.path ?? "n/a"})`);
    return;
  }

  const server = createDocsServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
