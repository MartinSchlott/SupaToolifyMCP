import { parseArgs } from "node:util";
import { loadConfig, AppConfig } from "./config.js";
import { runHttpServer } from "./transport/http.js";
import { runStdioServer } from "./transport/stdio.js";

async function main(): Promise<void> {
	let configPath: string | undefined;

	try {
		const { values } = parseArgs({
			options: {
				config: {
					type: "string",
					short: "c",
				},
			},
		});
		configPath = values.config;
	} catch (error) {
		console.error("Error parsing command-line arguments:", error);
		process.exit(1);
	}

	if (!configPath) {
		console.error(
			"Configuration file path must be provided via --config or -c",
		);
		process.exit(1);
	}

	let config: AppConfig;
	try {
		config = await loadConfig(configPath);
	} catch (error) {
		console.error(`Error loading configuration from ${configPath}:`, error);
		process.exit(1);
	}

	console.log(
		`Configuration loaded. Transport: ${config.transport}, Schema: ${config.schemaToScan}`,
	);

	try {
		if (config.transport === "http") {
			await runHttpServer(config);
		} else if (config.transport === "stdio") {
			await runStdioServer(config);
		} else {
			// Should be caught by config validation, but just in case
			console.error(`Unsupported transport type: ${config.transport}`);
			process.exit(1);
		}
	} catch (error) {
		console.error("Server encountered a fatal error:", error);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Unhandled error in main execution:", err);
	process.exit(1);
});

