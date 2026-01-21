/**
 * Linear API Client
 * Secure utility for managing Linear issues, projects, and workflow integration via official Linear SDK
 */

import { LinearClient as LinearSDK } from "@linear/sdk";
import type {
	LinearComment,
	LinearIntegrationConfig,
	LinearIssue,
	LinearIssueLabel,
	LinearIssueStatus,
	LinearPriority,
	LinearProject,
	LinearTeam,
	LinearUser,
} from "../../types/linear.js";
import type { ProcessedFeedbackData } from "../../types/testflight.js";
import {
	DEFAULT_LABEL_CONFIG,
	ERROR_MESSAGES,
	PRIORITY_LEVELS,
	getConfiguration,
} from "../config/index.js";

/**
 * Linear API Client with official SDK integration, rate limiting awareness, and secure configuration
 */
export class LinearClient {
	private readonly config: LinearIntegrationConfig;
	private readonly sdk: LinearSDK;
	private teamCache: LinearTeam | null = null;

	constructor() {
		const envConfig = getConfiguration();

		if (!envConfig.linear) {
			throw new Error(ERROR_MESSAGES.LINEAR_CONFIG_MISSING);
		}

		this.config = {
			apiToken: envConfig.linear.apiToken,
			teamId: envConfig.linear.teamId,
			defaultPriority: PRIORITY_LEVELS.NORMAL,
			defaultLabels: [...DEFAULT_LABEL_CONFIG.defaultLabels],
			crashLabels: [...DEFAULT_LABEL_CONFIG.crashLabels],
			feedbackLabels: [...DEFAULT_LABEL_CONFIG.feedbackLabels],
			enableDuplicateDetection: true,
			duplicateDetectionDays: 7,
		};

		// Initialize the Linear SDK
		this.sdk = new LinearSDK({
			apiKey: this.config.apiToken,
		});
	}

	/**
	 * Creates a Linear issue from TestFlight feedback data
	 */
	public async createIssueFromTestFlight(
		feedback: ProcessedFeedbackData,
		additionalLabels: string[] = [],
		assigneeId?: string,
		projectId?: string,
		options?: {
			customTitle?: string;
			customDescription?: string;
			priority?: LinearPriority;
		},
	): Promise<LinearIssue> {
		try {
			// Check for duplicates if enabled
			if (this.config.enableDuplicateDetection) {
				const duplicateIssue = await this.findDuplicateIssue(feedback);
				if (duplicateIssue) {
					console.log(
						`Duplicate issue found: ${duplicateIssue.identifier}. Adding comment instead.`,
					);
					await this.addTestFlightCommentToIssue(duplicateIssue.id, feedback);
					return duplicateIssue;
				}
			}

			// Upload screenshots to Linear before creating the issue
			let screenshotUrls: Array<{ filename: string; url: string }> = [];
			console.log(`🔍 DEBUG Linear: screenshotData exists: ${!!feedback.screenshotData}`);
			console.log(`🔍 DEBUG Linear: images array: ${feedback.screenshotData?.images?.length || 0} items`);

			if (feedback.screenshotData?.images && feedback.screenshotData.images.length > 0) {
				console.log(`📸 Uploading ${feedback.screenshotData.images.length} screenshot(s) to Linear...`);
				const uploadResult = await this.uploadScreenshots(feedback);
				screenshotUrls = uploadResult.urls;
				console.log(`✅ Uploaded ${uploadResult.uploaded} screenshot(s), ${uploadResult.failed} failed`);
				console.log(`🔍 DEBUG Linear: Screenshot URLs: ${JSON.stringify(screenshotUrls)}`);

				// If upload failed, fall back to using Apple's direct URLs (they expire but better than nothing)
				if (screenshotUrls.length === 0 && feedback.screenshotData.images.length > 0) {
					console.log(`⚠️ Upload failed, falling back to Apple's direct URLs`);
					for (const img of feedback.screenshotData.images) {
						if (img.url) {
							screenshotUrls.push({
								filename: img.fileName || 'screenshot.png',
								url: img.url,
							});
						}
					}
					console.log(`📎 Using ${screenshotUrls.length} Apple direct URL(s) as fallback`);
				}
			} else {
				console.warn(`⚠️ No screenshot images available for Linear upload`);
			}

			console.log(`📝 Preparing Linear issue with ${screenshotUrls.length} screenshot URLs...`);
			const issueData = this.prepareIssueFromTestFlight(
				feedback,
				additionalLabels,
				assigneeId,
				projectId,
				options,
				screenshotUrls,
			);
			console.log(`📝 Linear issue data prepared: title="${issueData.title}", teamId=${issueData.teamId}`);
			console.log(`📝 Description preview (first 500 chars): ${issueData.description?.substring(0, 500)}...`);

			// Resolve label names to IDs
			const labelIds = await this.resolveLabelNamesToIds(issueData.labels);
			console.log(`🏷️ Resolved ${labelIds.length} label IDs from ${issueData.labels.length} label names`);

			// Create issue using Linear SDK
			console.log(`📤 Calling Linear SDK createIssue...`);
			const issueCreatePayload = await this.sdk.createIssue({
				title: issueData.title,
				description: issueData.description,
				teamId: issueData.teamId,
				priority: this.mapPriorityToLinearPriority(issueData.priority),
				assigneeId: issueData.assigneeId,
				projectId: issueData.projectId,
				labelIds: labelIds.length > 0 ? labelIds : undefined,
			});

			console.log(`📤 Linear SDK response: success=${issueCreatePayload.success}`);

			if (!issueCreatePayload.success) {
				throw new Error("Linear API error: Failed to create issue");
			}

			const createdIssue = await issueCreatePayload.issue;
			if (!createdIssue) {
				throw new Error("Failed to retrieve created issue from Linear");
			}

			// Convert to simplified LinearIssue format
			const linearIssue: LinearIssue =
				await this.convertToLinearIssue(createdIssue);

			console.log(
				`✅ Created Linear issue: ${linearIssue.identifier} - ${linearIssue.title}`,
			);
			return linearIssue;
		} catch (error) {
			console.error(`❌ Linear issue creation failed:`, error);
			throw new Error(
				`Failed to create Linear issue from TestFlight feedback: ${error}`,
			);
		}
	}

	/**
	 * Updates an existing Linear issue status
	 */
	public async updateIssueStatus(
		issueId: string,
		statusName: string,
	): Promise<LinearIssue> {
		try {
			const status = await this.getIssueStatusByName(statusName);

			const updatePayload = await this.sdk.updateIssue(issueId, {
				stateId: status.id,
			});

			if (!updatePayload.success) {
				throw new Error("Linear API error: Failed to update issue");
			}

			const updatedIssue = await updatePayload.issue;
			if (!updatedIssue) {
				throw new Error("Failed to retrieve updated issue from Linear");
			}

			return await this.convertToLinearIssue(updatedIssue);
		} catch (error) {
			throw new Error(`Failed to update Linear issue status: ${error}`);
		}
	}

	/**
	 * Adds a comment to an existing Linear issue
	 */
	public async addCommentToIssue(
		issueId: string,
		body: string,
	): Promise<LinearComment> {
		try {
			const commentPayload = await this.sdk.createComment({
				issueId,
				body,
			});

			if (!commentPayload.success) {
				throw new Error("Linear API error: Failed to create comment");
			}

			const comment = await commentPayload.comment;
			if (!comment) {
				throw new Error("Failed to retrieve created comment from Linear");
			}

			const issueBasic = await comment.issue;
			const team = await this.getTeam();

			// Create a minimal LinearIssue object for the comment
			const issueForComment: LinearIssue = issueBasic
				? await this.convertToLinearIssue(issueBasic)
				: {
					id: "unknown",
					identifier: "unknown",
					title: "Unknown Issue",
					description: "",
					url: "",
					priority: 3,
					state: {
						id: "unknown",
						name: "Unknown",
						description: "",
						color: "#000000",
						position: 0,
						type: "backlog",
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
						team,
					},
					assignee: undefined,
					team,
					labels: [],
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					estimate: 0,
					sortOrder: 0,
					number: 0,
					creator: await this.createFallbackUser(),
					parent: undefined,
					children: [],
					relations: [],
					comments: [],
					attachments: [],
					project: undefined,
					cycle: undefined,
					previousIdentifiers: [],
					customerTicketCount: 0,
					subscribers: [],
				};

			return {
				id: comment.id,
				body: comment.body,
				user: await this.convertToLinearUser(comment.user),
				issue: issueForComment,
				url: issueBasic ? `${issueBasic.url}#comment-${comment.id}` : "",
				createdAt: comment.createdAt.toISOString(),
				updatedAt: comment.updatedAt.toISOString(),
			};
		} catch (error) {
			throw new Error(`Failed to add comment to Linear issue: ${error}`);
		}
	}

	/**
	 * Searches for duplicate issues in Linear
	 */
	public async findDuplicateIssue(
		feedback: ProcessedFeedbackData,
	): Promise<LinearIssue | null> {
		try {
			// Use Linear's search API to find issues containing the TestFlight ID
			// Search for just the feedback ID since it's unique
			const searchQuery = feedback.id;

			// Use searchIssues for text-based search instead of filter operators
			const searchResults = await this.sdk.searchIssues(searchQuery, {
				first: 10,
			});

			for (const issue of searchResults.nodes) {
				// Verify the issue belongs to our team
				const team = await issue.team;
				if (team?.id !== this.config.teamId) {
					continue;
				}

				const description = await issue.description;
				// Check for feedback ID in any format (table, footer, or plain)
				// Table format: | **TestFlight ID** | `{id}` |
				// Footer format: ID:* `{id}`
				// Plain format: TestFlight ID: {id}
				if (description?.includes(feedback.id)) {
					console.log(`🔍 Found duplicate Linear issue for feedback ${feedback.id}: ${issue.identifier}`);
					return await this.convertToLinearIssue(issue);
				}
			}

			return null;
		} catch (error) {
			console.warn(`Error searching for duplicate issues: ${error}`);
			return null;
		}
	}

	/**
	 * Gets the configured team information
	 */
	public async getTeam(): Promise<LinearTeam> {
		if (this.teamCache) {
			return this.teamCache;
		}

		try {
			const team = await this.sdk.team(this.config.teamId);

			this.teamCache = await this.convertToLinearTeam(team);
			return this.teamCache;
		} catch (error) {
			throw new Error(`Failed to get Linear team: ${error}`);
		}
	}

	/**
	 * Gets the configured team ID for health checking
	 */
	public getConfiguredTeamId(): string {
		return this.config.teamId;
	}

	/**
	 * Tests basic Linear connectivity without full team validation
	 * Used by health checkers for lightweight connectivity testing
	 */
	public async testConnectivity(): Promise<boolean> {
		try {
			await this.getCurrentUser();
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Gets available issue statuses for the team
	 */
	public async getIssueStatuses(): Promise<LinearIssueStatus[]> {
		try {
			const states = await this.sdk.workflowStates({
				filter: {
					team: { id: { eq: this.config.teamId } },
				},
			});

			const statuses: LinearIssueStatus[] = [];
			for (const state of states.nodes) {
				statuses.push(await this.convertToLinearIssueStatus(state));
			}

			return statuses;
		} catch (error) {
			throw new Error(`Failed to get Linear issue statuses: ${error}`);
		}
	}

	/**
	 * Gets a specific issue status by name
	 */
	public async getIssueStatusByName(
		statusName: string,
	): Promise<LinearIssueStatus> {
		try {
			const states = await this.sdk.workflowStates({
				filter: {
					team: { id: { eq: this.config.teamId } },
					name: { eq: statusName },
				},
			});

			if (states.nodes.length === 0) {
				throw new Error(`Issue status '${statusName}' not found`);
			}

			return await this.convertToLinearIssueStatus(states.nodes[0]);
		} catch (error) {
			throw new Error(`Failed to get Linear issue status: ${error}`);
		}
	}

	/**
	 * Gets available issue labels for the team
	 */
	public async getIssueLabels(): Promise<LinearIssueLabel[]> {
		try {
			const labels = await this.sdk.issueLabels({
				filter: {
					team: { id: { eq: this.config.teamId } },
				},
			});

			const issueLabels: LinearIssueLabel[] = [];
			for (const label of labels.nodes) {
				issueLabels.push(await this.convertToLinearIssueLabel(label));
			}

			return issueLabels;
		} catch (error) {
			throw new Error(`Failed to get Linear issue labels: ${error}`);
		}
	}

	/**
	 * Resolves label names to Linear label IDs
	 * Creates labels if they don't exist
	 */
	private async resolveLabelNamesToIds(labelNames: string[]): Promise<string[]> {
		if (labelNames.length === 0) {
			return [];
		}

		try {
			// Fetch all available labels for the team
			const existingLabels = await this.sdk.issueLabels({
				filter: {
					team: { id: { eq: this.config.teamId } },
				},
			});

			const labelMap = new Map<string, string>();
			for (const label of existingLabels.nodes) {
				labelMap.set(label.name.toLowerCase(), label.id);
			}

			const resolvedIds: string[] = [];
			for (const name of labelNames) {
				const labelId = labelMap.get(name.toLowerCase());
				if (labelId) {
					resolvedIds.push(labelId);
				} else {
					// Try to create the label if it doesn't exist
					try {
						const createResult = await this.sdk.createIssueLabel({
							name: name,
							teamId: this.config.teamId,
						});
						if (createResult.success) {
							const newLabel = await createResult.issueLabel;
							if (newLabel) {
								resolvedIds.push(newLabel.id);
								console.log(`🏷️ Created new label: ${name}`);
							}
						}
					} catch (createError) {
						console.warn(`⚠️ Failed to create label "${name}": ${createError}`);
					}
				}
			}

			return resolvedIds;
		} catch (error) {
			console.warn(`⚠️ Error resolving label names to IDs: ${error}`);
			return [];
		}
	}

	/**
	 * Gets recent issues from Linear
	 */
	public async getRecentIssues(limit = 20): Promise<LinearIssue[]> {
		try {
			const issues = await this.sdk.issues({
				filter: {
					team: { id: { eq: this.config.teamId } },
				},
				first: limit,
			});

			const linearIssues: LinearIssue[] = [];
			for (const issue of issues.nodes) {
				linearIssues.push(await this.convertToLinearIssue(issue));
			}

			return linearIssues;
		} catch (error) {
			throw new Error(`Failed to get recent Linear issues: ${error}`);
		}
	}

	/**
	 * Gets projects from Linear
	 */
	public async getProjects(): Promise<LinearProject[]> {
		try {
			const projects = await this.sdk.projects();

			const linearProjects: LinearProject[] = [];
			for (const project of projects.nodes) {
				linearProjects.push(await this.convertToLinearProject(project));
			}

			return linearProjects;
		} catch (error) {
			throw new Error(`Failed to get Linear projects: ${error}`);
		}
	}

	/**
	 * Gets current user information
	 */
	public async getCurrentUser(): Promise<LinearUser> {
		try {
			const viewer = await this.sdk.viewer;
			return await this.convertToLinearUser(viewer);
		} catch (error) {
			throw new Error(`Failed to get current Linear user: ${error}`);
		}
	}

	/**
	 * Health check for Linear integration
	 */
	public async healthCheck(): Promise<{
		status: "healthy" | "unhealthy";
		details: {
			teamName?: string;
			teamKey?: string;
			currentUser?: string;
			configuredTeamId?: string;
			error?: string;
			timestamp: string;
		};
	}> {
		try {
			// Test basic connectivity
			const [team, user] = await Promise.all([
				this.getTeam(),
				this.getCurrentUser(),
			]);

			return {
				status: "healthy",
				details: {
					teamName: team.name,
					teamKey: team.key,
					currentUser: user.name,
					configuredTeamId: this.config.teamId,
					timestamp: new Date().toISOString(),
				},
			};
		} catch (error) {
			return {
				status: "unhealthy",
				details: {
					error: (error as Error).message,
					configuredTeamId: this.config.teamId,
					timestamp: new Date().toISOString(),
				},
			};
		}
	}

	/**
	 * Helper method to convert Linear SDK issue to our LinearIssue interface
	 */
	private async convertToLinearIssue(issue: any): Promise<LinearIssue> {
		const team = await this.getTeam();
		const state = await issue.state;
		const assignee = await issue.assignee;
		const creator = await issue.creator;

		return {
			id: issue.id,
			identifier: issue.identifier,
			title: issue.title,
			description: (await issue.description) || "",
			url: issue.url,
			priority: this.mapLinearPriorityToPriority(issue.priority),
			state: await this.convertToLinearIssueStatus(state),
			assignee: assignee ? await this.convertToLinearUser(assignee) : undefined,
			team,
			labels: [],
			createdAt: issue.createdAt.toISOString(),
			updatedAt: issue.updatedAt.toISOString(),
			estimate: issue.estimate || 0,
			sortOrder: issue.sortOrder || 0,
			number: issue.number,
			dueDate: issue.dueDate?.toISOString(),
			completedAt: issue.completedAt?.toISOString(),
			canceledAt: issue.canceledAt?.toISOString(),
			autoClosedAt: issue.autoClosedAt?.toISOString(),
			autoArchivedAt: issue.autoArchivedAt?.toISOString(),
			archivedAt: issue.archivedAt?.toISOString(),
			creator: creator
				? await this.convertToLinearUser(creator)
				: await this.createFallbackUser(),
			parent: undefined,
			children: [],
			relations: [],
			comments: [],
			attachments: [],
			project: undefined,
			cycle: undefined,
			previousIdentifiers: [],
			customerTicketCount: 0,
			subscribers: [],
		};
	}

	/**
	 * Creates a fallback user when no creator is available
	 */
	private async createFallbackUser(): Promise<LinearUser> {
		return {
			id: "unknown",
			name: "Unknown User",
			displayName: "Unknown User",
			email: "",
			avatarUrl: undefined,
			isMe: false,
			isAdmin: false,
			isGuest: true,
			active: false,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
	}

	/**
	 * Helper method to convert Linear SDK user to our LinearUser interface
	 */
	private async convertToLinearUser(user: any): Promise<LinearUser> {
		return {
			id: user.id,
			name: user.name,
			displayName: user.displayName || user.name,
			email: user.email,
			avatarUrl: user.avatarUrl,
			isMe: user.isMe || false,
			isAdmin: user.admin || false,
			isGuest: user.guest || false,
			active: user.active || true,
			createdAt: user.createdAt?.toISOString() || new Date().toISOString(),
			updatedAt: user.updatedAt?.toISOString() || new Date().toISOString(),
		};
	}

	/**
	 * Helper method to convert Linear SDK team to our LinearTeam interface
	 */
	private async convertToLinearTeam(team: any): Promise<LinearTeam> {
		return {
			id: team.id,
			name: team.name,
			key: team.key,
			description: (await team.description) || "",
			icon: team.icon,
			color: team.color,
			private: team.private || false,
			autoArchivePeriod: team.autoArchivePeriod || 0,
			autoCloseParentIssues: team.autoCloseParentIssues || false,
			cyclesEnabled: team.cyclesEnabled || false,
			cycleStartDay: team.cycleStartDay || 0,
			cycleDuration: team.cycleDuration || 1,
			cycleCooldownTime: team.cycleCooldownTime || 0,
			upcomingCycleCount: team.upcomingCycleCount || 0,
			timezone: team.timezone || "UTC",
			inviteHash: team.inviteHash || "",
			issueEstimationType: team.issueEstimationType || "notUsed",
			issueEstimationAllowZero: team.issueEstimationAllowZero || false,
			issueEstimationExtended: team.issueEstimationExtended || false,
			issueOrderingNoPriorityFirst: team.issueOrderingNoPriorityFirst || false,
			issueSortOrderDefaultToBottom:
				team.issueSortOrderDefaultToBottom || false,
			defaultIssueEstimate: team.defaultIssueEstimate,
			defaultTemplateForMembersId: team.defaultTemplateForMembersId,
			defaultTemplateForNonMembersId: team.defaultTemplateForNonMembersId,
			triageEnabled: team.triageEnabled || false,
			requirePriorityToLeaveTriage: team.requirePriorityToLeaveTriage || false,
			createdAt: team.createdAt?.toISOString() || new Date().toISOString(),
			updatedAt: team.updatedAt?.toISOString() || new Date().toISOString(),
			archivedAt: team.archivedAt?.toISOString(),
		};
	}

	/**
	 * Helper method to convert Linear SDK state to our LinearIssueStatus interface
	 */
	private async convertToLinearIssueStatus(
		state: any,
	): Promise<LinearIssueStatus> {
		const team = await this.getTeam();

		return {
			id: state.id,
			name: state.name,
			description: state.description,
			color: state.color,
			position: state.position || 0,
			type: this.mapStateTypeToLinearIssueState(state.type),
			createdAt: state.createdAt?.toISOString() || new Date().toISOString(),
			updatedAt: state.updatedAt?.toISOString() || new Date().toISOString(),
			archivedAt: state.archivedAt?.toISOString(),
			team,
		};
	}

	/**
	 * Helper method to convert Linear SDK label to our LinearIssueLabel interface
	 */
	private async convertToLinearIssueLabel(
		label: any,
	): Promise<LinearIssueLabel> {
		const team = await this.getTeam();

		return {
			id: label.id,
			name: label.name,
			color: label.color,
			description: (await label.description) || "",
			parent: undefined,
			children: [],
			createdAt: label.createdAt?.toISOString() || new Date().toISOString(),
			updatedAt: label.updatedAt?.toISOString() || new Date().toISOString(),
			archivedAt: label.archivedAt?.toISOString(),
			creator: await this.createFallbackUser(),
			team,
		};
	}

	/**
	 * Helper method to convert Linear SDK project to our LinearProject interface
	 */
	private async convertToLinearProject(project: any): Promise<LinearProject> {
		return {
			id: project.id,
			name: project.name,
			description: (await project.description) || "",
			slug: project.slug || project.name.toLowerCase().replace(/\s+/g, "-"),
			icon: project.icon,
			color: project.color,
			state: project.state || "planned",
			content: await project.content,
			priority: this.mapLinearPriorityToPriority(project.priority) as any,
			sortOrder: project.sortOrder || 0,
			startDate: project.startDate?.toISOString(),
			targetDate: project.targetDate?.toISOString(),
			completedAt: project.completedAt?.toISOString(),
			canceledAt: project.canceledAt?.toISOString(),
			autoArchivedAt: project.autoArchivedAt?.toISOString(),
			createdAt: project.createdAt?.toISOString() || new Date().toISOString(),
			updatedAt: project.updatedAt?.toISOString() || new Date().toISOString(),
			archivedAt: project.archivedAt?.toISOString(),
			creator: await this.convertToLinearUser(await project.creator),
			lead: undefined,
			members: [],
			teams: [],
			milestones: [],
			documents: [],
			links: [],
			requirements: [],
			roadmaps: [],
		};
	}

	/**
	 * Prepares Linear issue data from TestFlight feedback
	 */
	private prepareIssueFromTestFlight(
		feedback: ProcessedFeedbackData,
		additionalLabels: string[] = [],
		assigneeId?: string,
		projectId?: string,
		options?: {
			customTitle?: string;
			customDescription?: string;
			priority?: LinearPriority;
		},
		screenshotUrls: Array<{ filename: string; url: string }> = [],
	) {
		console.log(`🔍 prepareIssueFromTestFlight called with screenshotUrls.length=${screenshotUrls.length}`);
		console.log(`🔍 screenshotUrls contents: ${JSON.stringify(screenshotUrls)}`);
		const isCrash = feedback.type === "crash";
		const typeIcon = isCrash ? "💥" : "📱";
		const typeLabel = isCrash ? "Crash Report" : "User Feedback";

		// Generate title - use enhanced title if provided, otherwise generate standard title
		let title = options?.customTitle ||
			`${typeIcon} ${typeLabel}: ${feedback.appVersion} (${feedback.buildNumber})`;

		// If using standard title, add additional context
		if (!options?.customTitle) {
			if (isCrash && feedback.crashData?.exceptionType) {
				title += ` - ${feedback.crashData.exceptionType}`;
			} else if (feedback.screenshotData?.text) {
				const shortText = feedback.screenshotData.text.substring(0, 40);
				title += ` - ${shortText}${shortText.length < feedback.screenshotData.text.length ? "..." : ""}`;
			}
		}

		// Generate description - use enhanced description if provided, otherwise generate standard description
		let description = options?.customDescription ||
			this.generateStandardDescription(feedback, typeIcon, typeLabel, screenshotUrls);

		// Always append screenshots to description if we have URLs (even with custom descriptions)
		// Custom descriptions from LLM don't include screenshots, so we need to add them
		console.log(`🔍 DEBUG: customDescription=${!!options?.customDescription}, screenshotUrls.length=${screenshotUrls.length}`);
		if (screenshotUrls.length > 0) {
			console.log(`📸 Appending ${screenshotUrls.length} screenshots to description`);
			description += "\n\n### 📸 Screenshots\n\n";
			for (const screenshot of screenshotUrls) {
				description += `**${screenshot.filename}:**\n`;
				description += `![${screenshot.filename}](${screenshot.url})\n\n`;
			}
		} else {
			console.log(`⚠️ No screenshot URLs to append`);
		}

		// Determine labels
		const baseLabels = isCrash
			? this.config.crashLabels
			: this.config.feedbackLabels;
		const allLabels = [
			...this.config.defaultLabels,
			...baseLabels,
			...additionalLabels,
		];

		// Determine priority - use enhanced priority if provided, otherwise use default logic
		let priority = options?.priority || this.config.defaultPriority;
		if (!options?.priority && isCrash) {
			priority = 2; // High priority for crashes when not using enhanced priority
		}

		return {
			title,
			description,
			teamId: this.config.teamId,
			priority,
			assigneeId,
			projectId,
			labels: allLabels,
		};
	}

	/**
	 * Generates standard description for Linear issues from TestFlight feedback
	 */
	private generateStandardDescription(
		feedback: ProcessedFeedbackData,
		typeIcon: string,
		typeLabel: string,
		screenshotUrls: Array<{ filename: string; url: string }> = [],
	): string {
		const isCrash = feedback.type === "crash";

		// Start with header
		let description = `## ${typeIcon} ${typeLabel} from TestFlight\n\n`;

		// Metadata table
		description += "| Field | Value |\n";
		description += "|-------|-------|\n";
		description += `| **TestFlight ID** | \`${feedback.id}\` |\n`;
		description += `| **App Version** | ${feedback.appVersion} (Build ${feedback.buildNumber}) |\n`;
		description += `| **Submitted** | ${feedback.submittedAt.toISOString()} |\n`;
		description += `| **Device** | ${feedback.deviceInfo.model} |\n`;
		description += `| **OS Version** | ${feedback.deviceInfo.osVersion} |\n`;
		description += `| **Locale** | ${feedback.deviceInfo.locale} |\n`;

		// Add tester info if available
		if (feedback.testerInfo?.email) {
			description += `| **Submitted By** | ${feedback.testerInfo.email} |\n`;
		}
		description += "\n";

		if (isCrash && feedback.crashData) {
			description += "### 🔍 Crash Details\n\n";
			description += `**Type:** ${feedback.crashData.type}\n\n`;

			if (feedback.crashData.exceptionType) {
				description += `**Exception:** \`${feedback.crashData.exceptionType}\`\n\n`;
			}

			if (feedback.crashData.exceptionMessage) {
				description += `**Message:**\n\`\`\`\n${feedback.crashData.exceptionMessage}\n\`\`\`\n\n`;
			}

			// ENHANCEMENT: Add system context for better debugging
			if (feedback.crashData.systemInfo) {
				description += "### 📊 System Context at Crash\n\n";
				const sysInfo = feedback.crashData.systemInfo;

				description += "| Context | Value |\n";
				description += "|---------|-------|\n";

				if (sysInfo.batteryPercentage !== undefined) {
					const batteryIcon = sysInfo.batteryPercentage < 20 ? "🪫" : sysInfo.batteryPercentage < 50 ? "🔋" : "🔋";
					description += `| ${batteryIcon} **Battery** | ${sysInfo.batteryPercentage}% |\n`;
				}

				if (sysInfo.appUptimeFormatted) {
					description += `| ⏱️ **App Uptime** | ${sysInfo.appUptimeFormatted} |\n`;
				}

				if (sysInfo.connectionType) {
					const connectionIcon = sysInfo.connectionType.toLowerCase().includes('wifi') ? "📶" : "📱";
					description += `| ${connectionIcon} **Connection** | ${sysInfo.connectionType} |\n`;
				}

				if (sysInfo.diskSpaceRemainingGB !== null && sysInfo.diskSpaceRemainingGB !== undefined) {
					const spaceIcon = sysInfo.diskSpaceRemainingGB < 1 ? "💾" : "💿";
					description += `| ${spaceIcon} **Free Space** | ${sysInfo.diskSpaceRemainingGB}GB |\n`;
				}

				if (sysInfo.architecture) {
					description += `| 🏗️ **Architecture** | ${sysInfo.architecture} |\n`;
				}

				if (sysInfo.pairedAppleWatch) {
					description += `| ⌚ **Apple Watch** | ${sysInfo.pairedAppleWatch} |\n`;
				}

				description += "\n";
			}

			description += `### Stack Trace\n\`\`\`\n${feedback.crashData.trace}\n\`\`\`\n\n`;

			if (feedback.crashData.logs.length > 0) {
				description += "### Crash Logs\n";
				feedback.crashData.logs.forEach((log, index) => {
					description += `- [Crash Log ${index + 1}](${log.url}) (expires: ${log.expiresAt.toLocaleDateString()})\n`;
				});
				description += "\n";
			}
		}

		if (feedback.screenshotData) {
			description += "### 📝 User Feedback\n\n";

			if (feedback.screenshotData.text) {
				description += `**Feedback Text:**\n> ${feedback.screenshotData.text.replace(/\n/g, "\n> ")}\n\n`;
			}

			// Show enhanced tester notes if available
			if (feedback.screenshotData.testerNotes) {
				description += `**Tester Notes:**\n> ${feedback.screenshotData.testerNotes.replace(/\n/g, "\n> ")}\n\n`;
			}

			if (feedback.screenshotData.images.length > 0) {
				description += "### 📸 Screenshots\n\n";

				// Include uploaded screenshots as embedded images
				if (screenshotUrls.length > 0) {
					for (const screenshot of screenshotUrls) {
						description += `**${screenshot.filename}:**\n`;
						description += `![${screenshot.filename}](${screenshot.url})\n\n`;
					}
				} else {
					// Fallback if no uploads succeeded - mention the count
					description += `*${feedback.screenshotData.images.length} screenshot(s) were submitted but could not be uploaded.*\n\n`;
				}
			}

			if (
				feedback.screenshotData.annotations &&
				feedback.screenshotData.annotations.length > 0
			) {
				description += `**Annotations:** ${feedback.screenshotData.annotations.length} user annotation(s)\n\n`;
			}

			// Add submission method and system info if available
			if (feedback.screenshotData.submissionMethod) {
				description += `**Submission Method:** ${feedback.screenshotData.submissionMethod}\n\n`;
			}

			if (feedback.screenshotData.systemInfo) {
				description += this.formatSystemInfo(feedback.screenshotData.systemInfo);
			}
		}

		// Technical details
		description += "### 🛠️ Technical Information\n\n";
		description +=
			"<details>\n<summary>Device & Environment Details</summary>\n\n";
		description += `- **Device Family:** ${feedback.deviceInfo.family}\n`;
		description += `- **Device Model:** ${feedback.deviceInfo.model}\n`;
		description += `- **OS Version:** ${feedback.deviceInfo.osVersion}\n`;
		description += `- **Locale:** ${feedback.deviceInfo.locale}\n`;
		description += `- **Bundle ID:** ${feedback.bundleId}\n`;
		description += `- **Submission Time:** ${feedback.submittedAt.toISOString()}\n`;
		description += "\n</details>\n\n";

		description += `---\n*Automatically created from TestFlight feedback. ID: \`${feedback.id}\`*`;

		return description;
	}

	/**
	 * Adds a TestFlight-specific comment to an existing issue
	 */
	private async addTestFlightCommentToIssue(
		issueId: string,
		feedback: ProcessedFeedbackData,
	): Promise<LinearComment> {
		const typeIcon = feedback.type === "crash" ? "💥" : "📱";

		let commentBody = `${typeIcon} **Additional TestFlight ${feedback.type} report**\n\n`;
		commentBody += `**TestFlight ID:** ${feedback.id}\n`;
		commentBody += `**Submitted:** ${feedback.submittedAt.toISOString()}\n`;
		commentBody += `**Device:** ${feedback.deviceInfo.model} (${feedback.deviceInfo.osVersion})\n`;

		if (feedback.screenshotData?.text) {
			commentBody += `\n**User Feedback:**\n> ${feedback.screenshotData.text}`;
		}

		return await this.addCommentToIssue(issueId, commentBody);
	}

	/**
	 * Maps our priority enum to Linear's priority number
	 */
	private mapPriorityToLinearPriority(
		priority: LinearPriority | number,
	): number {
		if (typeof priority === "number") {
			return priority;
		}

		switch (priority) {
			case 1:
				return 1; // Urgent
			case 2:
				return 2; // High
			case 3:
				return 3; // Normal
			case 4:
				return 4; // Low
			default:
				return 3; // Normal
		}
	}

	/**
	 * Maps Linear's priority number to our priority enum
	 */
	private mapLinearPriorityToPriority(priority?: number): LinearPriority {
		switch (priority) {
			case 1:
				return 1; // Urgent
			case 2:
				return 2; // High
			case 3:
				return 3; // Normal
			case 4:
				return 4; // Low
			default:
				return 3; // Normal
		}
	}

	/**
	 * Maps Linear state type to our issue state enum
	 */
	private mapStateTypeToLinearIssueState(
		stateType: string,
	): "backlog" | "unstarted" | "started" | "completed" | "canceled" {
		switch (stateType) {
			case "backlog":
				return "backlog";
			case "unstarted":
				return "unstarted";
			case "started":
				return "started";
			case "completed":
				return "completed";
			case "canceled":
				return "canceled";
			default:
				return "backlog";
		}
	}

	/**
	 * Formats enhanced system information for display (DRY helper)
	 */
	private formatSystemInfo(systemInfo: any): string {
		if (!systemInfo) {
			return "";
		}

		let info = "**System Information:**\n";

		if (systemInfo.applicationState) {
			info += `- Application State: ${systemInfo.applicationState}\n`;
		}

		if (systemInfo.memoryPressure) {
			info += `- Memory Pressure: ${systemInfo.memoryPressure}\n`;
		}

		if (systemInfo.batteryLevel !== undefined) {
			info += `- Battery Level: ${(systemInfo.batteryLevel * 100).toFixed(0)}%\n`;
		}

		if (systemInfo.batteryState) {
			info += `- Battery State: ${systemInfo.batteryState}\n`;
		}

		if (systemInfo.thermalState) {
			info += `- Thermal State: ${systemInfo.thermalState}\n`;
		}

		if (systemInfo.diskSpaceRemaining !== undefined) {
			const diskSpaceGB = (systemInfo.diskSpaceRemaining / (1024 * 1024 * 1024)).toFixed(1);
			info += `- Available Storage: ${diskSpaceGB} GB\n`;
		}

		return info + "\n";
	}

	/**
	 * Uploads screenshots to Linear's file storage and returns the asset URLs
	 */
	public async uploadScreenshots(
		feedback: ProcessedFeedbackData,
	): Promise<{
		uploaded: number;
		failed: number;
		urls: Array<{ filename: string; url: string }>;
	}> {
		const results = {
			uploaded: 0,
			failed: 0,
			urls: [] as Array<{ filename: string; url: string }>,
		};

		if (!feedback.screenshotData?.images || feedback.screenshotData.images.length === 0) {
			return results;
		}

		for (let i = 0; i < feedback.screenshotData.images.length; i++) {
			const imageInfo = feedback.screenshotData.images[i];
			// Skip if imageInfo is undefined
			if (!imageInfo) {
				console.warn(`⚠️ Screenshot ${i} is undefined, skipping`);
				continue;
			}
			// Generate fallback filename if missing
			const fileName = imageInfo.fileName || `screenshot_${i}.png`;

			try {
				let imageData: Uint8Array;

				// Use cached data if available (pre-downloaded to avoid URL expiration)
				if (imageInfo.cachedData) {
					console.log(`📸 Using cached screenshot: ${fileName}`);
					imageData = imageInfo.cachedData;
				} else {
					// Fall back to downloading if not cached
					// Check if URL hasn't expired
					if (imageInfo.expiresAt <= new Date()) {
						console.warn(`Screenshot URL expired: ${imageInfo.url}`);
						results.failed++;
						continue;
					}

					// Download the screenshot from TestFlight's temporary URL
					console.log(`📸 Downloading screenshot: ${fileName}`);
					const response = await fetch(imageInfo.url, {
						headers: { "User-Agent": "TestFlight-PM/1.0" },
						signal: AbortSignal.timeout(30000),
					});

					if (!response.ok) {
						console.warn(`Failed to download screenshot: ${response.status} ${response.statusText}`);
						results.failed++;
						continue;
					}

					imageData = new Uint8Array(await response.arrayBuffer());
				}

				const contentType = this.getContentTypeFromFileName(fileName);

				// Request upload URL from Linear
				console.log(`📤 Requesting Linear upload URL for: ${fileName}`);
				const uploadPayload = await this.sdk.fileUpload(
					contentType,
					fileName,
					imageData.length,
				);

				if (!uploadPayload.success || !uploadPayload.uploadFile) {
					console.warn(`Failed to get upload URL for ${fileName}`);
					results.failed++;
					continue;
				}

				const { uploadUrl, assetUrl, headers: uploadHeaders } = uploadPayload.uploadFile;

				// Build headers for the upload request
				const headers = new Headers();
				headers.set("Content-Type", contentType);
				headers.set("Cache-Control", "public, max-age=31536000");
				for (const { key, value } of uploadHeaders) {
					headers.set(key, value);
				}

				// Upload the file to Linear's storage
				console.log(`⬆️ Uploading ${fileName} to Linear...`);
				const uploadResponse = await fetch(uploadUrl, {
					method: "PUT",
					headers,
					body: imageData,
				});

				if (!uploadResponse.ok) {
					console.warn(`Failed to upload ${fileName}: ${uploadResponse.status}`);
					results.failed++;
					continue;
				}

				console.log(`✅ Successfully uploaded ${fileName}`);
				results.uploaded++;
				results.urls.push({ filename: fileName, url: assetUrl });
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				console.warn(`Error uploading screenshot ${fileName}: ${errorMessage}`);
				results.failed++;
			}
		}

		return results;
	}

	/**
	 * Gets MIME content type from filename
	 */
	private getContentTypeFromFileName(fileName?: string): string {
		if (!fileName) {
			return 'image/png';
		}
		const extension = fileName.toLowerCase().split('.').pop();
		switch (extension) {
			case 'png':
				return 'image/png';
			case 'jpg':
			case 'jpeg':
				return 'image/jpeg';
			case 'heic':
				return 'image/heic';
			default:
				return 'image/png';
		}
	}
}

// Global Linear client instance
let _linearClientInstance: LinearClient | null = null;

export function getLinearClient(): LinearClient {
	if (!_linearClientInstance) {
		_linearClientInstance = new LinearClient();
	}
	return _linearClientInstance;
}

/**
 * Clears the global Linear client instance (useful for testing)
 */
export function clearLinearClientInstance(): void {
	_linearClientInstance = null;
}

/**
 * Utility function to validate Linear configuration
 */
export function validateLinearConfig(): boolean {
	try {
		const config = getConfiguration();
		return !!(config.linear?.apiToken && config.linear?.teamId);
	} catch {
		return false;
	}
}
