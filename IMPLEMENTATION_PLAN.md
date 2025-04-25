# SupaToolifyMCP - Implementation Plan

Version: Draft 1.0 (Based on discussion)

This document outlines the technical implementation plan for the SupaToolifyMCP server, based on the vision described in `README.md`. It follows the iterative approach outlined in the project's `specsguide.txt`[cite: 2, 13].

## 1. Recap / Goal

SupaToolifyMCP is an MCP server that dynamically discovers PostgreSQL views and functions within a specified schema in a Supabase database. It exposes these database objects as MCP tools (parameterless for views, parameterized for functions), using database comments for descriptions and dynamically generating Zod/JSON schemas for parameters and return types. Configuration (Supabase credentials, schema to scan, transport mode) is provided via a JSON file specified at startup. The server supports both HTTP and stdio transports for MCP communication, selectable via the configuration file.

## 2. Core Modules

The server is broken down into the following logical modules[cite: 6, 7]:

1.  **`ConfigLoader`**
    * **Responsibility:** Loads the configuration from the JSON file specified via the `--config` command-line argument. Validates required fields (`supabaseUrl`, `supabaseServiceKey`) and provides type-safe access to all configuration values (`supabaseUrl`, `supabaseServiceKey`, `schemaToScan` [default `mcp_tools`], `transport` ['http' or 'stdio', default 'http'], `httpPort` [default 3123]).

2.  **`SupabaseClientWrapper`**
    * **Responsibility:** Initializes and holds the `supabase-js` client instance using credentials from the config. Provides methods for calling Supabase RPC functions (metadata helpers) and executing `SELECT * FROM ...` queries for view-based tools. Handles basic Supabase connection management/error handling.

3.  **`SchemaIntrospector`**
    * **Responsibility:** Orchestrates the discovery of relevant database objects within the configured `schemaToScan`.
    * Uses `SupabaseClientWrapper` to call `mcp_tools.rpc_get_schema_objects()` to list views/functions.
    * For each object, uses `SupabaseClientWrapper` to call `mcp_tools.rpc_get_object_details(...)` to retrieve detailed metadata (columns, parameters, types, comments).
    * Structures the raw metadata into a consistent internal format suitable for the `MCPToolFactory`.

4.  **`MCPToolFactory`**
    * **Responsibility:** Transforms the structured metadata from `SchemaIntrospector` into calls to `server.tool()` on the `McpServer` instance provided by the `@modelcontextprotocol/sdk`.
    * Dynamically generates the MCP tool name (e.g., snake_case to camelCase).
    * Dynamically generates Zod schemas for function parameters based on PostgreSQL types and parameter metadata (including descriptions from comments). Views have no input schema.
    * Dynamically generates the `async` handler function for `server.tool()`. This handler will:
        * Use `SupabaseClientWrapper` to execute the underlying database operation (RPC call for functions, `SELECT *` for views).
        * Format the result into the required MCP format (`{ content: [...] }`).
        * Handle execution errors appropriately.
    * Needs logic to map PostgreSQL types (e.g., `text`, `int8`, `uuid`, `timestampz`, `jsonb`) to corresponding Zod types (`z.string()`, `z.number().int()`, `z.string().uuid()`, `z.string().datetime()`, `z.any()` or more specific `z.object`/`z.array`).

5.  **`createMcpServer Function`** (Structure based on user's MCP guide)
    * **Responsibility:** Contains the core logic that runs during server startup and per HTTP request (in stateless mode).
    * Initializes the `McpServer` instance from `@modelcontextprotocol/sdk`.
    * Invokes the `SchemaIntrospector` and `MCPToolFactory` to dynamically populate the `McpServer` instance with tools by calling `server.tool()` for each discovered object.
    * Returns the configured `McpServer` instance.

6.  **`MCPHttpListener`** (Based on user's MCP guide)
    * **Responsibility:** Implements the stateless, streamable HTTP transport using `express` and `StreamableHTTPServerTransport`.
    * Listens on the configured `httpPort`.
    * For each incoming `/mcp` POST request:
        * Calls `createMcpServer()` to get a configured server instance.
        * Creates a new `StreamableHTTPServerTransport`.
        * Connects server and transport (`server.connect(transport)`).
        * Handles the request (`transport.handleRequest(...)`).
        * Manages cleanup on connection close.

7.  **`MCPStdioListener`** (Based on user's MCP guide)
    * **Responsibility:** Implements the stdio transport using `StdioServerTransport`.
    * Called once at startup if `transport` is 'stdio'.
    * Calls `createMcpServer()` once.
    * Creates a `StdioServerTransport`.
    * Connects server and transport (`server.connect(transport)`).
    * Listens on stdin/writes to stdout.

8.  **`MainExecution`** (Entry Point)
    * **Responsibility:** Parses command-line arguments (`--config`).
    * Calls `ConfigLoader` to load and validate the configuration.
    * Based on the `transport` value in the config, calls either `runHttpServer` (which uses `MCPHttpListener`) or `runStdioServer` (which uses `MCPStdioListener`).
    * Handles top-level errors during startup.

## 3. Key Interfaces (To be defined)

* Data structure returned by `SchemaIntrospector` to `MCPToolFactory`.
* Interface for `SupabaseClientWrapper` methods (e.g., `callRpc(functionName, params)`, `selectFromView(viewName)`).

## 4. Supabase Helper Functions (RPC)

The `SchemaIntrospector` relies on specific PostgreSQL functions being available in the target Supabase database (within the schema defined by `schemaToScan`).

**Important:** These SQL functions must be created manually in your Supabase database **before** running SupaToolifyMCP. The required `CREATE FUNCTION` statements can be found in the separate `supabase_setup.sql` file (see section below).

The following functions are required:

### 4.1. `rpc_get_schema_objects()`
* **Purpose:** Lists all VIEWS and FUNCTIONS within the target schema.
* **Parameters:** None.
* **Returns:** `JSONB` - Array of objects (`{object_name, object_type, comment}`).

### 4.2. `rpc_get_object_details(p_object_name TEXT, p_object_type TEXT)`
* **Purpose:** Retrieves detailed metadata for a specific view or function.
* **Parameters:** `p_object_name` (TEXT), `p_object_type` (TEXT: 'VIEW' or 'FUNCTION').
* **Returns:** `JSONB` - Single object containing details (columns with comments for views; parameters, return type, comments for functions). *(Refer to previous discussion for exact structure)*.

## 5. Startup Sequence / Data Flow

1.  `MainExecution` starts.
2.  `ConfigLoader` loads and validates `config.json` specified via `--config`.
3.  Based on `config.transport`:
    * **If 'http':** `MainExecution` calls `runHttpServer`. `MCPHttpListener` starts listening.
        * *On incoming request:* `MCPHttpListener` calls `createMcpServer`.
            * `createMcpServer` initializes `McpServer`.
            * Calls `SchemaIntrospector` (which uses `SupabaseClientWrapper` to call RPC functions).
            * Calls `MCPToolFactory` to populate `McpServer` with tools (`server.tool(...)`).
            * Returns `McpServer`.
        * `MCPHttpListener` creates `StreamableHTTPServerTransport`, connects, handles request.
    * **If 'stdio':** `MainExecution` calls `runStdioServer`.
        * `runStdioServer` calls `createMcpServer` *once*.
            * (Same introspection/tool population logic as above).
        * `runStdioServer` creates `StdioServerTransport`, connects. Server now listens on stdio.

## 6. Key Data Structures (To be defined)

* Internal representation of view/function metadata after introspection.
* Structure for mapping PG types to Zod types.

## 7. Error Handling (To be defined)

* Strategy for handling errors during config loading, schema introspection, tool generation, and tool execution.
* Mapping database/internal errors to appropriate MCP error responses.

## 8. Technology Stack / Dependencies

* Runtime: Node.js (LTS version)
* Language: TypeScript
* Core MCP: `@modelcontextprotocol/sdk`
* Schema Validation: `zod`
* Supabase Client: `supabase-js`
* HTTP Server (if http transport): `express`
* Package Manager: `npm` 