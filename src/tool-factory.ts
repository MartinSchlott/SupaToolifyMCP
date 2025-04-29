import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	ServerRequest,
	ServerNotification,
	TextContent,
	CallToolResult
} from "@modelcontextprotocol/sdk/types.js";
import { z, ZodTypeAny } from "zod";
import {
	IntrospectedColumn,
	IntrospectedParameter,
	IntrospectedToolDefinition,
} from "./introspection.js";
import { SupabaseClientWrapper } from "./supabase.js";
import { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

/**
 * Maps PostgreSQL type names to Zod schema types.
 * Handles basic types, arrays, numeric precision, and nullability.
 *
 * @param pgType - The PostgreSQL type name (e.g., 'int4', 'varchar', '_uuid').
 * @param isNullable - Whether the corresponding DB column is nullable.
 * @returns A ZodTypeAny representing the schema type.
 */
function mapPgTypeToZod(pgType: string, isNullable: boolean): ZodTypeAny {
	let baseType: ZodTypeAny;

	// Normalize and handle array types first
	const isArray = pgType.startsWith("_") || pgType.endsWith("[]");
	const elementType = isArray
		? pgType.startsWith("_")
			? pgType.substring(1) // Handle types like _int4, _uuid
			: pgType.slice(0, -2) // Handle types like text[]
		: pgType;

	const normalizedElementType = elementType.toLowerCase().replace(/ /g, "");

	switch (normalizedElementType) {
		case "text":
		case "varchar":
		case "char":
		case "name":
		case "bpchar": // Blank-padded char
			baseType = z.string();
			break;
		case "int":
		case "integer":
		case "int4":
		case "smallint": // int2
		case "serial": // int4 auto-increment
		case "smallserial": // int2 auto-increment
			baseType = z.number().int();
			break;
		case "bigint": // int8
		case "bigserial": // int8 auto-increment
		case "int8":
			baseType = z.bigint(); // Use native BigInt
			break;
		case "numeric":
		case "decimal":
			// Represent high-precision numbers as strings to avoid precision loss
			baseType = z.string().regex(/^-?\d+(\.\d+)?$/, {
				message: "Invalid numeric string",
			});
			break;
		case "real": // float4
		case "float4":
		case "doubleprecision": // float8
		case "float8":
			baseType = z.number();
			break;
		case "boolean": // bool
		case "bool":
			baseType = z.boolean();
			break;
		case "uuid":
			baseType = z.string().uuid();
			break;
		case "date":
			// Expects 'YYYY-MM-DD'
			baseType = z.string().date("Invalid date string, expected YYYY-MM-DD");
			break;
		case "timestamp": // timestamp without time zone
		case "timestamptz": // timestamp with time zone
			// Expects ISO 8601 format
			baseType = z
				.string()
				.datetime({ message: "Invalid timestamp string" });
			break;
		case "json":
		case "jsonb":
			// Can be any valid JSON value
			baseType = z.any();
			break;
		case "bytea":
			// Typically represented as base64 strings or similar in JSON
			baseType = z.string(); // Adjust if a different representation is used
			break;
		// Add other common PG types as needed (inet, cidr, macaddr, geometric types, etc.)
		default:
			console.warn(
				`Unknown PostgreSQL element type "${elementType}", mapping to z.any().`,
			);
			baseType = z.any();
	}

	// Handle arrays
	let finalType = isArray ? z.array(baseType) : baseType;

	// Apply nullability based on DB schema
	if (isNullable) {
		finalType = finalType.nullable();
	}

	// Note: We intentionally do NOT make types optional() here by default.
	// Optionality in Zod means the key might be absent, which is different from nullability.
	// Input parameters are assumed required unless a default exists (which we don't check yet).
	return finalType;
}

/**
 * Generates the shape (object with Zod types) for a Zod schema
 * representing the input parameters of a function-based tool.
 * Parameters are assumed to be required (not optional) unless nullable in DB (rare for inputs).
 */
function generateInputSchemaShape(
	parameters: IntrospectedParameter[],
): Record<string, ZodTypeAny> {
	const schemaShape: Record<string, ZodTypeAny> = {};
	parameters.forEach((param) => {
		// For input parameters, assume they are NOT nullable unless the PG function
		// explicitly allows NULL without a default (less common). We pass `false`.
		// If a parameter MUST be optional (e.g., has a DB default), this needs refinement.
		const zodType = mapPgTypeToZod(param.pgType, false);
		schemaShape[param.toolParamName] = param.description
			? zodType.describe(param.description)
			: zodType;
		// If we determine a param SHOULD be optional (e.g., has default), add .optional() here.
		// schemaShape[param.toolParamName] = zodType.optional();
	});
	return schemaShape;
}

// Define type aliases using the imported types
type ToolHandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolHandlerResult = Promise<CallToolResult>;

/**
 * Creates MCP tools from introspected database definitions and registers them
 * with the McpServer instance using the high-level server.tool() signature.
 */
export class MCPToolFactory {
	private server: McpServer;
	private supabase: SupabaseClientWrapper;

	constructor(server: McpServer, supabaseClient: SupabaseClientWrapper) {
		this.server = server;
		this.supabase = supabaseClient;
	}

	/**
	 * Registers MCP tools based on the provided definitions.
	 * @param toolDefinitions - An array of structured tool definitions from introspection.
	 */
	registerTools(toolDefinitions: IntrospectedToolDefinition[]): void {
		console.log(`Registering ${toolDefinitions.length} tools...`);
		toolDefinitions.forEach((definition) => {
			try {
				const inputSchemaShape =
					definition.type === "FUNCTION"
						? generateInputSchemaShape(definition.parameters)
						: {}; // Views are parameterless

				/**
				 * ${definition.description ?? `Executes the ${definition.type.toLowerCase()} ${definition.pgName}`}
				 */
				const handler = async (
					args: Record<string, unknown>,
					_extra: ToolHandlerExtra,
				): ToolHandlerResult => {
					console.log(
						`Tool handler invoked: ${definition.toolName} with args:`,
						args,
					);
					try {
						let rawResult: unknown;
						if (definition.type === "VIEW") {
							rawResult = await this.supabase.selectFromView(
								definition.pgName,
							);
						} else {
							const rpcParams: Record<string, unknown> = {};
							definition.parameters.forEach((paramInfo) => {
								if (
									args &&
									Object.prototype.hasOwnProperty.call(
										args,
										paramInfo.toolParamName,
									)
								) {
									rpcParams[paramInfo.name] =
										args[paramInfo.toolParamName];
								}
							});
							rawResult = await this.supabase.callRpc(
								definition.pgName,
								rpcParams,
							);
						}

						console.log(`Tool ${definition.toolName} executed successfully.`);

						let contentItemText: string;
						if (rawResult === undefined || rawResult === null) {
							contentItemText = `Tool ${definition.toolName} executed successfully, returning no content.`;
						} else {
							contentItemText = JSON.stringify(
								rawResult,
								(_key, value) =>
									typeof value === "bigint"
										? value.toString()
										: value,
								2,
							);
						}

						// Construct content array using TextContent type
						const contentResult: TextContent[] = [
							{ type: "text", text: contentItemText },
						];
						// Return the object matching CallToolResult structure
						return { content: contentResult };
					} catch (error) {
						console.error(
							`Error executing tool ${definition.toolName}:`,
							error,
						);
						let errorMessage = `An unknown error occurred during tool execution: ${definition.toolName}`;
						if (error instanceof Error) {
							errorMessage = `Tool execution failed: ${error.message}`;
						}
						// Construct error content array using TextContent type
						const errorContent: TextContent[] = [
							{ type: "text", text: errorMessage },
						];
						// Return the object matching CallToolResult error structure
						return { isError: true, content: errorContent };
					}
				};

				if(definition.description) {
					this.server.tool(definition.toolName, definition.description,inputSchemaShape, handler);
				} else {
					this.server.tool(definition.toolName, inputSchemaShape, handler);
				}

				console.log(
					`Registered tool: ${definition.toolName} (type: ${definition.type})`,
				);
			} catch (error) {
				console.error(
					`Failed to define or register tool ${definition.toolName}:`,
					error,
				);
			}
		});
	}
} 