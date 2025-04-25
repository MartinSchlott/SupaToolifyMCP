-- SupaToolifyMCP Setup Script
--
-- This script creates the necessary schema and helper functions
-- in your Supabase PostgreSQL database required for SupaToolifyMCP
-- to introspect and expose MCP tools.
--
-- Execute this script manually via the Supabase SQL Editor or psql
-- before starting the SupaToolifyMCP server.
--
-- Requires permissions to create schemas and functions (e.g., postgres role).
-- The server itself will later need permissions to execute these functions
-- (likely via the service_role key).

-- 1. Create the dedicated schema (if it doesn't exist)
CREATE SCHEMA IF NOT EXISTS mcp_tools;
-- Allow the 'service_role' to use the 'mcp_tools' schema
GRANT USAGE ON SCHEMA mcp_tools TO service_role;

-- 2. Helper function to list relevant objects in the schema
CREATE OR REPLACE FUNCTION mcp_tools.rpc_get_schema_objects()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER -- Important: Allows function to query metadata catalogs consistently
SET search_path = pg_catalog, information_schema -- Limit search path for security/consistency
AS $$
DECLARE
  v_schema_name TEXT := 'mcp_tools';
  result JSONB;
BEGIN
  SELECT jsonb_agg(obj) INTO result
  FROM (
    -- Select Views
    SELECT
      jsonb_build_object(
        'object_name', table_name,
        'object_type', 'VIEW',
        'comment', obj_description((quote_ident(table_schema) || '.' || quote_ident(table_name))::regclass, 'pg_class')
      ) AS obj
    FROM information_schema.views
    WHERE table_schema = v_schema_name
    UNION ALL
    -- Select Functions
    SELECT
      jsonb_build_object(
        'object_name', r.routine_name,
        'object_type', 'FUNCTION',
        'comment', obj_description(p.oid, 'pg_proc')
      ) AS obj
    FROM information_schema.routines r
    -- Join pg_proc to get OID for obj_description and to filter out internal functions more reliably
    JOIN pg_proc p ON r.specific_name = p.proname || '_' || p.oid
    WHERE r.routine_schema = v_schema_name
      AND r.routine_type = 'FUNCTION'
      -- Basic filtering to exclude common internal/system functions
      AND r.routine_name NOT LIKE 'pg_%'
      AND r.routine_name NOT LIKE 'handle_%'
      AND r.routine_name NOT LIKE 'supabase_%'
      AND r.routine_name NOT LIKE 'graphql_%'
      AND r.routine_name NOT LIKE 'extension_%'
      -- Exclude functions defined in this script itself
      AND r.routine_name NOT IN ('rpc_get_schema_objects', 'rpc_get_object_details')
-- Ensure it's a regular function ('f'), not aggregate ('a'), window ('w'), or procedure ('p')
      AND p.prokind = 'f'
  ) AS objects;

  RETURN COALESCE(result, '[]'::jsonb);
END;
$$;

-- 3. Helper function to get details for a specific object
CREATE OR REPLACE FUNCTION mcp_tools.rpc_get_object_details(p_object_name TEXT, p_object_type TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, information_schema
AS $$
DECLARE
  v_schema_name TEXT := 'mcp_tools';
  result JSONB;
  v_oid OID;
  v_specific_name TEXT;
BEGIN
  IF p_object_type = 'VIEW' THEN
    -- Get View Details
    SELECT jsonb_build_object(
        'object_name', v.table_name,
        'object_type', 'VIEW',
        'comment', obj_description((quote_ident(v.table_schema) || '.' || quote_ident(v.table_name))::regclass, 'pg_class'),
        'columns', COALESCE(jsonb_agg(jsonb_build_object(
            'column_name', c.column_name,
            'data_type', c.udt_name, -- Use udt_name (underlying type)
            'is_nullable', CASE WHEN c.is_nullable = 'YES' THEN true ELSE false END,
            'comment', col_description((quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass, c.ordinal_position)
        ) ORDER BY c.ordinal_position), '[]'::jsonb)
      )
    INTO result
    FROM information_schema.views v
    LEFT JOIN information_schema.columns c ON v.table_schema = c.table_schema AND v.table_name = c.table_name -- Use LEFT JOIN in case view has no columns
    WHERE v.table_schema = v_schema_name AND v.table_name = p_object_name
    GROUP BY v.table_name, v.table_schema;

  ELSIF p_object_type = 'FUNCTION' THEN
    -- Get Function Details
    -- Find the specific routine name and OID for reliable lookups
    SELECT r.specific_name, p.oid INTO v_specific_name, v_oid
    FROM information_schema.routines r
    JOIN pg_proc p ON r.specific_name = p.proname || '_' || p.oid
    WHERE r.routine_schema = v_schema_name
      AND r.routine_name = p_object_name
      AND r.routine_type = 'FUNCTION'
    LIMIT 1; -- Assume non-overloaded functions in mcp_tools for simplicity

    IF v_specific_name IS NULL THEN
      RETURN jsonb_build_object('error', 'Function details not found or ambiguous');
    END IF;

    SELECT jsonb_build_object(
        'object_name', p_object_name,
        'object_type', 'FUNCTION',
        'comment', obj_description(v_oid, 'pg_proc'),
        'parameters', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                 'parameter_name', param.parameter_name,
                 'data_type', param.udt_name,
                 'position', param.ordinal_position
                 -- Parameter comments are omitted due to complexity in reliable SQL querying
             ) ORDER BY param.ordinal_position)
             FROM information_schema.parameters param
             WHERE param.specific_schema = v_schema_name
               AND param.specific_name = v_specific_name
               AND param.parameter_mode = 'IN' -- Only input parameters
         ), '[]'::jsonb),
        'return_type', (SELECT pt.typname FROM pg_type pt WHERE pt.oid = p.prorettype), -- Get return type name from pg_type
        'returns_set', p.proretset -- From pg_proc
      )
    INTO result
    FROM pg_proc p -- Use pg_proc directly for return type oid and proretset
    WHERE p.oid = v_oid;

  ELSE
    result := jsonb_build_object('error', 'Unknown object type specified');
  END IF;

  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;

-- 4. Grant Permissions (Adjust role name if necessary)
-- The role used by SupaToolifyMCP (likely 'service_role') needs execute permission.
-- GRANT EXECUTE ON FUNCTION mcp_tools.rpc_get_schema_objects() TO service_role;
-- GRANT EXECUTE ON FUNCTION mcp_tools.rpc_get_object_details(TEXT, TEXT) TO service_role;

-- Optional: Revoke default public execute permissions if desired for security
-- REVOKE EXECUTE ON FUNCTION mcp_tools.rpc_get_schema_objects() FROM PUBLIC;
-- REVOKE EXECUTE ON FUNCTION mcp_tools.rpc_get_object_details(TEXT, TEXT) FROM PUBLIC;

-- End of Setup Script