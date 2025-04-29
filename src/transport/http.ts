import express, { Request, Response, RequestHandler } from "express";
import http from "http"; // Import http module for the server instance
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AppConfig } from "../config.js"; // Assuming correct path
import { createMcpServer } from "../server.js"; // Assuming correct path
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Runs the MCP server using the Streamable HTTP transport with persistent instances.
 * Creates the McpServer and Transport instances once upon startup for efficiency.
 *
 * @param config - The application configuration.
 * @returns A promise that resolves when the server starts listening, or rejects on error.
 */
export async function runHttpServer(config: AppConfig): Promise<void> {
    const app = express();
    app.use(express.json());

    const port = config.httpPort;

    console.log(`Setting up HTTP transport on port ${port}...`);

    // --- SETUP MCP SERVER AND TRANSPORT ONCE ---
    console.log("Creating MCP Server and Transport instances...");
    let server: McpServer | null = null; // Use null for better type safety
    let transport: StreamableHTTPServerTransport | null = null;

    try {
        // Create server and transport instances using the provided config
        server = await createMcpServer(config);
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // Keep the SDK transport stateless
        });

        // Connect server and transport
        await server.connect(transport);
        console.log("MCP Server connected to transport.");
    } catch (error) {
        console.error("FATAL: Could not initialize MCP Server or Transport:", error);
        // If setup fails, we can't start the server, so throw the error
        // to be caught by the caller or main() function.
        throw error; // Propagate the error
    }
    // ---------------------------------------------

    // POST handler for MCP requests - uses the existing instances
    const mcpHandler: RequestHandler = async (req, res) => {
        const requestId = req.body?.id ?? null; // Get request ID
        console.log(`Received POST /mcp request (ID: ${requestId}).`);

        if (!transport || !server) {
            // Safety check - should not happen if initialization succeeded
            console.error(`Error handling request ${requestId}: Transport or Server not initialized.`);
            res.status(500).json({
                jsonrpc: "2.0",
                error: {
                    code: -32603,
                    message: "Internal server error: Server components not ready",
                },
                id: requestId,
            });
            return;
        }

        try {
            // Handle the actual MCP request payload using the persistent transport
            await transport.handleRequest(req, res, req.body);
            console.log(`MCP request handled by transport (ID: ${requestId}).`);
        } catch (error) {
            console.error(`Error handling MCP POST request (ID: ${requestId}):`, error);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: {
                        code: -32603,
                        message: `Internal server error: ${error instanceof Error ? error.message : "Unknown error"}`,
                    },
                    id: requestId,
                });
            } else {
                console.error(
                    `Headers already sent for request ${requestId}, cannot send error response. Ending response.`,
                );
                if (!res.writableEnded) {
                    res.end();
                }
            }
        }
    };

    app.post("/mcp", mcpHandler);

    // Keep your existing GET and DELETE handlers
    app.get("/mcp", (req: Request, res: Response) => {
        console.log("Received GET /mcp request (Method Not Allowed)");
        // Use 405 Method Not Allowed as it's semantically more correct than 404 for existing path with wrong method
        res.status(405).json({
            jsonrpc: "2.0",
            error: { code: -32601, message: "Method Not Allowed" },
            id: null,
        });
    });

    app.delete("/mcp", (req: Request, res: Response) => {
        console.log("Received DELETE /mcp request (Method Not Allowed)");
        res.status(405).json({
            jsonrpc: "2.0",
            error: { code: -32601, message: "Method Not Allowed" },
            id: null,
        });
    });

    // Start listening - Simplified using async/await and try/catch
    // The function now directly returns Promise<void> via async.
    return new Promise<void>((resolve, reject) => {
        const httpServer: http.Server = app.listen(port, () => {
            console.log(
                `SupaToolifyMCP HTTP Server listening on http://localhost:${port}/mcp`,
            );
            resolve(); // Resolve the promise once listening starts
        });

        httpServer.on("error", (error) => {
            console.error(`Failed to start HTTP server on port ${port}:`, error);
            reject(error); // Reject the promise on server error
        });

        // Graceful shutdown handling integrated here
        const shutdown = async (signal: string) => {
            console.log(`${signal} signal received: closing HTTP server and MCP components.`);
            httpServer.close(async (err) => {
                if (err) {
                    console.error("Error closing HTTP server:", err);
                }
                try {
                    console.log("Closing MCP transport...");
                    await transport?.close();
                    console.log("Closing MCP server...");
                    await server?.close();
                    console.log('MCP cleanup finished.');
                    process.exit(err ? 1 : 0);
                } catch (shutdownErr) {
                    console.error("Error during MCP cleanup:", shutdownErr);
                    process.exit(1);
                }
            });
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    });
}