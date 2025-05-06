import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { MCPQueryParams } from "../types/mcp";
import type { MCPResponse } from "shared";
import mcpRouter from "../routes/mcp";

// Define the tool parameter types
const getUserContextByFidParams = z.object({
  method: z.literal("getUserContextByFid"),
  params: z.object({
    fid: z.number().int().positive(),
    limit: z.number().int().positive().optional(),
    sortOrder: z.enum(["newest", "oldest"]).optional(),
    includeReplies: z.boolean().optional(),
    all: z.boolean().optional(),
  }),
});

const getUserContextByUsernameParams = z.object({
  method: z.literal("getUserContextByUsername"),
  params: z.object({
    username: z.string().min(1),
    limit: z.number().int().positive().optional(),
    sortOrder: z.enum(["newest", "oldest"]).optional(),
    includeReplies: z.boolean().optional(),
    all: z.boolean().optional(),
  }),
});

const getUserProfileParams = z.object({
  method: z.literal("getUserProfile"),
  params: z.object({
    username: z.string().min(1),
  }),
});

const getUserPostsParams = z.object({
  method: z.literal("getUserPosts"),
  params: z.object({
    username: z.string().min(1),
    limit: z.number().int().positive().optional(),
    sortOrder: z.enum(["newest", "oldest"]).optional(),
    includeReplies: z.boolean().optional(),
  }),
});

// Define request types
type GetUserContextByFidRequest = z.infer<typeof getUserContextByFidParams>;
type GetUserContextByUsernameRequest = z.infer<typeof getUserContextByUsernameParams>;
type GetUserProfileRequest = z.infer<typeof getUserProfileParams>;
type GetUserPostsRequest = z.infer<typeof getUserPostsParams>;

// Create the MCP server
const server = new Server({
  name: "user-context-server",
  version: "1.0.0",
  capabilities: {
    tools: {
      getUserContextByFid: {
        description: "Get user context by FID",
        parameters: getUserContextByFidParams,
        handler: async (request: GetUserContextByFidRequest) => {
          const { params } = request;
          try {
            const queryParams: MCPQueryParams = {
              fid: params.fid.toString(),
              limit: params.limit,
              sortOrder: params.sortOrder,
              includeReplies: params.includeReplies || false,
              all: params.all || false,
            };

            // Create a mock request to pass to the mcp router
            const searchParams = new URLSearchParams();
            if (queryParams.fid) searchParams.set("fid", queryParams.fid.toString());
            if (queryParams.username) searchParams.set("username", queryParams.username);
            if (queryParams.limit) searchParams.set("limit", queryParams.limit.toString());
            if (queryParams.sortOrder) searchParams.set("sortOrder", queryParams.sortOrder);
            searchParams.set("includeReplies", queryParams.includeReplies?.toString() || "false");
            searchParams.set("all", queryParams.all?.toString() || "false");

            const mockRequest = new Request(`/mcp?${searchParams.toString()}`);
            const response = await mcpRouter.fetch(mockRequest);
            const data = (await response.json()) as MCPResponse;

            return {
              content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
            };
          }
        },
      },
      getUserContextByUsername: {
        description: "Get user context by username",
        parameters: getUserContextByUsernameParams,
        handler: async (request: GetUserContextByUsernameRequest) => {
          const { params } = request;
          try {
            const queryParams: MCPQueryParams = {
              username: params.username,
              limit: params.limit,
              sortOrder: params.sortOrder,
              includeReplies: params.includeReplies || false,
              all: params.all || false,
            };

            // Create a mock request to pass to the mcp router
            const searchParams = new URLSearchParams();
            if (queryParams.fid) searchParams.set("fid", queryParams.fid.toString());
            if (queryParams.username) searchParams.set("username", queryParams.username);
            if (queryParams.limit) searchParams.set("limit", queryParams.limit.toString());
            if (queryParams.sortOrder) searchParams.set("sortOrder", queryParams.sortOrder);
            searchParams.set("includeReplies", queryParams.includeReplies?.toString() || "false");
            searchParams.set("all", queryParams.all?.toString() || "false");

            const mockRequest = new Request(`/mcp?${searchParams.toString()}`);
            const response = await mcpRouter.fetch(mockRequest);
            const data = (await response.json()) as MCPResponse;

            return {
              content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
            };
          }
        },
      },
    },
    prompts: {
      getUserProfile: {
        description: "Get user profile information",
        parameters: getUserProfileParams,
        handler: async (request: GetUserProfileRequest) => {
          const { params } = request;
          try {
            const queryParams: MCPQueryParams = { username: params.username };

            // Create a mock request to pass to the mcp router
            const searchParams = new URLSearchParams();
            if (queryParams.username) searchParams.set("username", queryParams.username);

            const mockRequest = new Request(`/mcp?${searchParams.toString()}`);
            const response = await mcpRouter.fetch(mockRequest);
            const data = (await response.json()) as MCPResponse;

            return {
              description: "Get user profile information",
              messages: [
                {
                  role: "user",
                  content: {
                    type: "text",
                    text: `Get profile information for user ${params.username}`,
                  },
                },
                {
                  role: "assistant",
                  content: {
                    type: "text",
                    text: JSON.stringify(data.user, null, 2),
                  },
                },
              ],
            };
          } catch (error) {
            throw new Error(`Failed to get user profile: ${error instanceof Error ? error.message : "Unknown error"}`);
          }
        },
      },
      getUserPosts: {
        description: "Get user posts",
        parameters: getUserPostsParams,
        handler: async (request: GetUserPostsRequest) => {
          const { params } = request;
          try {
            const queryParams: MCPQueryParams = {
              username: params.username,
              limit: params.limit,
              sortOrder: params.sortOrder,
              includeReplies: params.includeReplies || false,
            };

            // Create a mock request to pass to the mcp router
            const searchParams = new URLSearchParams();
            if (queryParams.username) searchParams.set("username", queryParams.username);
            if (queryParams.limit) searchParams.set("limit", queryParams.limit.toString());
            if (queryParams.sortOrder) searchParams.set("sortOrder", queryParams.sortOrder);
            searchParams.set("includeReplies", queryParams.includeReplies?.toString() || "false");

            const mockRequest = new Request(`/mcp?${searchParams.toString()}`);
            const response = await mcpRouter.fetch(mockRequest);
            const data = (await response.json()) as MCPResponse;

            return {
              description: "Get user posts",
              messages: [
                {
                  role: "user",
                  content: {
                    type: "text",
                    text: `Get posts for user ${params.username}`,
                  },
                },
                {
                  role: "assistant",
                  content: {
                    type: "text",
                    text: JSON.stringify(data.casts, null, 2),
                  },
                },
              ],
            };
          } catch (error) {
            throw new Error(`Failed to get user posts: ${error instanceof Error ? error.message : "Unknown error"}`);
          }
        },
      },
    },
  },
});

export async function startServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  startServer().catch((error) => {
    process.exitCode = 1;
    process.stderr.write(`Failed to start MCP server: ${error instanceof Error ? error.message : "Unknown error"}\n`);
  });
}
