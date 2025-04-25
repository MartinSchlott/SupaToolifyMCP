import express, { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AppConfig } from "../config.js";
import { createMcpServer } from "../server.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Runs the MCP server using the stateless Streamable HTTP transport.
 * Creates a new server instance for each incoming request to ensure
 * dynamic tool discovery reflects the latest database state.
 *
 * @param config - The application configuration.
 * @returns A promise that resolves when the server starts listening, or rejects on error.
 */
export function runHttpServer(config: AppConfig): Promise<void> {
	const app = express();
	app.use(express.json());

	const port = config.httpPort;

	console.log(`Setting up HTTP transport on port ${port}...`);

	// Stateless POST handler for MCP requests
	app.post("/mcp", async (req: Request, res: Response) => {
		console.log(
			`Received POST /mcp request. Creating fresh server instance...`,
		);

		// Explicitly type variables and initialize
		let server: McpServer | undefined = undefined;
		let transport: StreamableHTTPServerTransport | undefined = undefined;

		try {
			// Dynamically create server and transport for this request
			server = await createMcpServer(config); // Create server (includes introspection)
			transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined, // Stateless
			});

			// Connect server and transport
			await server.connect(transport);
			console.log("Server and transport connected for request.");

			// Handle the actual MCP request payload
			// handleRequest manages sending the response via `res`
			await transport.handleRequest(req, res, req.body);
			console.log("MCP request handled by transport.");

			// Setup cleanup on connection close
			res.on("close", () => {
				console.log("HTTP connection closed. Cleaning up server/transport.");
				// Important: Close transport and server to release resources
				transport?.close();
				server?.close();
			});
		} catch (error) {
			console.error("Error handling MCP POST request:", error);
			// Ensure server/transport are cleaned up even if connection setup failed
			transport?.close();
			server?.close();
			if (!res.headersSent) {
				res.status(500).json({
					jsonrpc: "2.0",
					error: {
						code: -32603, // JSON-RPC Internal error
						message: `Internal server error: ${
							error instanceof Error ? error.message : "Unknown error"
						}`,
					},
					id: req.body?.id ?? null, // Try to include request ID if available
				});
			} else {
				// If headers sent, response stream might be broken, log and end
				console.error("Headers already sent, cannot send error response.");
				res.end();
			}
		}
	});

	// Placeholder for GET - MCP Streamable HTTP doesn't typically use GET for main comms
	app.get("/mcp", (req: Request, res: Response) => {
		console.log("Received GET /mcp request (Method Not Allowed)");
		res.status(405).json({
			jsonrpc: "2.0",
			error: { code: -32601, message: "Method not found" }, // Method not found is more accurate than Not Allowed here
			id: null,
		});
	});

	// Placeholder for DELETE - MCP Streamable HTTP doesn't typically use DELETE
	app.delete("/mcp", (req: Request, res: Response) => {
		console.log("Received DELETE /mcp request (Method Not Allowed)");
		res.status(405).json({
			jsonrpc: "2.0",
			error: { code: -32601, message: "Method not found" },
			id: null,
		});
	});

	// Start listening - wrap in promise for async handling in main()
	return new Promise((resolve, reject) => {
		const httpServer = app.listen(port, () => {
			console.log(
				`SupaToolifyMCP HTTP Server listening on http://localhost:${port}/mcp`,
			);
			resolve();
		});

		httpServer.on("error", (error) => {
			console.error(`Failed to start HTTP server on port ${port}:`, error);
			reject(error);
		});
	});
} 