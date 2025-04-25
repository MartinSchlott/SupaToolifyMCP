import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AppConfig } from "../config.js";
import { createMcpServer } from "../server.js";

/**
 * Runs the MCP server using the stdio transport.
 * Creates a single server instance and connects it to stdin/stdout.
 * Introspection happens once at startup.
 *
 * @param config - The application configuration.
 * @returns A promise that resolves when the server is connected, or rejects on error.
 */
export async function runStdioServer(config: AppConfig): Promise<void> {
	console.log("Setting up stdio transport...");

	try {
		// Create the server instance *once* for stdio transport
		// Introspection will run once during this creation.
		const server = await createMcpServer(config);

		// Create the stdio transport
		const transport = new StdioServerTransport();

		// Connect server and transport - this starts the listening loop on stdin/stdout
		await server.connect(transport);

		console.log(
			"SupaToolifyMCP Server connected via stdio. Listening for requests...",
		);

		// Keep the process alive. The StdioServerTransport likely handles the read/write loop.
		// We might need more robust handling for shutdown signals in a real application.
		// For now, we assume the connection holds the process open.
		// await new Promise(() => {}); // One way to wait indefinitely if needed
	} catch (error) {
		console.error("Failed to start or run MCP server via stdio:", error);
		// Propagate the error to be handled by the main execution logic
		if (error instanceof Error) {
			throw new Error(`MCP stdio server failed: ${error.message}`, {
				cause: error,
			});
		}
		throw new Error(
			"An unknown error occurred during MCP stdio server setup or execution.",
		);
	}
} 