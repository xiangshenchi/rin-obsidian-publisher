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

		new Notice(`⏳ 正在${publishNow ? "发布" : "推送草稿"}…`);

		try {
			await this.ensureAuthenticated();

			let articleId: number;

			// 方式1: 如果有 alias/slug，按 alias 精确匹配
			const alias = payload.alias;
			if (alias) {
				const existing = await this.apiClient.getFeedByAlias(alias);
				if (existing) {
					await this.apiClient.updateFeed(existing.id, payload);
					articleId = existing.id;
					new Notice(
						`✅ 已更新文章 #${articleId} (${alias})${publishNow ? " [已发布]" : " [草稿]"}`,
					);
					this.updateStatusBar();
					return;
				}
			}

			// 方式2: 按标题匹配已有草稿（即使没有 alias 也能更新）
			const drafts = await this.apiClient.listFeeds("draft");
			const matchByTitle = drafts.find(
				(d) => d.title === payload.title && d.draft,
			);
			if (matchByTitle) {
				await this.apiClient.updateFeed(matchByTitle.id, payload);
				articleId = matchByTitle.id;
				new Notice(
					`✅ 已更新草稿 #${articleId}（标题匹配）${publishNow ? "[已发布]" : ""}`,
				);
				this.updateStatusBar();
				return;
			}

			// 方式3: 没有匹配 → 新建
			const insertedId = await this.apiClient.createFeed(payload);
			new Notice(
				`✅ 已${publishNow ? "发布" : "存入草稿箱"}，文章 ID: #${insertedId}`,
			);

			this.updateStatusBar();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const type = err instanceof Error ? err.constructor.name : typeof err;
			console.error("Rin Publisher full error:", err);
			new Notice(`❌ 推送失败 [${type}]: ${msg}`);
		}
	}

	/**
	 * 同步模式：用 frontmatter 中的 alias/slug 去匹配
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
		const alias = payload.alias;

		if (!alias) {
			new Notice("⚠️ 请在 frontmatter 中设置 alias 或 slug 才能使用同步功能");
			return;
		}

		new Notice(`⏳ 正在同步 (${alias})…`);

		try {
			await this.ensureAuthenticated();

			const existing = await this.apiClient.getFeedByAlias(alias);

			if (existing) {
				await this.apiClient.updateFeed(existing.id, payload);
				new Notice(`✅ 已更新文章 #${existing.id} (${alias})`);
			} else {
				const id = await this.apiClient.createFeed(payload);
				new Notice(`✅ 已新建文章 #${id} (${alias})`);
			}

			this.updateStatusBar();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const type = err instanceof Error ? err.constructor.name : typeof err;
			console.error("Rin Publisher sync error:", err);
			new Notice(`❌ 同步失败 [${type}]: ${msg}`);
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
