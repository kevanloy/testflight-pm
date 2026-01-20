/**
 * TestFlight API Client
 * Secure utility for fetching TestFlight crash reports, screenshots, and feedback
 */

import type {
	AppBetaFeedbackCrashSubmissionsResponse,
	AppBetaFeedbackScreenshotSubmissionsResponse,
	CrashLogRelationshipsResponse,
	CrashLogResponse,
	DetailedCrashSubmissionResponse,
	DetailedScreenshotSubmissionResponse,
	DetailedTestFlightCrashReport,
	DetailedTestFlightScreenshotFeedback,
	EnhancedScreenshotImage,
	ProcessedFeedbackData,
	TestFlightApp,
	TestFlightAppsResponse,
	TestFlightCrashLog,
	TestFlightCrashReport,
	TestFlightErrorResponse,
	TestFlightQueryParams,
	TestFlightScreenshotFeedback,
} from "../../types/testflight.js";
import {
	API_ENDPOINTS,
	DEFAULT_HTTP_CONFIG,
	DEFAULT_TESTFLIGHT_CONFIG,
} from "../config/index.js";
import { getAuthInstance } from "./app-store-connect-auth.js";

export interface RateLimitInfo {
	remaining: number;
	reset: Date;
	limit: number;
}

export interface ApiRequestOptions {
	retries?: number;
	retryDelay?: number;
	timeout?: number;
}

/**
 * TestFlight API Client with rate limiting, retry logic, and secure authentication
 */
export class TestFlightClient {
	private readonly baseUrl = API_ENDPOINTS.APP_STORE_CONNECT;
	private readonly defaultTimeout = DEFAULT_HTTP_CONFIG.timeout;
	private readonly defaultRetries = DEFAULT_HTTP_CONFIG.retries;
	private readonly defaultRetryDelay = DEFAULT_HTTP_CONFIG.retryDelay;
	private readonly appId: string | null;

	private rateLimitInfo: RateLimitInfo | null = null;

	constructor() {
		// Get app ID from configuration if available
		const { getConfiguration } = require("../config/index.js");
		const config = getConfiguration();
		this.appId = config.appStoreConnect.appId || null;

		// Note: appId is no longer required in constructor since we can resolve from bundle ID
	}

	/**
	 * Fetches screenshot feedback for a specific app (legacy method - use getEnhancedRecentFeedback instead)
	 * @deprecated Use getAppScreenshotFeedback or getEnhancedRecentFeedback instead
	 */
	public async getScreenshotFeedback(
		params?: TestFlightQueryParams,
	): Promise<TestFlightScreenshotFeedback[]> {
		if (!this.appId) {
			throw new Error("App ID is required. Use getAppScreenshotFeedback with explicit app ID instead.");
		}
		return this.getAppScreenshotFeedback(this.appId, params);
	}

	/**
	 * Gets screenshot submissions for a specific app using Apple's app-specific endpoint
	 * Uses /apps/{id}/betaFeedbackScreenshotSubmissions
	 */
	public async getAppScreenshotSubmissions(
		appId: string,
		params?: TestFlightQueryParams,
	): Promise<TestFlightScreenshotFeedback[]> {
		const queryParams = {
			limit: DEFAULT_TESTFLIGHT_CONFIG.DEFAULT_LIMIT,
			sort: DEFAULT_TESTFLIGHT_CONFIG.DEFAULT_SORT,
			...params,
		};

		const response = await this.makeApiRequest<AppBetaFeedbackScreenshotSubmissionsResponse>(
			`/apps/${appId}/betaFeedbackScreenshotSubmissions`,
			queryParams,
		);

		return response.data;
	}

	/**
	 * Gets screenshot submissions for a specific app with date filtering
	 * Note: Apple API does not support filter[createdDate], only sort by createdDate
	 * So we fetch sorted results and filter client-side
	 */
	private async getAppScreenshotSubmissionsWithDateFilter(
		appId: string,
		since: Date,
	): Promise<TestFlightScreenshotFeedback[]> {
		// Fetch results sorted by -createdDate (newest first) and filter client-side
		// Apple API does not support filter[createdDate] - only sort is supported
		const allRecentScreenshots = await this.getAppScreenshotSubmissions(appId, {
			limit: DEFAULT_TESTFLIGHT_CONFIG.MAX_LIMIT,
			sort: "-createdDate",
		});

		// Filter client-side based on createdDate
		const filteredScreenshots = allRecentScreenshots.filter(screenshot => {
			const createdDate = new Date(screenshot.attributes.createdDate || screenshot.attributes.submittedAt || 0);
			return createdDate >= since;
		});

		console.log(`✅ Fetched ${allRecentScreenshots.length} screenshot submissions, ${filteredScreenshots.length} match date filter (since ${since.toISOString()})`);
		return filteredScreenshots;
	}

	/**
	 * Gets detailed information about a specific screenshot submission
	 * Uses /betaFeedbackScreenshotSubmissions/{id}
	 */
	public async getDetailedScreenshotSubmission(
		screenshotId: string,
		params?: TestFlightQueryParams,
	): Promise<DetailedTestFlightScreenshotFeedback> {
		const response = await this.makeApiRequest<DetailedScreenshotSubmissionResponse>(
			`/betaFeedbackScreenshotSubmissions/${screenshotId}`,
			params,
		);

		return response.data;
	}

	/**
	 * Gets screenshot feedback for a specific app (legacy method - use getAppScreenshotSubmissions instead)
	 * @deprecated Use getAppScreenshotSubmissions for better performance and proper API endpoint
	 */
	public async getAppScreenshotFeedback(
		appId: string,
		params?: TestFlightQueryParams,
	): Promise<TestFlightScreenshotFeedback[]> {
		return this.getAppScreenshotSubmissions(appId, params);
	}

	/**
	 * Downloads crash logs from the provided URLs
	 */
	public async downloadCrashLogs(
		crashReport: TestFlightCrashReport,
	): Promise<string[]> {
		const logs: string[] = [];

		// Check if crashLogs exists before iterating
		const { crashLogs } = crashReport.attributes;
		if (!crashLogs || crashLogs.length === 0) {
			return logs;
		}

		for (const logInfo of crashLogs) {
			try {
				// Check if URL hasn't expired
				const expiresAt = new Date(logInfo.expiresAt);
				if (expiresAt <= new Date()) {
					console.warn(`Crash log URL expired: ${logInfo.url}`);
					continue;
				}

				const response = await fetch(logInfo.url, {
					headers: {
						"User-Agent": "TestFlight-PM/1.0",
					},
					signal: AbortSignal.timeout(this.defaultTimeout),
				});

				if (!response.ok) {
					console.warn(
						`Failed to download crash log: ${response.status} ${response.statusText}`,
					);
					continue;
				}

				const logContent = await response.text();
				logs.push(logContent);
			} catch (error) {
				console.warn(`Error downloading crash log from ${logInfo.url}:`, error);
			}
		}

		return logs;
	}

	/**
	 * Downloads screenshots from the provided URLs with enhanced error handling
	 * @deprecated Use downloadEnhancedScreenshots for better performance and metadata
	 */
	public async downloadScreenshots(
		screenshotFeedback: TestFlightScreenshotFeedback,
	): Promise<Uint8Array[]> {
		const { screenshots } = screenshotFeedback.attributes;
		return await this.downloadScreenshotImages(screenshots);
	}

	/**
	 * Downloads enhanced screenshots with metadata and validation
	 */
	public async downloadEnhancedScreenshots(
		screenshotFeedback: DetailedTestFlightScreenshotFeedback,
	): Promise<{ data: Uint8Array; metadata: EnhancedScreenshotImage }[]> {
		const results: { data: Uint8Array; metadata: EnhancedScreenshotImage }[] = [];

		const enhancedImages = await this.processEnhancedScreenshotImages(
			screenshotFeedback.attributes.screenshots
		);

		for (const imageMetadata of enhancedImages) {
			try {
				const imageData = await this.downloadSingleScreenshotImage(imageMetadata);
				if (imageData) {
					results.push({
						data: imageData,
						metadata: imageMetadata,
					});
				}
			} catch (error) {
				console.warn(
					`Error downloading enhanced screenshot ${imageMetadata.fileName}:`,
					error,
				);
			}
		}

		return results;
	}

	/**
	 * Downloads screenshot images from URL array (DRY helper method)
	 */
	private async downloadScreenshotImages(
		screenshots: TestFlightScreenshotFeedback["attributes"]["screenshots"],
	): Promise<Uint8Array[]> {
		const images: Uint8Array[] = [];

		for (const imageInfo of screenshots) {
			try {
				const imageData = await this.downloadSingleScreenshotImage({
					url: imageInfo.url,
					fileName: imageInfo.fileName,
					fileSize: imageInfo.fileSize,
					expiresAt: new Date(imageInfo.expiresAt),
				});

				if (imageData) {
					images.push(imageData);
				}
			} catch (error) {
				console.warn(
					`Error downloading screenshot from ${imageInfo.url}:`,
					error,
				);
			}
		}

		return images;
	}

	/**
	 * Downloads a single screenshot image with validation and retry logic for 5xx errors
	 */
	private async downloadSingleScreenshotImage(
		imageInfo: { url: string; fileName: string; fileSize: number; expiresAt: Date },
	): Promise<Uint8Array | null> {
		// Check if URL hasn't expired
		if (imageInfo.expiresAt <= new Date()) {
			console.warn(`Screenshot URL expired: ${imageInfo.url}`);
			return null;
		}

		const maxRetries = 3;
		let lastError: string | null = null;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				console.log(`📸 Downloading screenshot (attempt ${attempt}/${maxRetries}): ${imageInfo.fileName}`);

				const response = await fetch(imageInfo.url, {
					headers: {
						"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
						"Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
						"Accept-Language": "en-US,en;q=0.9",
						"Cache-Control": "no-cache",
					},
					signal: AbortSignal.timeout(this.defaultTimeout),
				});

				if (response.ok) {
					const imageData = new Uint8Array(await response.arrayBuffer());
					console.log(`✅ Downloaded screenshot: ${imageInfo.fileName} (${imageData.length} bytes)`);

					// Validate file size if specified
					if (imageInfo.fileSize > 0 && imageData.length !== imageInfo.fileSize) {
						console.warn(
							`Screenshot size mismatch for ${imageInfo.fileName}: expected ${imageInfo.fileSize}, got ${imageData.length}`,
						);
					}

					return imageData;
				}

				lastError = `${response.status} ${response.statusText}`;

				// Retry on 5xx errors
				if (response.status >= 500 && attempt < maxRetries) {
					const delay = Math.pow(2, attempt) * 1000; // Exponential backoff: 2s, 4s, 8s
					console.warn(`Screenshot download failed (${lastError}), retrying in ${delay/1000}s...`);
					await new Promise(resolve => setTimeout(resolve, delay));
					continue;
				}

				console.warn(`Failed to download screenshot: ${lastError}`);
				return null;
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				if (attempt < maxRetries) {
					const delay = Math.pow(2, attempt) * 1000;
					console.warn(`Screenshot download error (${lastError}), retrying in ${delay/1000}s...`);
					await new Promise(resolve => setTimeout(resolve, delay));
					continue;
				}
				console.warn(`Failed to download screenshot after ${maxRetries} attempts: ${lastError}`);
				return null;
			}
		}

		return null;
	}

	/**
	 * Gets current rate limit information
	 */
	public getRateLimitInfo(): RateLimitInfo | null {
		return this.rateLimitInfo;
	}

	/**
	 * Gets the configured app ID for health checking
	 */
	public getConfiguredAppId(): string | null {
		return this.appId || null;
	}

	/**
	 * Tests authentication without making a full API request
	 * Used by health checkers to verify credentials
	 */
	public async testAuthentication(): Promise<boolean> {
		try {
			const authInstance = getAuthInstance();
			await authInstance.getValidToken();
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Lists all apps in the App Store Connect account
	 */
	public async getApps(params?: TestFlightQueryParams): Promise<TestFlightApp[]> {
		const queryParams = {
			limit: DEFAULT_TESTFLIGHT_CONFIG.DEFAULT_LIMIT,
			...params,
		};

		const response = await this.makeApiRequest<TestFlightAppsResponse>(
			"/apps",
			queryParams,
		);

		return response.data;
	}

	/**
	 * Finds an app by its bundle ID using reliable unfiltered search + manual matching
	 * Note: Bundle ID filtering via API query parameters appears to be unreliable,
	 * so we fetch all apps and filter manually for better reliability
	 */
	public async findAppByBundleId(bundleId: string): Promise<TestFlightApp | null> {
		console.log(`🔍 Searching for app with bundle ID: ${bundleId}`);

		try {
			// First try the filtered approach (may fail with some API key configurations)
			const params: TestFlightQueryParams = {
				filter: {
					bundleId: bundleId,
				},
				limit: 1,
			};

			console.log(`🔄 Attempting filtered search first...`);
			const filteredApps = await this.getApps(params);

			if (filteredApps.length > 0 && filteredApps[0]) {
				console.log(`✅ Filtered search successful: ${filteredApps[0].attributes.name}`);
				return filteredApps[0];
			}

			console.log(`⚠️ Filtered search returned no results, falling back to manual search`);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.log(`⚠️ Filtered search failed (${errorMessage}), falling back to manual search`);
		}

		// Fallback: Get all apps and search manually (more reliable)
		console.log(`🔄 Performing manual search across all apps...`);
		try {
			const allApps = await this.getApps({ limit: 200 }); // Increase limit to catch more apps

			console.log(`📋 Searching through ${allApps.length} apps for bundle ID: ${bundleId}`);

			const matchingApp = allApps.find(app =>
				app.attributes.bundleId === bundleId
			);

			if (matchingApp) {
				console.log(`✅ Manual search successful: ${matchingApp.attributes.name} (${matchingApp.id})`);
				return matchingApp;
			}

			console.log(`❌ No app found with bundle ID: ${bundleId}`);
			console.log(`📋 Available apps:`);
			allApps.forEach(app => {
				console.log(`  - ${app.attributes.name}: ${app.attributes.bundleId} (${app.id})`);
			});

			return null;
		} catch (fallbackError) {
			const fallbackErrorMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
			console.error(`❌ Manual search also failed: ${fallbackErrorMessage}`);
			throw fallbackError;
		}
	}

	/**
	 * Gets a specific app by its ID for validation purposes
	 */
	public async getAppById(appId: string): Promise<TestFlightApp> {
		const response = await this.makeApiRequest<{ data: TestFlightApp }>(
			`/apps/${appId}`,
			{
				fields: {
					apps: "bundleId,name,sku,primaryLocale"
				}
			}
		);

		return response.data;
	}

	/**
	 * Gets crash submissions for a specific app
	 */
	public async getAppCrashSubmissions(
		appId: string,
		params?: TestFlightQueryParams,
	): Promise<TestFlightCrashReport[]> {
		const queryParams = {
			limit: DEFAULT_TESTFLIGHT_CONFIG.DEFAULT_LIMIT,
			sort: DEFAULT_TESTFLIGHT_CONFIG.DEFAULT_SORT,
			...params,
		};

		const response = await this.makeApiRequest<AppBetaFeedbackCrashSubmissionsResponse>(
			`/apps/${appId}/betaFeedbackCrashSubmissions`,
			queryParams,
		);

		return response.data;
	}

	/**
	 * Gets crash submissions for a specific app with date filtering
	 * Note: Apple API does not support filter[createdDate], only sort by createdDate
	 * So we fetch sorted results and filter client-side
	 */
	private async getAppCrashSubmissionsWithDateFilter(
		appId: string,
		since: Date,
	): Promise<TestFlightCrashReport[]> {
		// Fetch results sorted by -createdDate (newest first) and filter client-side
		// Apple API does not support filter[createdDate] - only sort is supported
		const allRecentCrashes = await this.getAppCrashSubmissions(appId, {
			limit: DEFAULT_TESTFLIGHT_CONFIG.MAX_LIMIT,
			sort: "-createdDate",
		});

		// Filter client-side based on createdDate
		const filteredCrashes = allRecentCrashes.filter(crash => {
			const createdDate = new Date(crash.attributes.createdDate || crash.attributes.submittedAt || 0);
			return createdDate >= since;
		});

		console.log(`✅ Fetched ${allRecentCrashes.length} crash submissions, ${filteredCrashes.length} match date filter (since ${since.toISOString()})`);
		return filteredCrashes;
	}

	/**
	 * Gets detailed information about a specific crash submission
	 */
	public async getDetailedCrashSubmission(
		crashId: string,
		params?: TestFlightQueryParams,
	): Promise<DetailedTestFlightCrashReport> {
		const response = await this.makeApiRequest<DetailedCrashSubmissionResponse>(
			`/betaFeedbackCrashSubmissions/${crashId}`,
			params,
		);

		return response.data;
	}

	/**
	 * Gets the actual crash log content for a crash submission
	 * According to Apple API docs, the only valid field is 'logText'
	 */
	public async getCrashLog(
		crashId: string,
	): Promise<TestFlightCrashLog> {
		const response = await this.makeApiRequest<CrashLogResponse>(
			`/betaFeedbackCrashSubmissions/${crashId}/crashLog`,
			{
				fields: {
					betaCrashLogs: "logText",
				},
			},
		);

		return response.data;
	}

	/**
	 * Gets crash log relationships for a crash submission
	 */
	public async getCrashLogRelationships(
		crashId: string,
	): Promise<CrashLogRelationshipsResponse> {
		return await this.makeApiRequest<CrashLogRelationshipsResponse>(
			`/betaFeedbackCrashSubmissions/${crashId}/relationships/crashLog`,
		);
	}

	/**
	 * Gets the crash log text content from a TestFlightCrashLog object
	 * According to Apple API docs, the log content is returned directly in logText field
	 */
	public getCrashLogText(crashLog: TestFlightCrashLog): string | null {
		if (!crashLog.attributes?.logText) {
			console.warn(`Crash log text not available for crash log ${crashLog.id}`);
			return null;
		}
		return crashLog.attributes.logText;
	}

	/**
	 * Resolves and validates app ID using App Store Connect API as single source of truth
	 * Ensures consistency between provided app_id and bundle_id when both are available
	 * Enhanced with better error handling and user guidance
	 */
	public async resolveAppId(bundleId?: string): Promise<string> {
		const providedAppId = this.appId;
		const providedBundleId = bundleId;

		// Case 1: Both app_id and bundle_id provided - validate consistency
		if (providedAppId && providedBundleId) {
			console.log(`🔍 Validating consistency between app_id: ${providedAppId} and bundle_id: ${providedBundleId}`);

			try {
				// Use API as single source of truth - fetch app by bundle ID
				const appFromBundleId = await this.findAppByBundleId(providedBundleId);

				if (!appFromBundleId) {
					throw new Error(
						`Bundle ID '${providedBundleId}' not found in App Store Connect. Please verify the bundle ID is correct and exists.`
					);
				}

				// Validate that the provided app_id matches the API response
				if (appFromBundleId.id !== providedAppId) {
					console.warn(`⚠️ Inconsistency detected! Provided app_id: ${providedAppId} does not match API app_id: ${appFromBundleId.id} for bundle_id: ${providedBundleId}`);
					console.warn(`📋 App Store Connect API shows: ${appFromBundleId.attributes.name} (${appFromBundleId.attributes.bundleId})`);
					console.warn(`🔧 Using App Store Connect API as authoritative source: ${appFromBundleId.id}`);

					// Use API response as authoritative (single source of truth)
					return appFromBundleId.id;
				}

				console.log(`✅ Validated consistency: app_id ${providedAppId} matches bundle_id ${providedBundleId}`);
				return providedAppId;

			} catch (error) {
				// Enhanced error handling with specific guidance
				const errorMessage = error instanceof Error ? error.message : String(error);
				console.warn(`⚠️ Bundle ID validation failed: ${errorMessage}`);
				console.log(`🔍 Attempting to validate app_id: ${providedAppId} directly`);

				try {
					// Fetch app by app_id to validate it exists and get its bundle_id
					const appFromAppId = await this.getAppById(providedAppId);

					if (appFromAppId.attributes.bundleId !== providedBundleId) {
						throw new Error(
							`Inconsistent data: app_id '${providedAppId}' has bundle_id '${appFromAppId.attributes.bundleId}' but you provided bundle_id '${providedBundleId}'. Please check your configuration.`
						);
					}

					console.log(`✅ Validated app_id ${providedAppId} exists and matches expected bundle_id`);
					return providedAppId;

				} catch (appIdError) {
					const appIdErrorMessage = appIdError instanceof Error ? appIdError.message : String(appIdError);
					throw new Error(
						`App validation failed - neither app_id '${providedAppId}' nor bundle_id '${providedBundleId}' could be validated. Bundle ID Error: ${errorMessage}; App ID Error: ${appIdErrorMessage}`
					);
				}
			}
		}

		// Case 2: Only app_id provided - validate it exists
		if (providedAppId && !providedBundleId) {
			console.log(`🔍 Validating app_id: ${providedAppId}`);

			try {
				const app = await this.getAppById(providedAppId);
				console.log(`✅ Validated app_id ${providedAppId} - ${app.attributes.name} (${app.attributes.bundleId})`);
				return providedAppId;
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				throw new Error(
					`App ID '${providedAppId}' not found in App Store Connect. Error: ${errorMessage}`
				);
			}
		}

		// Case 3: Only bundle_id provided - resolve app_id
		if (!providedAppId && providedBundleId) {
			console.log(`🔍 Resolving app_id from bundle_id: ${providedBundleId}`);

			try {
				const app = await this.findAppByBundleId(providedBundleId);
				if (!app) {
					throw new Error(
						`No app found with bundle ID '${providedBundleId}' in your App Store Connect account.`
					);
				}

				console.log(`✅ Resolved app_id ${app.id} from bundle_id ${providedBundleId} - ${app.attributes.name}`);
				return app.id;
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Failed to resolve app_id from bundle_id '${providedBundleId}'. Error: ${errorMessage}`
				);
			}
		}

		// Case 4: Neither provided
		throw new Error(
			"Either app_id or testflight_bundle_id must be provided. Please set TESTFLIGHT_APP_ID or TESTFLIGHT_BUNDLE_ID environment variables, or provide app_id or testflight_bundle_id inputs."
		);
	}

	/**
	 * Enhanced method to get recent feedback with detailed crash logs
	 * This is the main method to use for fetching TestFlight feedback
	 */
	public async getEnhancedRecentFeedback(
		since: Date,
		bundleId?: string,
	): Promise<ProcessedFeedbackData[]> {
		// Resolve app ID
		const resolvedAppId = await this.resolveAppId(bundleId);

		// Get crash submissions and screenshot feedback in parallel
		// Note: Apple's API uses 'createdDate' not 'submittedAt' for filtering
		const [crashes, screenshots] = await Promise.all([
			this.getAppCrashSubmissionsWithDateFilter(resolvedAppId, since),
			this.getAppScreenshotSubmissionsWithDateFilter(resolvedAppId, since),
		]);

		const processedData: ProcessedFeedbackData[] = [];

		// Process crash reports with enhanced details
		await this.processCrashReportsWithDetails(crashes, processedData);

		// Process screenshot feedback  
		await this.processScreenshotFeedbackData(screenshots, processedData);

		// Sort by submission date (newest first)
		processedData.sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());

		return processedData;
	}

	/**
	 * Legacy method - use getEnhancedRecentFeedback instead
	 * @deprecated Use getEnhancedRecentFeedback for better performance and detailed crash logs
	 */
	public async getRecentFeedback(since: Date): Promise<ProcessedFeedbackData[]> {
		return this.getEnhancedRecentFeedback(since);
	}

	/**
	 * Makes an authenticated API request with enhanced retry logic and rate limiting
	 * Includes better error categorization and exponential backoff
	 */
	private async makeApiRequest<T>(
		endpoint: string,
		params?: TestFlightQueryParams,
		options?: ApiRequestOptions,
	): Promise<T> {
		const {
			retries = this.defaultRetries,
			retryDelay = this.defaultRetryDelay,
			timeout = this.defaultTimeout,
		} = options || {};

		let lastError: Error | null = null;
		let lastStatusCode: number | null = null;

		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				// Wait for rate limit reset if necessary
				await this.waitForRateLimit();

				// Get valid authentication token
				const authInstance = getAuthInstance();
				const token = await authInstance.getValidToken();

				// Build URL with query parameters
				const url = this.buildUrl(endpoint, params);

				console.log(`🔗 API Request (attempt ${attempt + 1}/${retries + 1}): ${url.toString()}`);

				// Make the request
				const response = await fetch(url, {
					method: "GET",
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: "application/json",
						"User-Agent": "TestFlight-PM/1.0",
					},
					signal: AbortSignal.timeout(timeout),
				});

				lastStatusCode = response.status;

				// Update rate limit info
				this.updateRateLimitInfo(response);

				// Handle error responses
				if (!response.ok) {
					const errorText = await response.text();
					let errorData: TestFlightErrorResponse;

					try {
						errorData = JSON.parse(errorText);
					} catch {
						throw new Error(`HTTP ${response.status}: ${response.statusText}`);
					}

					const errorMessage = errorData.errors
						.map((e) => `${e.title}: ${e.detail}`)
						.join("; ");

					// Enhanced error handling with retry logic
					const apiError = new Error(`API Error: ${errorMessage}`);

					// Determine if this is a retryable error
					const isRetryable = this.isRetryableError(response.status, errorMessage);

					if (!isRetryable) {
						console.log(`❌ Non-retryable error (${response.status}): ${errorMessage}`);
						throw apiError;
					}

					console.log(`⚠️ Retryable error (${response.status}): ${errorMessage}`);
					throw apiError;
				}

				// Parse and return response
				const data = await response.json();
				console.log(`✅ API Request successful (attempt ${attempt + 1})`);
				return data as T;
			} catch (error) {
				lastError = error as Error;

				// Don't retry on authentication errors (401, 403)
				if (
					lastError.message.includes("authentication") ||
					lastError.message.includes("unauthorized") ||
					lastStatusCode === 401 ||
					lastStatusCode === 403
				) {
					console.log(`❌ Authentication error - not retrying: ${lastError.message}`);
					throw lastError;
				}

				// Don't retry on client errors (400, 404) - these are configuration issues
				if (lastStatusCode && lastStatusCode >= 400 && lastStatusCode < 500 && lastStatusCode !== 429) {
					console.log(`❌ Client error (${lastStatusCode}) - not retrying: ${lastError.message}`);
					throw lastError;
				}

				// Don't retry on the last attempt
				if (attempt === retries) {
					console.log(`❌ Final attempt failed: ${lastError.message}`);
					break;
				}

				// Calculate delay with exponential backoff and jitter
				const baseDelay = retryDelay * Math.pow(2, attempt);
				const jitter = Math.random() * 0.1 * baseDelay; // Add up to 10% jitter
				const delay = Math.floor(baseDelay + jitter);

				console.log(`🔄 Retrying in ${delay}ms (attempt ${attempt + 1}/${retries + 1}): ${lastError.message}`);
				await this.sleep(delay);
			}
		}

		// Enhanced final error message
		const finalError = new Error(
			`Request failed after ${retries + 1} attempts: ${lastError?.message}${lastStatusCode ? ` (HTTP ${lastStatusCode})` : ''}`
		);

		// Add additional context for common issues
		if (lastStatusCode === 404 || lastError?.message.includes("The specified resource does not exist")) {
			console.error(`🔍 This appears to be a resource not found error. Check your app_id/bundle_id and API key permissions.`);
		}

		throw finalError;
	}

	/**
	 * Determines if an error is retryable based on status code and error message
	 */
	private isRetryableError(statusCode: number, errorMessage: string): boolean {
		// Rate limiting - always retry
		if (statusCode === 429) {
			return true;
		}

		// Server errors - retry
		if (statusCode >= 500) {
			return true;
		}

		// Timeout or network errors - retry
		if (errorMessage.includes("timeout") || errorMessage.includes("network")) {
			return true;
		}

		// Temporary Apple API issues (sometimes happens intermittently)
		if (errorMessage.includes("temporarily unavailable") ||
			errorMessage.includes("service unavailable")) {
			return true;
		}

		// Don't retry client errors (400-499, except 429)
		if (statusCode >= 400 && statusCode < 500) {
			return false;
		}

		// Default to not retrying unknown errors
		return false;
	}

	/**
	 * Builds a complete URL with query parameters
	 * Properly handles endpoints that start with "/" to avoid replacing the base path
	 */
	private buildUrl(endpoint: string, params?: TestFlightQueryParams): string {
		// Fix: If endpoint starts with "/", we need to properly append it to baseUrl
		// new URL("/apps", "https://api.appstoreconnect.apple.com/v1") would incorrectly become 
		// "https://api.appstoreconnect.apple.com/apps" (losing /v1)
		// Instead, we should get "https://api.appstoreconnect.apple.com/v1/apps"
		let fullUrl: string;
		if (endpoint.startsWith('/')) {
			// Append endpoint to baseUrl, ensuring no double slashes
			fullUrl = this.baseUrl.endsWith('/')
				? this.baseUrl + endpoint.slice(1)
				: this.baseUrl + endpoint;
		} else {
			// Use standard URL constructor for relative paths
			fullUrl = new URL(endpoint, this.baseUrl).toString();
		}

		const url = new URL(fullUrl);

		if (params) {
			if (params.limit) {
				url.searchParams.set("limit", params.limit.toString());
			}
			if (params.sort) {
				url.searchParams.set("sort", params.sort);
			}
			if (params.include) {
				url.searchParams.set("include", params.include);
			}

			// Add filter parameters
			if (params.filter) {
				for (const [key, value] of Object.entries(params.filter)) {
					url.searchParams.set(`filter[${key}]`, value);
				}
			}

			// Add fields parameters
			if (params.fields) {
				for (const [key, value] of Object.entries(params.fields)) {
					url.searchParams.set(`fields[${key}]`, value);
				}
			}
		}

		return url.toString();
	}

	/**
	 * Updates rate limit information from response headers
	 */
	private updateRateLimitInfo(response: Response): void {
		const remaining = response.headers.get("X-RateLimit-Remaining");
		const reset = response.headers.get("X-RateLimit-Reset");
		const limit = response.headers.get("X-RateLimit-Limit");

		if (remaining && reset && limit) {
			this.rateLimitInfo = {
				remaining: Number.parseInt(remaining, 10),
				reset: new Date(Number.parseInt(reset, 10) * 1000),
				limit: Number.parseInt(limit, 10),
			};
		}
	}

	/**
	 * Waits if we're close to hitting rate limits
	 */
	private async waitForRateLimit(): Promise<void> {
		if (!this.rateLimitInfo) {
			return;
		}

		// If we have very few requests remaining, wait until reset
		if (this.rateLimitInfo.remaining <= 5) {
			const now = new Date();
			const waitTime = this.rateLimitInfo.reset.getTime() - now.getTime();

			if (waitTime > 0) {
				console.log(
					`Rate limit approaching. Waiting ${Math.ceil(waitTime / 1000)} seconds...`,
				);
				await this.sleep(waitTime);
			}
		}
	}

	/**
	 * Processes crash reports with enhanced details (including detailed crash logs and system metadata)
	 */
	private async processCrashReportsWithDetails(
		crashes: TestFlightCrashReport[],
		processedData: ProcessedFeedbackData[],
	): Promise<void> {
		for (const crash of crashes) {
			let processedCrash = this.processCrashReport(crash);

			// ENHANCEMENT: Get detailed crash submission metadata for richer debugging context
			try {
				console.log(`🔍 Fetching enhanced crash metadata for ${crash.id}`);
				const detailedCrash = await this.getDetailedCrashSubmission(crash.id, {
					include: "build,tester",
					fields: {
						betaFeedbackCrashSubmissions: [
							"createdDate", "comment", "email", "deviceModel", "osVersion",
							"locale", "timeZone", "architecture", "connectionType",
							"pairedAppleWatch", "appUptimeInMilliseconds", "diskBytesAvailable",
							"diskBytesTotal", "batteryPercentage", "screenWidthInPoints",
							"screenHeightInPoints", "appPlatform", "devicePlatform",
							"deviceFamily", "buildBundleId"
						].join(",")
					}
				});

				// Merge enhanced metadata into processed crash
				processedCrash = this.mergeEnhancedCrashMetadata(processedCrash, detailedCrash);
				console.log(`✅ Enhanced crash metadata obtained for ${crash.id}`);
			} catch (error) {
				console.warn(`⚠️ Failed to get enhanced crash metadata for ${crash.id}:`, error);
				// Continue with basic data if enhanced fails
			}

			// Get detailed crash log content
			try {
				const crashLog = await this.getCrashLog(crash.id);
				const logText = this.getCrashLogText(crashLog);

				if (logText && processedCrash.crashData) {
					processedCrash.crashData.detailedLogs = [logText];
				}
			} catch (error) {
				console.warn(`Failed to get detailed crash log for ${crash.id}:`, error);
			}

			processedData.push(processedCrash);
		}
	}

	/**
	 * Processes screenshot feedback data with enhanced details (including detailed screenshot info)
	 */
	private async processScreenshotFeedbackData(
		screenshots: TestFlightScreenshotFeedback[],
		processedData: ProcessedFeedbackData[],
	): Promise<void> {
		for (const screenshot of screenshots) {
			const processedScreenshot = this.processScreenshotFeedback(screenshot);

			// ENHANCEMENT: Get detailed screenshot submission with optimized field selection
			try {
				console.log(`🔍 Fetching enhanced screenshot metadata for ${screenshot.id}`);
				// Note: Only request fields that actually exist in App Store Connect API
				// Invalid fields removed: applicationState, memoryPressure, batteryLevel, batteryState,
				// thermalState, diskSpaceRemaining, submissionMethod, testerNotes
				const detailedScreenshot = await this.getDetailedScreenshotSubmission(screenshot.id, {
					include: "build,tester",
					fields: {
						betaFeedbackScreenshotSubmissions: [
							"createdDate", "comment", "email", "deviceModel", "osVersion",
							"locale", "timeZone", "architecture", "connectionType",
							"pairedAppleWatch", "appUptimeInMilliseconds", "diskBytesAvailable",
							"diskBytesTotal", "batteryPercentage", "screenWidthInPoints",
							"screenHeightInPoints", "appPlatform", "devicePlatform",
							"deviceFamily", "buildBundleId", "screenshots"
						].join(",")
					}
				});

				if (processedScreenshot.screenshotData) {
					// Process enhanced screenshot images if available from detailed API
					const screenshotsFromAPI = detailedScreenshot.attributes.screenshots;
					console.log(`🔍 DEBUG: screenshots from API for ${screenshot.id}:`, JSON.stringify(screenshotsFromAPI, null, 2));

					if (screenshotsFromAPI && screenshotsFromAPI.length > 0) {
						// IMPORTANT: The initial list API doesn't return screenshots - only the detailed API does
						// So we need to populate the main images array from the detailed response
						processedScreenshot.screenshotData.images = screenshotsFromAPI.map((img, index) => {
							const processedImg = {
								url: img?.url || '',
								fileName: img?.fileName || `screenshot_${index}.png`,
								fileSize: img?.fileSize || 0,
								expiresAt: new Date(img?.expiresAt || Date.now() + 3600000),
							};
							console.log(`🔍 DEBUG: Processed image ${index}:`, JSON.stringify(processedImg, null, 2));
							return processedImg;
						});

						// Also store enhanced metadata
						processedScreenshot.screenshotData.enhancedImages =
							await this.processEnhancedScreenshotImages(screenshotsFromAPI);

						console.log(`📷 Found ${processedScreenshot.screenshotData.images.length} screenshot(s) from detailed API for ${screenshot.id}`);
					} else {
						console.warn(`⚠️ No screenshots in detailed API response for ${screenshot.id}`);
					}
				}

				console.log(`✅ Enhanced screenshot metadata obtained for ${screenshot.id}`);
			} catch (error) {
				console.warn(`⚠️ Failed to get enhanced screenshot metadata for ${screenshot.id}:`, error);
				// Continue with basic data if enhanced fails
			}

			// CRITICAL: Download screenshots immediately to avoid URL expiration
			// TestFlight URLs expire quickly, so we cache the data now before any rate limiting delays
			if (processedScreenshot.screenshotData?.images && processedScreenshot.screenshotData.images.length > 0) {
				console.log(`📸 Pre-downloading ${processedScreenshot.screenshotData.images.length} screenshot(s) for ${screenshot.id}...`);
				for (const imageInfo of processedScreenshot.screenshotData.images) {
					try {
						const imageData = await this.downloadSingleScreenshotImage(imageInfo);
						if (imageData) {
							imageInfo.cachedData = imageData;
							console.log(`✅ Cached screenshot: ${imageInfo.fileName} (${imageData.length} bytes)`);
						}
					} catch (error) {
						console.warn(`⚠️ Failed to pre-download screenshot ${imageInfo.fileName}:`, error);
					}
				}
			} else {
				console.warn(`⚠️ No screenshots available to download for ${screenshot.id}`);
			}

			processedData.push(processedScreenshot);
		}
	}

	/**
	 * Processes enhanced screenshot images with additional metadata
	 */
	private async processEnhancedScreenshotImages(
		screenshots: TestFlightScreenshotFeedback["attributes"]["screenshots"],
	): Promise<EnhancedScreenshotImage[]> {
		if (!screenshots || !Array.isArray(screenshots)) {
			return [];
		}
		return screenshots.map((screenshot, index) => ({
			url: screenshot?.url || "",
			fileName: screenshot?.fileName || `screenshot_${index}.png`,
			fileSize: screenshot?.fileSize || 0,
			expiresAt: screenshot?.expiresAt ? new Date(screenshot.expiresAt) : new Date(),
			// Additional enhanced properties (would be available from Apple's detailed API)
			imageFormat: this.extractImageFormat(screenshot?.fileName),
			imageScale: 1.0, // Default scale, could be enhanced with actual data
			imageDimensions: {
				width: 0, // Would be provided by detailed API
				height: 0, // Would be provided by detailed API
			},
			compressionQuality: 0.8, // Default quality
			metadata: {
				index,
				processingTime: new Date().toISOString(),
			},
		}));
	}

	/**
	 * Extracts image format from filename
	 */
	private extractImageFormat(fileName?: string): "png" | "jpeg" | "heic" {
		if (!fileName) {
			return 'png'; // Default fallback when fileName is undefined
		}
		const extension = fileName.toLowerCase().split('.').pop();
		switch (extension) {
			case 'png':
				return 'png';
			case 'jpg':
			case 'jpeg':
				return 'jpeg';
			case 'heic':
				return 'heic';
			default:
				return 'png'; // Default fallback
		}
	}

	/**
	 * Processes raw crash report data into standardized format
	 * Handles both real API fields and legacy field names for backward compatibility
	 */
	private processCrashReport(
		crash: TestFlightCrashReport,
	): ProcessedFeedbackData {
		const attrs = crash.attributes;

		// Use real API fields with fallbacks to legacy fields
		const submittedAt = attrs.createdDate || attrs.submittedAt || new Date().toISOString();
		const bundleId = attrs.buildBundleId || attrs.bundleId || '';
		const deviceFamily = attrs.deviceFamily || 'UNKNOWN';

		// Extract app version and build number from other available data if not directly provided
		// Note: Real API may not always include these fields in crash submissions
		const appVersion = attrs.appVersion || 'Unknown';
		const buildNumber = attrs.buildNumber || 'Unknown';

		return {
			id: crash.id,
			type: "crash",
			submittedAt: new Date(submittedAt),
			appVersion,
			buildNumber,
			deviceInfo: {
				family: deviceFamily,
				model: attrs.deviceModel,
				osVersion: attrs.osVersion,
				locale: attrs.locale,
			},
			bundleId,
			testerInfo: attrs.email ? {
				email: attrs.email,
			} : undefined,
			crashData: {
				// Real API may not have crash trace/type directly in submission
				// These might be in the related crashLog resource
				trace: attrs.crashTrace || '',
				type: attrs.crashType || 'Unknown',
				exceptionType: attrs.exceptionType,
				exceptionMessage: attrs.exceptionMessage,
				logs: attrs.crashLogs?.map((log) => ({
					url: log.url,
					expiresAt: new Date(log.expiresAt),
				})) || [],
			},
		};
	}

	/**
	 * Processes raw screenshot feedback data into standardized format
	 * Handles both real API fields and legacy field names for backward compatibility
	 */
	private processScreenshotFeedback(
		screenshot: TestFlightScreenshotFeedback,
	): ProcessedFeedbackData {
		const attrs = screenshot.attributes;

		// Use real API fields with fallbacks to legacy fields
		const submittedAt = attrs.createdDate || attrs.submittedAt || new Date().toISOString();
		const bundleId = attrs.buildBundleId || attrs.bundleId || '';
		const deviceFamily = attrs.deviceFamily || 'UNKNOWN';
		const feedbackText = attrs.comment || attrs.feedbackText || '';

		// Extract app version and build number from other available data if not directly provided
		const appVersion = attrs.appVersion || 'Unknown';
		const buildNumber = attrs.buildNumber || 'Unknown';

		return {
			id: screenshot.id,
			type: "screenshot",
			submittedAt: new Date(submittedAt),
			appVersion,
			buildNumber,
			deviceInfo: {
				family: deviceFamily,
				model: attrs.deviceModel,
				osVersion: attrs.osVersion,
				locale: attrs.locale,
			},
			bundleId,
			testerInfo: attrs.email ? {
				email: attrs.email,
			} : undefined,
			screenshotData: {
				text: feedbackText,
				images: (attrs.screenshots || []).map((img, index) => ({
					url: img.url,
					fileName: img.fileName || `screenshot_${index}.png`,
					fileSize: img.fileSize || 0,
					expiresAt: new Date(img.expiresAt || Date.now() + 3600000), // Default 1 hour if missing
				})),
				annotations: attrs.annotations || [],
			},
		};
	}

	/**
	 * Merges enhanced crash metadata from detailed API response into processed crash data
	 */
	private mergeEnhancedCrashMetadata(
		processedCrash: ProcessedFeedbackData,
		detailedCrash: DetailedTestFlightCrashReport,
	): ProcessedFeedbackData {
		if (!processedCrash.crashData) {
			return processedCrash;
		}

		const attrs = detailedCrash.attributes;

		// Add enhanced system information
		const enhancedCrashData = {
			...processedCrash.crashData,
			systemInfo: {
				batteryPercentage: attrs.batteryPercentage,
				appUptimeInMilliseconds: attrs.appUptimeInMilliseconds,
				connectionType: attrs.connectionType,
				diskBytesAvailable: attrs.diskBytesAvailable,
				diskBytesTotal: attrs.diskBytesTotal,
				architecture: attrs.architecture,
				pairedAppleWatch: attrs.pairedAppleWatch,
				screenDimensions: {
					width: attrs.screenWidthInPoints,
					height: attrs.screenHeightInPoints,
				},
				// Derived/computed fields for better UX
				diskSpaceRemainingGB: attrs.diskBytesAvailable ?
					Math.round((attrs.diskBytesAvailable / (1024 ** 3)) * 10) / 10 : null,
				appUptimeFormatted: attrs.appUptimeInMilliseconds ?
					this.formatUptime(attrs.appUptimeInMilliseconds) : null,
			}
		};

		return {
			...processedCrash,
			crashData: enhancedCrashData,
		};
	}

	/**
	 * Formats uptime milliseconds into human-readable format
	 */
	private formatUptime(uptimeMs: number): string {
		const seconds = Math.floor(uptimeMs / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);

		if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
		if (hours > 0) return `${hours}h ${minutes % 60}m`;
		if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
		return `${seconds}s`;
	}

	/**
	 * Utility function for sleeping/waiting
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/**
 * Global client instance
 * Singleton pattern for API client management
 */
let _clientInstance: TestFlightClient | null = null;

export function getTestFlightClient(): TestFlightClient {
	if (!_clientInstance) {
		_clientInstance = new TestFlightClient();
	}
	return _clientInstance;
}

/**
 * Clears the global client instance (useful for testing)
 */
export function clearClientInstance(): void {
	_clientInstance = null;
}
