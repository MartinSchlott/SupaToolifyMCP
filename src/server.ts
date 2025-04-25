import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AppConfig } from "./config.js";
import { SupabaseClientWrapper } from "./supabase.js";
import { SchemaIntrospector } from "./introspection.js";
import { MCPToolFactory } from "./tool-factory.js";

/**
 * Creates and configures an McpServer instance.
 * This involves initializing the Supabase connection, introspecting the
 * specified schema for views/functions, and dynamically registering them as MCP tools.
 *
 * @param config - The application configuration.
 * @returns A promise that resolves to the configured McpServer instance.
 * @throws If any part of the setup fails (e.g., Supabase connection, introspection).
 */
export async function createMcpServer(config: AppConfig): Promise<McpServer> {
	console.log("Creating MCP Server instance...");

	// 1. Initialize MCP Server Core with explicit capabilities
	const server = new McpServer(
		{
			name: "SupaToolifyMCP",
			version: "1.0.0",
		},
		{
			// Explicitly declare capabilities
			capabilities: {
				tools: {}, // Enable the tools feature
				// Add other capabilities like resources or prompts here if needed
			},
		},
	);
	console.log("McpServer core initialized with tools capability.");

	try {
		// 2. Initialize Supabase Client
		console.log("Initializing Supabase client...");
		const supabase = new SupabaseClientWrapper(config);
		console.log("Supabase client initialized successfully.");

		// 3. Introspect Schema
		console.log("Starting database schema introspection...");
		const introspector = new SchemaIntrospector(supabase);
		const toolDefinitions = await introspector.introspectSchema();
		console.log(
			`Schema introspection finished. Found ${toolDefinitions.length} potential tools.`,
		);

		// 4. Register Tools
		console.log("Registering tools with MCP server...");
		const factory = new MCPToolFactory(server, supabase);
		factory.registerTools(toolDefinitions);
		console.log("Tools registered successfully.");

		// --- Add hardcoded test tool ---
		console.log("Registering hardcoded test tool 'getInfo'...");
		server.tool(
			"getInfo",
			{
				// Simple schema with an optional string argument
				infoType: z
					.string()
					.optional()
					.describe("Optional type of info to request (e.g., 'version')"),
			},
			async (args) => {
				// Handler function
				console.log("Executing hardcoded tool 'getInfo' with args:", args);
				const infoType = args.infoType as string | undefined;
				let message = "";

				if (infoType === "version") {
					message = "Server Version: 1.0.0 (SupaToolifyMCP)";
				} else if (infoType) {
					message = `Requested info type: ${infoType}`;
				} else {
					message = "This is the SupaToolifyMCP server. Provide 'version' in infoType for details.";
				}

				// Return in MCP format
				return {
					content: [{ type: "text", text: message }],
				};
			},
		);
		console.log("Hardcoded test tool 'getInfo' registered.");
		// --- End of hardcoded test tool ---

		console.log("MCP Server instance created and configured successfully.");
		return server;
	} catch (error) {
		console.error("Failed to create and configure MCP Server:", error);
		// Propagate the error to be handled by the main execution logic
		if (error instanceof Error) {
			throw new Error(`MCP Server setup failed: ${error.message}`, {
				cause: error,
			});
		}
		throw new Error(
			"An unknown error occurred during MCP Server setup.",
		);
	}
} 