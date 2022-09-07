import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMetadataObject } from "@cloudflare/pages-shared/src/metadata-generator/createMetadataObject";
import { parseHeaders } from "@cloudflare/pages-shared/src/metadata-generator/parseHeaders";
import { parseRedirects } from "@cloudflare/pages-shared/src/metadata-generator/parseRedirects";
import { fetch as miniflareFetch } from "@miniflare/core";
import { watch } from "chokidar";
import { getType } from "mime";
import { Response } from "miniflare";
import { hashFile } from "../pages/hash";
import type { Metadata } from "@cloudflare/pages-shared/src/asset-server/metadata";
import type {
	ParsedRedirects,
	ParsedHeaders,
} from "@cloudflare/pages-shared/src/metadata-generator/types";
import type { Log } from "miniflare";
import type {
	Request as MiniflareRequest,
	RequestInfo,
	RequestInit,
} from "miniflare";

export interface Options {
	log: Log;
	proxyPort?: number;
	directory?: string;
}

export default async function generateASSETSBinding(options: Options) {
	const assetsFetch =
		options.directory !== undefined
			? await generateAssetsFetch(options.directory, options.log)
			: invalidAssetsFetch;

	return async function (request: MiniflareRequest) {
		if (options.proxyPort) {
			try {
				const url = new URL(request.url);
				url.host = `localhost:${options.proxyPort}`;
				return await miniflareFetch(url, request);
			} catch (thrown) {
				options.log.error(new Error(`Could not proxy request: ${thrown}`));

				// TODO: Pretty error page
				return new Response(`[wrangler] Could not proxy request: ${thrown}`, {
					status: 502,
				});
			}
		} else {
			try {
				return await assetsFetch(request);
			} catch (thrown) {
				options.log.error(new Error(`Could not serve static asset: ${thrown}`));

				// TODO: Pretty error page
				return new Response(
					`[wrangler] Could not serve static asset: ${thrown}`,
					{ status: 502 }
				);
			}
		}
	};
}

async function generateAssetsFetch(
	directory: string,
	log: Log
): Promise<typeof miniflareFetch> {
	// Defer importing miniflare until we really need it
	const { Headers, Request } = await import("@miniflare/core");

	// pages-shared expects a Workers runtime environment. This provides the necessary 'polyfills'.
	(globalThis as unknown as { Headers: typeof Headers }).Headers = Headers;
	(globalThis as unknown as { Request: typeof Request }).Request = Request;
	(globalThis as unknown as { Response: typeof Response }).Response = Response;

	const { generateHandler, parseQualityWeightedList } = await import(
		"@cloudflare/pages-shared/src/asset-server/handler"
	);

	const headersFile = join(directory, "_headers");
	const redirectsFile = join(directory, "_redirects");
	const workerFile = join(directory, "_worker.js");

	const ignoredFiles = [headersFile, redirectsFile, workerFile];

	let redirects: ParsedRedirects | undefined;
	if (existsSync(redirectsFile)) {
		const contents = readFileSync(redirectsFile, "utf-8");
		redirects = parseRedirects(contents);
	}

	let headers: ParsedHeaders | undefined;
	if (existsSync(headersFile)) {
		const contents = readFileSync(headersFile, "utf-8");
		headers = parseHeaders(contents);
	}

	let metadata = createMetadataObject({
		redirects,
		headers,
		logger: log.warn,
	});

	watch([headersFile, redirectsFile], { persistent: true }).on(
		"change",
		(path) => {
			switch (path) {
				case headersFile: {
					log.log("_headers modified. Re-evaluating...");
					const contents = readFileSync(headersFile).toString();
					headers = parseHeaders(contents);
					break;
				}
				case redirectsFile: {
					log.log("_redirects modified. Re-evaluating...");
					const contents = readFileSync(redirectsFile).toString();
					redirects = parseRedirects(contents);
					break;
				}
			}

			metadata = createMetadataObject({
				redirects,
				headers,
				logger: log.warn,
			});
		}
	);

	const generateResponse = async (request: MiniflareRequest) => {
		const assetKeyEntryMap = new Map<string, string>();

		return await generateHandler<string>({
			request,
			metadata: metadata as Metadata,
			xServerEnvHeader: "dev",
			logError: console.error,
			findAssetEntryForPath: async (path) => {
				const filepath = join(directory, path);

				if (
					existsSync(filepath) &&
					lstatSync(filepath).isFile() &&
					!ignoredFiles.includes(filepath)
				) {
					const hash = hashFile(filepath);
					assetKeyEntryMap.set(hash, filepath);
					return hash;
				}

				return null;
			},
			getAssetKey: (assetEntry) => {
				return assetEntry;
			},
			negotiateContent: (contentRequest) => {
				const acceptEncoding = parseQualityWeightedList(
					contentRequest.cf.clientAcceptEncoding
				);

				if (
					acceptEncoding["identity"] === 0 ||
					(acceptEncoding["*"] === 0 &&
						acceptEncoding["identity"] === undefined)
				) {
					throw new Error("No acceptable encodings available");
				}

				return { encoding: null };
			},
			fetchAsset: async (assetKey) => {
				const filepath = assetKeyEntryMap.get(assetKey);
				if (!filepath) {
					throw new Error(
						"Could not fetch asset. Please file an issue on GitHub (https://github.com/cloudflare/wrangler2/issues/new/choose) with reproduction steps."
					);
				}
				console.log(filepath);
				const body = readFileSync(filepath);

				const contentType = getType(filepath) || "application/octet-stream";
				return { body, contentType };
			},
		});
	};

	return async (input: RequestInfo, init?: RequestInit) => {
		const request = new Request(input, init);
		return await generateResponse(request);
	};
}

const invalidAssetsFetch: typeof miniflareFetch = () => {
	throw new Error(
		"Trying to fetch assets directly when there is no `directory` option specified."
	);
};
