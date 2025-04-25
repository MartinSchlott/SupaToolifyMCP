import { SupabaseClientWrapper } from "./supabase.js";
import { z } from "zod";
import { camelCase } from "change-case"; // Need to install change-case

// --- Define ACTUAL raw structures from RPC calls based on mcp_tools_setup.sql ---

// Structure for rpc_get_schema_objects result items
const schemaObjectSchema = z.object({
	object_name: z.string(),
	object_type: z.enum(["VIEW", "FUNCTION"]),
	comment: z.string().nullable(), // obj_description returns null if no comment
});
type RawSchemaObject = z.infer<typeof schemaObjectSchema>;

// Structure for view column details within rpc_get_object_details
const columnDetailSchema = z.object({
	column_name: z.string(),
	data_type: z.string(), // Based on udt_name
	is_nullable: z.boolean(), // Based on CASE statement
	comment: z.string().nullable(), // col_description returns null if no comment
});

// Structure for function parameter details within rpc_get_object_details
const parameterDetailSchema = z.object({
	parameter_name: z.string(),
	data_type: z.string(), // Based on udt_name
	position: z.number().int(), // Based on ordinal_position
	// Note: parameter comments are NOT included by the SQL function
});

// Combined structure for rpc_get_object_details result
// Uses optional fields as only one set (columns or function details) will be present beyond common fields
const objectDetailsSchema = z.object({
	// Common fields
	object_name: z.string(),
	object_type: z.enum(["VIEW", "FUNCTION"]),
	comment: z.string().nullable(),
	// View specific
	columns: z.array(columnDetailSchema).optional(), // Only present for VIEWs
	// Function specific
	parameters: z.array(parameterDetailSchema).optional(), // Only present for FUNCTIONs
	return_type: z.string().optional(), // Only present for FUNCTIONs
	returns_set: z.boolean().optional(), // Only present for FUNCTIONs
});
type RawObjectDetails = z.infer<typeof objectDetailsSchema>;

// --- Define the structured internal format for the MCPToolFactory ---

export type IntrospectedParameter = {
	name: string; // Original PG name (e.g., p_user_id)
	toolParamName: string; // Camel-cased for tool (e.g., pUserId)
	pgType: string;
	description: string | undefined; // We'll try to use the function comment if param comment isn't available
};

export type IntrospectedColumn = {
	name: string; // Original PG name
	pgType: string;
	isNullable: boolean; // Added is_nullable info
	description: string | undefined;
};

// Combined definition for MCPToolFactory
export type IntrospectedToolDefinition = {
	toolName: string; // Camel-cased name for the MCP tool
	pgName: string; // Original PG object name
	type: "VIEW" | "FUNCTION";
	description: string | undefined;
	parameters: IntrospectedParameter[]; // Empty for views
	pgReturnType: string | undefined; // PG return type for functions (renamed for clarity)
	pgReturnsSet: boolean | undefined; // Whether the function returns SETOF
	columns: IntrospectedColumn[]; // Columns for views (used for return schema)
};

/**
 * Introspects the Supabase schema using helper RPC functions to discover
 * views and functions suitable for exposing as MCP tools.
 */
export class SchemaIntrospector {
	private supabase: SupabaseClientWrapper;

	constructor(supabaseClient: SupabaseClientWrapper) {
		this.supabase = supabaseClient;
	}

	/**
	 * Fetches schema objects and their details, transforming them into
	 * definitions ready for the MCPToolFactory.
	 * @returns A promise resolving to an array of IntrospectedToolDefinition.
	 */
	async introspectSchema(): Promise<IntrospectedToolDefinition[]> {
		console.log("Starting schema introspection...");
		// Fetch list of objects first
		let rawObjects: RawSchemaObject[] = [];
		try {
			const result = await this.supabase.callRpc<unknown>(
				"rpc_get_schema_objects",
			);
			// Use safeParse for better error handling
			const parsedResult = z.array(schemaObjectSchema).safeParse(result);
			if (!parsedResult.success) {
				console.error(
					"Failed to parse result from rpc_get_schema_objects:",
					parsedResult.error.issues,
				);
				// Decide whether to throw or return empty array
				return [];
			}
			rawObjects = parsedResult.data;
			console.log(`Found ${rawObjects.length} objects via RPC.`);
		} catch (error) {
			console.error("Failed to fetch schema objects via RPC:", error);
			// Throw or return empty on failure? Let's return empty for now.
			return [];
		}

		const toolDefinitions: IntrospectedToolDefinition[] = [];

		// Fetch details for each object
		for (const obj of rawObjects) {
			try {
				console.log(
					`Fetching details for ${obj.object_type}: ${obj.object_name}`,
				);
				const details = await this.fetchObjectDetails(
					obj.object_name,
					obj.object_type,
				);

				if (!details) {
					console.warn(
						`Could not fetch or parse details for ${obj.object_type} ${obj.object_name}, skipping.`,
					);
					continue;
				}

				// Pass the validated details to the transformation function
				toolDefinitions.push(this.transformToToolDefinition(details));
			} catch (error) {
				console.error(
					`Failed to process ${obj.object_type} ${obj.object_name}:`,
					error,
				);
				// Continue processing other objects on error
			}
		}

		console.log(
			`Schema introspection completed. Found ${toolDefinitions.length} potential tools.`,
		);
		return toolDefinitions;
	}

	private async fetchSchemaObjects(): Promise<RawSchemaObject[]> {
		try {
			const result = await this.supabase.callRpc<unknown>(
				"rpc_get_schema_objects",
			);
			// Validate the result array
			const parsedResult = z.array(schemaObjectSchema).parse(result);
			console.log(`Found ${parsedResult.length} objects via RPC.`);
			return parsedResult;
		} catch (error) {
			console.error("Failed to fetch schema objects via RPC:", error);
			throw new Error(
				`Failed to execute rpc_get_schema_objects: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	private async fetchObjectDetails(
		objectName: string,
		objectType: "VIEW" | "FUNCTION",
	): Promise<RawObjectDetails | null> {
		try {
			const result = await this.supabase.callRpc<unknown>(
				"rpc_get_object_details",
				{
					p_object_name: objectName,
					p_object_type: objectType,
				},
			);

			if (!result || typeof result !== "object") {
				console.warn(
					`RPC rpc_get_object_details returned invalid data for ${objectType} ${objectName}`,
					result,
				);
				return null;
			}

			// Use safeParse for robust validation
			const parseResult = objectDetailsSchema.safeParse(result);
			if (!parseResult.success) {
				console.error(
					`Validation failed for rpc_get_object_details result (${objectName}):`,
					parseResult.error.issues,
				);
				return null; // Skip object if validation fails
			}
			return parseResult.data;
		} catch (error) {
			console.error(
				`Failed to fetch details for ${objectType} ${objectName} via RPC:`,
				error,
			);
			return null; // Return null instead of throwing to allow processing other objects
		}
	}

	private transformToToolDefinition(
		details: RawObjectDetails,
	): IntrospectedToolDefinition {
		const toolName = camelCase(details.object_name);
		const description = details.comment ?? undefined; // Use nullish coalescing

		let parameters: IntrospectedParameter[] = [];
		let columns: IntrospectedColumn[] = [];
		let pgReturnType: string | undefined = undefined;
		let pgReturnsSet: boolean | undefined = undefined;

		if (details.object_type === "FUNCTION" && details.parameters) {
			parameters = details.parameters
				// No need to filter by param_mode here as SQL already does
				.map((p) => ({
					name: p.parameter_name,
					toolParamName: camelCase(p.parameter_name),
					pgType: p.data_type,
					// Since param comments aren't available, maybe use function comment as fallback?
					description: description, // Or leave undefined? Let's use function desc for now.
				}));
			pgReturnType = details.return_type;
			pgReturnsSet = details.returns_set;
		} else if (details.object_type === "VIEW" && details.columns) {
			columns = details.columns.map((c) => ({
				name: c.column_name,
				pgType: c.data_type,
				isNullable: c.is_nullable, // Include nullability info
				description: c.comment ?? undefined,
			}));
		}

		return {
			toolName,
			pgName: details.object_name,
			type: details.object_type,
			description,
			parameters,
			pgReturnType,
			pgReturnsSet,
			columns,
		};
	}
} 