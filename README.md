# SupaToolifyMCP

A dynamic Model Context Protocol (MCP) server that automatically discovers and exposes Supabase PostgreSQL views and functions as MCP tools for AI agents.

## Overview

SupaToolifyMCP acts as a bridge between your Supabase PostgreSQL database and any MCP-compatible client (like AI agents or IDE extensions). Instead of manually defining MCP tools, this server introspects a dedicated schema (specified in config, defaults to `mcp_tools`) in your Supabase database at startup.

It automatically identifies:
- **PostgreSQL Views:** Each view found in the target schema is exposed as a **parameterless** MCP tool. The tool's name is derived from the view name, and its return schema is dynamically generated based on the view's columns and their types. Database comments on columns are used as descriptions.
- **PostgreSQL Functions:** Each function found in the target schema is exposed as an MCP tool. The tool's name, parameters, and return schema are dynamically generated based on the function's signature and types. Database comments on the function and its parameters are used for descriptions.

This approach allows developers to define agent capabilities directly within their database schema, simplifying the creation and maintenance of MCP tools. The server can communicate via **HTTP** or **stdio**, selectable via configuration.

## Features

SupaToolifyMCP automatically generates MCP tools based on your Supabase PostgreSQL schema, simplifying the process of exposing database operations to AI agents and other MCP clients. Key features include:

* **Automatic Tool Discovery:** Scans a dedicated PostgreSQL schema (specified in config, defaults to `mcp_tools`) in your Supabase project at startup.
* **View-to-Tool Mapping:** Every PostgreSQL VIEW found within the target schema is automatically exposed as a **parameterless** MCP tool.
    * *Tool Naming:* The MCP tool name is derived directly from the view name (e.g., `my_view_name` becomes `myViewName`).
    * *Return Schema:* The tool's return JSON schema is dynamically generated based on the view's columns and their data types (focusing on JSON-compatible types).
    * *Descriptions:* `COMMENT` statements on the view's columns in the database are used as `description` fields in the return JSON schema.
* **Function-to-Tool Mapping:** Every PostgreSQL FUNCTION found within the target schema is automatically exposed as an MCP tool.
    * *Tool Naming:* The MCP tool name is derived directly from the function name.
    * *Parameters & Return Schema:* The tool's input parameters (as a Zod schema) and return value JSON schemas are dynamically generated based on the function's signature.
    * *Descriptions:* `COMMENT` statements on the function itself and its parameters are used as `description` fields.
* **Dynamic Schema Generation:** Leverages PostgreSQL's metadata catalogs (via helper RPC functions defined in `mcp_tools_setup.sql`) to generate accurate Zod/JSON schemas.
* **Configurable & Flexible:** Uses a JSON configuration file for Supabase credentials, target schema, and choice of transport (HTTP or stdio).
* **Dual Transport:** Supports both stateless, streamable HTTP (via `express`) and stdio communication modes for MCP interactions.
* **SDK-Based:** Built upon the official `@modelcontextprotocol/sdk` for robust MCP handling.
* **Focus on Simplicity for Agents:** Prioritizes clear, single-purpose tools.

## Configuration

SupaToolifyMCP is configured via a JSON file, whose path is provided as a command-line argument upon starting the server.

* **Command-Line Argument:**
    ```bash
    node your_server_entrypoint.js --config ./path/to/your/config.json
    ```

* **Configuration File (`config.json` Example):**
    ```json
    {
      "supabaseUrl": "YOUR_SUPABASE_URL",
      "supabaseServiceKey": "YOUR_SUPABASE_SERVICE_KEY",
      "schemaToScan": "mcp_tools",
      "transport": "http",
      "httpPort": 3123
    }
    ```
    * `supabaseUrl` (string, required): Your project's Supabase URL.
    * `supabaseServiceKey` (string, required): Your project's `service_role` key. **Keep secure!**
    * `schemaToScan` (string, optional, defaults to `"mcp_tools"`): The schema containing VIEWS/FUNCTIONS to expose.
    * `transport` (string, optional, defaults to `"http"`): Communication mode. Either `"http"` or `"stdio"`.
    * `httpPort` (number, optional, defaults to `3123`): Port for the HTTP server (used only if `transport` is `"http"`).

* **Database Setup:** Ensure the helper functions defined in `mcp_tools_setup.sql` have been executed in your Supabase database, and place your views/functions in the schema specified by `schemaToScan`.

## Usage / Example

Once SupaToolifyMCP is running (in either HTTP or stdio mode, based on the `transport` setting in your `config.json`) and connected to Supabase, it exposes the discovered MCP tools.

An MCP client connects via the chosen transport (e.g., POST requests to `/mcp` for HTTP, or piping JSON-RPC messages via stdio).

**Hypothetical Scenario:**

Let's assume you have the following objects defined in your `mcp_tools` schema in Supabase:

1.  **A View:**
    ```sql
    -- in Supabase SQL Editor
    CREATE VIEW mcp_tools.active_user_profiles AS
      SELECT id, username, email, last_login
      FROM public.users -- Assuming a 'users' table exists in public schema
      WHERE status = 'active'
      ORDER BY last_login DESC
      LIMIT 10;

    COMMENT ON VIEW mcp_tools.active_user_profiles IS 'Retrieves the top 10 most recently active user profiles.';
    COMMENT ON COLUMN mcp_tools.active_user_profiles.username IS 'The unique username.';
    COMMENT ON COLUMN mcp_tools.active_user_profiles.last_login IS 'Timestamp of the last login.';
    -- Add comments for other columns as needed...
    ```

2.  **A Function:**
    ```sql
    -- in Supabase SQL Editor
    CREATE FUNCTION mcp_tools.add_note_to_user(p_user_id UUID, p_note_text TEXT)
    RETURNS JSONB -- e.g., returning a success status or the new note ID
    LANGUAGE plpgsql
    AS $$
    DECLARE
      new_note_id INT;
    BEGIN
      INSERT INTO public.user_notes (user_id, note) -- Assuming 'user_notes' table
      VALUES (p_user_id, p_note_text)
      RETURNING id INTO new_note_id;
      RETURN jsonb_build_object('success', true, 'noteId', new_note_id);
    END;
    $$;

    COMMENT ON FUNCTION mcp_tools.add_note_to_user IS 'Adds a new administrative note to a specific user profile.';
    COMMENT ON PARAMETER mcp_tools.add_note_to_user.p_user_id IS 'The UUID of the target user.';
    COMMENT ON PARAMETER mcp_tools.add_note_to_user.p_note_text IS 'The content of the note to add.';
    ```

**Expected MCP Tools:**

Based on the schema above, an MCP client connected to SupaToolifyMCP would discover (among others) the following tools:

1.  **Tool: `activeUserProfiles`** (Generated from the view)
    * **Description:** "Retrieves the top 10 most recently active user profiles." (From view comment)
    * **Parameters:** None (as it's generated from a view)
    * **Returns:** `object` with a property `data` which is an `array` of objects. The object schema would be dynamically generated, looking something like this:
        ```json
        {
          "type": "object",
          "properties": {
            "id": { "type": "string", "format": "uuid" }, // Assuming UUID maps to string
            "username": { "type": "string", "description": "The unique username." },
            "email": { "type": "string", "format": "email" },
            "last_login": { "type": "string", "format": "date-time", "description": "Timestamp of the last login." }
          },
          "required": ["id", "username", "email"] // Based on NOT NULL constraints in the underlying table, if discoverable
        }
        ```
        *(Note: The exact type mapping (e.g., UUID, timestamp) and requirement inference depends on the implementation details outlined in IMPLEMENTATION_PLAN.md.)*

2.  **Tool: `addNoteToUser`** (Generated from the function)
    * **Description:** "Adds a new administrative note to a specific user profile." (From function comment)
    * **Parameters:** Dynamically generated Zod/JSON schema based on function arguments:
        ```json
        {
          "type": "object",
          "properties": {
            "p_user_id": { "type": "string", "format": "uuid", "description": "The UUID of the target user." },
            "p_note_text": { "type": "string", "description": "The content of the note to add." }
          },
          "required": ["p_user_id", "p_note_text"] // Assuming arguments are implicitly required
        }
        ```
    * **Returns:** `object` (based on the function's `RETURNS JSONB`), likely similar to:
        ```json
        {
          "type": "object",
          "properties": {
            "success": { "type": "boolean" },
            "noteId": { "type": "integer" }
          }
        }
        ```

This section aims to illustrate the core mechanic: Define views/functions with comments in the `mcp_tools` schema, and SupaToolifyMCP makes them available as typed and described MCP tools with minimal fuss.