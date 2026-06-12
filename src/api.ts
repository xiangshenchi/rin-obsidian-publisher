/**
 * Rin Blog API Client
 *
 * API 参考: https://github.com/openRin/Rin
 * - 所有 /api/* 路径由 Cloudflare Worker 的 fetch-handler 统一处理
 * - 文章在 Rin 中称为 "feed"
 * - 认证方式: JWT Bearer Token (首次登录获取，后续复用)
 */

/** 创建/更新文章时的请求体 */
export interface FeedPayload {
	title: string;
	content: string;
	summary?: string;
	alias?: string;
	draft?: boolean;
	listed?: boolean;
	tags?: string[];
	top?: boolean;
}

/** API 返回的文章数据结构（关键字段） */
export interface Feed {
	id: number;
	alias: string;
	title: string;
	content: string;
	summary: string;
	draft: boolean;
	listed: boolean;
	top: boolean;
	tags: string[];
	createdAt: string;
	updatedAt: string;
}

/** 登录响应 */
interface LoginResponse {
	token: string;
	uid: number;
	username: string;
	message?: string;
	error?: string;
}

/** 创建文章响应 */
interface CreateFeedResponse {
	insertedId: number;
	message?: string;
}

/** API 错误响应 */
interface ApiError {
	message?: string;
	error?: string;
}

// ---------------------------------------------------------------------------

/** 根据 frontmatter + 正文构建 FeedPayload */
export function buildFeedPayload(
	frontmatter: Record<string, unknown>,
	body: string,
): FeedPayload {
	const title =
		(typeof frontmatter.title === "string" ? frontmatter.title : "") ||
		extractTitleFromBody(body) ||
		"Untitled";

	const tags = extractTags(frontmatter);

	return {
		title,
		content: body,
		summary:
			typeof frontmatter.summary === "string"
				? frontmatter.summary
				: typeof frontmatter.description === "string"
					? frontmatter.description
					: undefined,
		alias:
			typeof frontmatter.alias === "string"
				? frontmatter.alias
				: typeof frontmatter.slug === "string"
					? frontmatter.slug
					: typeof frontmatter.aliases === "string"
						? frontmatter.aliases
						: Array.isArray(frontmatter.aliases) && frontmatter.aliases.length > 0
							? String(frontmatter.aliases[0])
							: undefined,
		draft: true, // 默认推送到草稿箱
		listed: frontmatter.listed !== false,
		tags, // 始终发送数组（空数组 [] 也比 undefined 安全，Rin 会遍历 tags）
	};
}

/** 从正文第一行提取标题（# 标题） */
function extractTitleFromBody(body: string): string | null {
	const match = body.match(/^#\s+(.+)/m);
	return match ? match[1].trim() : null;
}

/** 从 frontmatter 提取标签（去掉 # 前缀） */
function extractTags(frontmatter: Record<string, unknown>): string[] {
	const raw = frontmatter.tags ?? frontmatter.tag ?? [];
	if (Array.isArray(raw)) {
		return raw.map(String).map(cleanTag).filter(Boolean);
	}
	if (typeof raw === "string") {
		return raw.split(/[,，\s]+/).map(cleanTag).filter(Boolean);
	}
	return [];
}

/** 去掉标签中的 # 前缀和首尾空白 */
function cleanTag(tag: string): string {
	return tag.trim().replace(/^#+/, "");
}

// ---------------------------------------------------------------------------

export class RinApiClient {
	private baseUrl: string;
	private token: string = "";

	constructor(baseUrl: string) {
		// 去掉末尾 /
		this.baseUrl = baseUrl.replace(/\/+$/, "");
	}

	/** 设置已有 token（从缓存加载） */
	setToken(token: string) {
		this.token = token;
	}

	getToken(): string {
		return this.token;
	}

	// ---- Auth ---------------------------------------------------------------

	/**
	 * 登录获取 JWT Token
	 * POST /api/auth/login
	 */
	async login(username: string, password: string): Promise<string> {
		const res = await this.fetch("/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username, password }),
		});

		const data = (await res.json()) as LoginResponse;

		if (!res.ok) {
			throw new Error(data.message || data.error || `Login failed (${res.status})`);
		}

		if (!data.token) {
			throw new Error("Login succeeded but no token returned");
		}

		this.token = data.token;
		return data.token;
	}

	// ---- Feed (Article) CRUD ------------------------------------------------

	/**
	 * 创建文章（feed）
	 * POST /api/feed
	 */
	async createFeed(payload: FeedPayload): Promise<number> {
		console.log("Rin API: createFeed payload", JSON.stringify(payload));
		const res = await this.fetch("/api/feed", {
			method: "POST",
			headers: this.authHeaders(),
			body: JSON.stringify(payload),
		});

		const text = await res.text();
		console.log(`Rin API: createFeed response ${res.status}`, text);

		if (!res.ok) {
			// 尝试解析为 JSON，不行就用原始文本
			try {
				const data = JSON.parse(text) as ApiError;
				throw new Error(data.message || data.error || `Create failed (${res.status})`);
			} catch {
				throw new Error(text || `Create failed (${res.status})`);
			}
		}

		try {
			const data = JSON.parse(text) as CreateFeedResponse;
			return data.insertedId;
		} catch {
			throw new Error(`Create succeeded but response not JSON: ${text}`);
		}
	}

	/**
	 * 更新文章
	 * POST /api/feed/:id
	 */
	async updateFeed(id: number, payload: Partial<FeedPayload>): Promise<void> {
		console.log("Rin API: updateFeed", id, JSON.stringify(payload));
		const res = await this.fetch(`/api/feed/${id}`, {
			method: "POST",
			headers: this.authHeaders(),
			body: JSON.stringify(payload),
		});

		if (!res.ok) {
			const text = await res.text();
			console.warn(`Rin API: updateFeed failed ${res.status}`, text);
			try {
				const data = JSON.parse(text) as ApiError;
				throw new Error(data.message || data.error || `Update failed (${res.status})`);
			} catch {
				throw new Error(text || `Update failed (${res.status})`);
			}
		}
	}

	/**
	 * 获取文章列表（支持按类型过滤）
	 * GET /api/feed?type=draft|unlisted|normal
	 *
	 * Rin 返回格式: { size: number, data: Feed[], hasNext: boolean }
	 */
	async listFeeds(type?: "draft" | "unlisted" | "normal"): Promise<Feed[]> {
		const params = type ? `?type=${type}` : "";
		const res = await this.fetch(`/api/feed${params}`, {
			method: "GET",
			headers: this.authHeaders(),
		});

		if (!res.ok) {
			const text = await res.text();
			console.warn("Rin API: listFeeds failed", res.status, text);
			throw new Error(text || `List feeds failed (${res.status})`);
		}

		const body = (await res.json()) as {
			size: number;
			data: Feed[];
			hasNext: boolean;
		};
		return body.data ?? [];
	}

	/**
	 * 根据 alias（slug）查找文章
	 * GET /api/feed/:alias
	 */
	async getFeedByAlias(alias: string): Promise<Feed | null> {
		const res = await this.fetch(`/api/feed/${encodeURIComponent(alias)}`, {
			method: "GET",
			headers: this.authHeaders(),
		});

		if (res.status === 404) return null;
		if (!res.ok) {
			const data = (await res.json()) as ApiError;
			throw new Error(data.message || data.error || `Get feed failed (${res.status})`);
		}

		return res.json() as Promise<Feed>;
	}

	/**
	 * 搜索文章（按标题/内容/别名）
	 * GET /api/search/:keyword
	 *
	 * Rin 的 search 端点返回匹配 title / content / summary / alias 的结果。
	 * 已认证时返回草稿+已发布，未认证只返回已发布。
	 */
	async searchFeeds(keyword: string): Promise<Feed[]> {
		const res = await this.fetch(`/api/search/${encodeURIComponent(keyword)}`, {
			method: "GET",
			headers: this.authHeaders(),
		});

		if (!res.ok) {
			const data = (await res.json()) as ApiError;
			throw new Error(data.message || data.error || `Search failed (${res.status})`);
		}

		const body = (await res.json()) as {
			size: number;
			data: Feed[];
			hasNext: boolean;
		};
		return body.data ?? [];
	}

	// ---- Cache ---------------------------------------------------------------

	/**
	 * 清除服务端 localStorage 缓存
	 * DELETE /api/config/cache
	 *
	 * 在 Obsidian 端推送/更新文章后调用，确保 Rin 编辑器页能从服务端
	 * 拉取到最新数据，而不是被过期的 localStorage 覆盖。
	 */
	async clearServerCache(): Promise<void> {
		try {
			await this.fetch("/api/config/cache", {
				method: "DELETE",
				headers: this.authHeaders(),
			});
		} catch (err) {
			console.warn("Rin API: clearServerCache failed (non-fatal)", err);
		}
	}

	// ---- 便捷方法 -----------------------------------------------------------

	/**
	 * 一步到位：登录 → 创建草稿
	 * 返回文章 ID
	 */
	async loginAndCreateDraft(
		username: string,
		password: string,
		payload: FeedPayload,
	): Promise<number> {
		await this.login(username, password);
		return this.createFeed({ ...payload, draft: true });
	}

	/**
	 * 一步到位：登录 → 创建或更新文章
	 * - 如果提供了 alias 且服务端已有同 alias 的文章 → 更新
	 * - 否则 → 新建
	 */
	async loginAndSync(
		username: string,
		password: string,
		payload: FeedPayload,
		existingAlias?: string,
	): Promise<{ action: "created" | "updated"; id: number }> {
		await this.login(username, password);

		// 如果指定了 alias，尝试查找已有文章
		const alias = existingAlias || payload.alias;
		if (alias) {
			const existing = await this.getFeedByAlias(alias);
			if (existing) {
				await this.updateFeed(existing.id, payload);
				return { action: "updated", id: existing.id };
			}
		}

		const id = await this.createFeed(payload);
		return { action: "created", id };
	}

	// ---- Internal -----------------------------------------------------------

	private authHeaders(): Record<string, string> {
		if (!this.token) {
			throw new Error("Not authenticated. Please login first or set a token.");
		}
		return {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.token}`,
		};
	}

	private async fetch(path: string, init: RequestInit): Promise<Response> {
		const url = `${this.baseUrl}${path}`;
		try {
			const res = await fetch(url, init);
			return res;
		} catch (err) {
			throw new Error(
				`Network error connecting to ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/**
	 * 检查服务端连通性
	 *
	 * 注意: Rin 的首页 / 不经过 CORS 中间件（直接 new Response("Hi")），
	 * 所以跨域请求会失败。改用 RSS 端点（/api/feed/timeline），这些经过 CORS。
	 */
	async healthCheck(): Promise<boolean> {
		// 先试首页（同域调试时可用）
		try {
			const res = await this.fetch("/", { method: "GET" });
			if (res.ok) return true;
		} catch {
			// 跨域情况下首页会被 CORS 拦截，走下面的备用路径
		}

		// 备用: 用 API 端点（经过 CORS 中间件）
		try {
			const res = await this.fetch("/api/feed/timeline", {
				method: "GET",
				// 不加 Authorization，公开接口
			});
			// 只要能连上就算通（200=有内容, 403=无权限但CORS通了）
			return res.status === 200 || res.status === 403;
		} catch {
			return false;
		}
	}
}
