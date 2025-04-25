import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

// Define the schema for the configuration file
const configSchema = z
	.object({
		supabaseUrl: z.string().url("Invalid Supabase URL format"),
		supabaseServiceKey: z
			.string()
			.min(1, "Supabase service key cannot be empty"),
		schemaToScan: z.string().default("mcp_tools"),
		transport: z.enum(["http", "stdio"]).default("http"),
		httpPort: z.number().int().positive().default(3123),
	})
	.strict(); // Disallow extra fields

// Infer the TypeScript type from the Zod schema
export type AppConfig = z.infer<typeof configSchema>;

/**
 * Loads, validates, and returns the application configuration from a JSON file.
 * @param configPath - The absolute or relative path to the configuration JSON file.
 * @returns A promise that resolves to the validated configuration object.
 * @throws If the file cannot be read, parsed, or validated against the schema.
 */
export async function loadConfig(configPath: string): Promise<AppConfig> {
	const absolutePath = path.resolve(configPath);
	console.log(`Attempting to load configuration from: ${absolutePath}`);

	try {
		const fileContent = await fs.readFile(absolutePath, "utf-8");
		const rawConfig = JSON.parse(fileContent);

		// Validate and parse the configuration using the Zod schema
		const validatedConfig = await configSchema.parseAsync(rawConfig);

		// Log sensitive information carefully or avoid logging it
		console.log(
			`Configuration validated successfully. Schema: ${validatedConfig.schemaToScan}, Transport: ${validatedConfig.transport}`,
		);

		return validatedConfig;
	} catch (error) {
		if (error instanceof Error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new Error(`Configuration file not found at ${absolutePath}`);
			}
			if (error.name === "SyntaxError") {
				throw new Error(
					`Invalid JSON format in configuration file ${absolutePath}: ${error.message}`,
				);
			}
		}
		if (error instanceof z.ZodError) {
			// Provide more detailed validation errors
			const issues = error.issues
				.map((issue) => `${issue.path.join(".")} - ${issue.message}`)
				.join("; ");
			throw new Error(
				`Configuration validation failed: ${issues} in ${absolutePath}`,
			);
		}
		// Re-throw other unexpected errors
		throw new Error(
			`Failed to load or validate configuration from ${absolutePath}: ${error}`,
		);
	}
} 