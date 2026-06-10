import {
	Plugin,
	MarkdownView,
	Notice,
} from "obsidian";
import {
	RinPublisherSettings,
	DEFAULT_SETTINGS,
	RinSettingTab,
} from "./settings";
import { RinApiClient, buildFeedPayload } from "./api";
import { parseFrontmatter } from "./frontmatter";

// Obsidian 支持的 SVG 图标，用于 ribbon 按钮
const RIBBON_ICON = "upload";

export default class RinPublisherPlugin extends Plugin {
	settings!: RinPublisherSettings;
	apiClient!: RinApiClient;
	private statusBarItem!: HTMLElement;

	// ---- Lifecycle ----------------------------------------------------------

	async onload() {
		await this.loadSettings();

		this.apiClient = new RinApiClient(this.settings.blogUrl);

		// 如果之前有 token 且未过期，直接设置
		if (
			this.settings.savedToken &&
			this.settings.tokenExpiresAt > Date.now()
		) {
			this.apiClient.setToken(this.settings.savedToken);
		}

		// 注册设置页
		this.addSettingTab(new RinSettingTab(this.app, this));

		// 状态栏指示器
		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.setText("Rin: ❌");
		this.statusBarItem.addClass("rin-status-bar");

		// Ribbon 按钮（侧边栏图标）
		this.addRibbonIcon(RIBBON_ICON, "推送当前笔记到 Rin", () => {
			this.pushCurrentNote(false);
		});

		// ---- 命令注册 ----

		// 命令 1: 推送为草稿
		this.addCommand({
			id: "rin-push-draft",
			name: "推送为草稿",
			icon: RIBBON_ICON,
			callback: () => this.pushCurrentNote(false),
		});

		// 命令 2: 推送并发布
		this.addCommand({
			id: "rin-push-publish",
			name: "推送并发布",
			icon: RIBBON_ICON,
			callback: () => this.pushCurrentNote(true),
		});

		// 命令 3: 根据 alias 匹配，有则更新，无则新建
		this.addCommand({
			id: "rin-sync-article",
			name: "同步文章（有则更新，无则新建）",
			icon: RIBBON_ICON,
			callback: () => this.syncArticle(),
		});

		// 更新状态栏
		this.updateStatusBar();
	}

	onunload() {
		// 清理
	}

	// ---- 核心逻辑 -----------------------------------------------------------

	/**
	 * 推送当前笔记到 Rin
	 * @param publishNow - true=直接发布, false=存草稿
	 */
	async pushCurrentNote(publishNow: boolean) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice("❌ 请先打开一篇 Markdown 笔记");
			return;
		}

		if (!this.settings.blogUrl) {
			new Notice("❌ 请先在设置中配置博客地址");
			return;
		}

		const file = view.file;
		if (!file) {
			new Notice("❌ 无法获取当前文件");
			return;
		}

		// 始终用 vault.read() 读取文件最新内容
		const rawContent = await this.app.vault.read(file);
		if (!rawContent || rawContent.trim().length === 0) {
			new Notice("❌ 当前笔记是空的");
			return;
		}

		// 解析 frontmatter 和正文
		const { frontmatter, body } = parseFrontmatter(rawContent, this.settings.includeFrontmatter);
		const payload = buildFeedPayload(frontmatter, body);

		// 覆盖 draft 状态
		payload.draft = !publishNow;

		// 调试: 打出 payload，帮助排查问题
		console.log("Rin Publisher: push payload", JSON.stringify(payload));

		new Notice(`⏳ 正在${publishNow ? "发布" : "推送草稿"}…`);

		try {
			await this.ensureAuthenticated();
			await this.pushOrSync(file.path, payload, publishNow ? "publish" : "draft");
			this.updateStatusBar();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const type = err instanceof Error ? err.constructor.name : typeof err;
			const detail = err instanceof Error ? err.stack : JSON.stringify(err);
			console.error("Rin Publisher push error:", { type, msg, detail, err });
			new Notice(`❌ 推送失败 [${type}]: ${msg}`);
		}
	}

	/**
	 * 同步模式：用本地映射 + alias 去匹配
	 * 有则更新，无则新建
	 */
	async syncArticle() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice("❌ 请先打开一篇 Markdown 笔记");
			return;
		}

		const file = view.file;
		if (!file) return;

		const rawContent = await this.app.vault.read(file);
		if (!rawContent || rawContent.trim().length === 0) {
			new Notice("❌ 当前笔记是空的");
			return;
		}

		const { frontmatter, body } = parseFrontmatter(rawContent, this.settings.includeFrontmatter);
		const payload = buildFeedPayload(frontmatter, body);

		if (!payload.alias) {
			new Notice("⚠️ 请在 frontmatter 中设置 alias 或 slug 才能使用同步功能");
			return;
		}

		new Notice(`⏳ 正在同步 (${payload.alias})…`);

		try {
			await this.ensureAuthenticated();
			await this.pushOrSync(file.path, payload, "sync");
			this.updateStatusBar();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const type = err instanceof Error ? err.constructor.name : typeof err;
			console.error("Rin Publisher sync error:", err);
			new Notice(`❌ 同步失败 [${type}]: ${msg}`);
		}
	}

	/**
	 * 统一推送/同步逻辑（三阶段）：
	 *   1. 本地映射 → 直接更新
	 *   2. alias 匹配 → 更新 + 保存映射
	 *   3. 都没有 → 新建 + 保存映射
	 *
	 * 这样即使服务端不存 alias（已知 chix.pp.ua 的 bug），
	 * 同一文件第二次推送也能 100% 命中更新，零额外 API 调用。
	 */
	private async pushOrSync(
		filePath: string,
		payload: import("./api").FeedPayload,
		mode: "draft" | "publish" | "sync",
	): Promise<void> {
		// ---- 阶段 1: 查本地映射（最快路径，无需网络） ----
		const mappedId = this.getLocalFeedId(filePath);
		if (mappedId !== null) {
			try {
				await this.apiClient.updateFeed(mappedId, payload);
				const label = mode === "draft" ? " [草稿]" : mode === "publish" ? " [已发布]" : "";
				new Notice(`✅ 已更新文章 #${mappedId}${label}`);
				return;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				// 映射失效（文章在后台被删了）→ 清除映射，继续往下走
				if (/not found/i.test(msg) || /404/i.test(msg)) {
					console.warn(`Rin Publisher: feed #${mappedId} 映射已失效，移除并重建`);
					delete this.settings.feedMap[filePath];
					await this.saveSettings();
				} else {
					throw err; // 其他错误抛给上层
				}
			}
		}

		// ---- 阶段 2: alias 匹配（兜底，跨设备迁移时有用） ----
		const alias = payload.alias;
		if (alias) {
			const existing = await this.apiClient.getFeedByAlias(alias);
			if (existing) {
				// 找到已有文章 → 保存映射 + 更新
				await this.saveFeedMapping(filePath, existing.id);
				await this.apiClient.updateFeed(existing.id, payload);
				new Notice(`✅ 已更新文章 #${existing.id} (${alias})`);
				return;
			}
		}

		// ---- 阶段 3: 新建文章 ----
		const insertedId = await this.createFeedWithRetry(filePath, payload, alias);
		const label = mode === "publish" ? "发布" : mode === "draft" ? "存入草稿箱" : "新建";
		new Notice(`✅ 已${label}，文章 ID: #${insertedId}${alias ? ` (${alias})` : ""}`);
	}

	/**
	 * 创建新文章，遇到 "Content already exists" 时自动恢复：
	 * 搜索已有文章 → 保存映射 → 更新内容
	 *
	 * 这解决了升级后首次推送的重复问题：v1.1.0 之前没有本地映射，
	 * 服务端又没有存 alias，第一次推送会撞到服务端的重复检测。
	 */
	private async createFeedWithRetry(
		filePath: string,
		payload: import("./api").FeedPayload,
		alias: string | undefined,
	): Promise<number> {
		try {
			const id = await this.apiClient.createFeed(payload);
			await this.saveFeedMapping(filePath, id);
			return id;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (/content.*(already\s+exists|exist)/i.test(msg)) {
				console.warn("Rin Publisher: 服务端返回重复，尝试按标题找回已有文章");
				// 按标题搜索，找精确匹配
				const results = await this.apiClient.searchFeeds(payload.title);
				const match = results.find(
					(f) => f.title === payload.title || f.content === payload.content,
				);
				if (match) {
					await this.saveFeedMapping(filePath, match.id);
					await this.apiClient.updateFeed(match.id, payload);
					new Notice(`♻️ 检测到重复，已更新现有文章 #${match.id}`);
					return match.id;
				}
				// 搜索也没找到 → 可能是标题变了，抛到上层
				throw new Error(
					`服务端返回"内容已存在"，但按标题搜索未找到匹配文章。` +
					`请手动在 Rin 后台删除重复文章后重试，或为该笔记设置 alias。`,
				);
			}
			throw err; // 其他错误原样抛
		}
	}

	/** 测试连接是否可用（返回布尔值） */
	async testConnection(): Promise<boolean> {
		const result = await this.testConnectionWithMessage();
		return result.ok;
	}

	/** 测试连接，返回详细结果（含错误信息） */
	async testConnectionWithMessage(): Promise<{ ok: boolean; message: string }> {
		this.apiClient = new RinApiClient(this.settings.blogUrl);

		if (!this.settings.blogUrl) {
			return { ok: false, message: "请先在设置中填写博客地址" };
		}

		// 有用户名密码 → 直接试登录（登录走 /api/ 路径，经过 CORS 中间件）
		if (this.settings.username && this.settings.password) {
			try {
				await this.apiClient.login(
					this.settings.username,
					this.settings.password,
				);
				// 缓存 token
				this.settings.savedToken = this.apiClient.getToken();
				this.settings.tokenExpiresAt = Date.now() + 3600_000;
				await this.saveSettings();
				this.updateStatusBar();
				return { ok: true, message: "登录成功" };
			} catch (err) {
				const msg =
					err instanceof Error ? err.message : String(err);
				return {
					ok: false,
					message: `登录失败: ${msg}（请检查用户名密码是否正确）`,
				};
			}
		}

		// 没有凭据 → 只做连通性检查
		const ok = await this.apiClient.healthCheck();
		if (ok) {
			return { ok: true, message: "服务器连通正常" };
		}
		return {
			ok: false,
			message:
				"无法连接到博客，请检查：1) 博客地址是否正确 2) 博客是否在运行 3) 是否有网络代理拦截",
		};
	}

	// ---- Internal -----------------------------------------------------------

	/**
	 * 确保已认证（有有效 token）
	 * token 过期或不存在 → 自动用用户名密码重新登录
	 */
	private async ensureAuthenticated() {
		// 如果有有效 token 直接用
		const hasToken =
			this.apiClient.getToken() ||
			(this.settings.savedToken &&
				this.settings.tokenExpiresAt > Date.now());

		if (hasToken) {
			if (this.apiClient.getToken()) return;
			// 从缓存恢复 token
			this.apiClient.setToken(this.settings.savedToken);
			return;
		}

		// 没有 token → 登录
		if (!this.settings.username || !this.settings.password) {
			throw new Error("请在设置中配置用户名和密码");
		}

		const token = await this.apiClient.login(
			this.settings.username,
			this.settings.password,
		);

		// 缓存 token
		this.settings.savedToken = token;
		this.settings.tokenExpiresAt = Date.now() + 3600_000; // 假设 1h 有效
		await this.saveSettings();
	}

	/**
	 * 查本地映射：filePath → feedId
	 * 纯本地，不消耗 API
	 */
	private getLocalFeedId(filePath: string): number | null {
		const id = this.settings.feedMap[filePath];
		return id && id > 0 ? id : null;
	}

	/** 保存 filePath → feedId 映射 */
	private async saveFeedMapping(filePath: string, feedId: number) {
		this.settings.feedMap[filePath] = feedId;
		await this.saveSettings();
	}

	private updateStatusBar() {
		const connected = this.settings.savedToken ? "✅" : "❌";
		this.statusBarItem.setText(`Rin: ${connected}`);
	}

	// ---- Settings Persistence -----------------------------------------------

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
