import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { AppConfig } from "./config.js";

/**
 * A wrapper around the Supabase client to interact with the database,
 * focusing on calling RPC functions and querying views within the target schema.
 */
export class SupabaseClientWrapper {
	private client; // Type will be inferred from createClient call
	private schema: string;

	/**
	 * Initializes the Supabase client.
	 * @param config - The application configuration containing Supabase credentials and schema.
	 */
	constructor(config: AppConfig) {
		if (!config.supabaseUrl || !config.supabaseServiceKey) {
			throw new Error(
				"Supabase URL and Service Key are required in the configuration.",
			);
		}
		this.schema = config.schemaToScan;
		this.client = createClient(config.supabaseUrl, config.supabaseServiceKey, {
			db: {
				schema: this.schema,
			},
		});
		console.log(`Supabase client initialized for schema: ${this.schema}`);
	}

	/**
	 * Calls a PostgreSQL function (RPC) in the configured schema.
	 * @param functionName - The name of the function to call (without schema).
	 * @param params - The parameters to pass to the function.
	 * @returns A promise that resolves to the data returned by the function.
	 * @throws If the RPC call fails.
	 */
	async callRpc<T = any>(
		functionName: string,
		params: object = {},
	): Promise<T> {
		console.log(
			`Calling RPC: ${this.schema}.${functionName} with params:`,
			params,
		); // Be mindful of logging sensitive params
		const { data, error } = await this.client.rpc(functionName, params, {
			// Ensure RPC calls target the correct schema if functions are not in 'public'
			// Supabase client rpc() might implicitly handle schema or require it in functionName
			// depending on setup. Let's assume functionName is sufficient for now,
			// but might need adjustment based on the actual SQL function definition context.
			// If functions are explicitly IN the target schema, Supabase might need:
			// .rpc(`${this.schema}_${functionName}`, params) or similar, depending on how
			// the functions are exposed via PostgREST.
			// The safest is usually to define RPC functions in `public` and have them
			// query the target schema, or ensure PostgREST scans the target schema.
			// For now, we assume the name alone works or the user placed helpers in public.
		});

		if (error) {
			console.error(
				`RPC call to ${this.schema}.${functionName} failed:`,
				error,
			);
			throw new Error(
				`Supabase RPC call failed for ${functionName}: ${error.message}`,
			);
		}
		console.log(`RPC ${this.schema}.${functionName} successful.`);
		return data;
	}

	/**
	 * Selects all data from a view in the configured schema.
	 * @param viewName - The name of the view to query (without schema).
	 * @returns A promise that resolves to an array of rows from the view.
	 * @throws If the select query fails.
	 */
	async selectFromView<T = any>(viewName: string): Promise<T[]> {
		console.log(`Selecting * from view: ${this.schema}.${viewName}`);
		// Client is now schema-aware via constructor options.
		// We only need to specify the view name.
		const { data, error } = await this.client
			.from(viewName)
			.select("*");
			// Removed .schema(this.schema) call

		if (error) {
			console.error(`Select from view ${this.schema}.${viewName} failed:`, error);
			throw new Error(
				`Supabase select failed for view ${viewName} in schema ${this.schema}: ${error.message}`,
			);
		}
		console.log(`Select from ${this.schema}.${viewName} successful.`);
		return data ?? []; // Return empty array if data is null/undefined
	}

	/**
	 * Executes a raw SQL query. Use with caution.
	 * Primarily intended for invoking functions not easily mapped via rpc()
	 * or complex selects if needed, though standard methods are preferred.
	 * @param sql The raw SQL string.
	 * @returns A promise resolving to the query result.
	 * @throws If the query execution fails.
	 */
	// async executeRawQuery<T = any>(sql: string): Promise<any> {
	//   console.log(`Executing raw SQL (use with caution): ${sql}`);
	//   const { data, error } = await this.client.query(sql); // `.query` might not exist directly, depends on version/setup. Often rpc is used.
	//                                                        // This is a placeholder if direct query is needed.
	//                                                        // Consider using an RPC function for safety.
	//   if (error) {
	//     console.error("Raw SQL execution failed:", error);
	//     throw new Error(`Raw SQL execution failed: ${error.message}`);
	//   }
	//   console.log("Raw SQL executed successfully.");
	//   return data;
	// }
} 