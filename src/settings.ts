import {
	App,
	PluginSettingTab,
	Setting,
	Notice,
} from "obsidian";
import RinPublisherPlugin from "./main";

/**
 * 插件设置项
 */
export interface RinPublisherSettings {
	/** Rin 博客地址（不含末尾 /），如 https://blog.example.com */
	blogUrl: string;
	/** 登录用户名 */
	username: string;
	/** 登录密码 */
	password: string;
	/** 缓存的 JWT Token（避免每次操作都要登录） */
	savedToken: string;
	/** Token 过期时间戳（ms），过期后自动重新登录 */
	tokenExpiresAt: number;
	/**
	 * 推送模式：
	 * - "draft"    → 默认推送为草稿（推荐）
	 * - "publish"  → 直接发布
	 */
	defaultMode: "draft" | "publish";
	/**
	 * 推送时是否包含 frontmatter 在正文中
	 * true  → 保留 frontmatter 不处理
	 * false → 剥离 frontmatter，只发正文
	 */
	includeFrontmatter: boolean;
}

export const DEFAULT_SETTINGS: RinPublisherSettings = {
	blogUrl: "",
	username: "",
	password: "",
	savedToken: "",
	tokenExpiresAt: 0,
	defaultMode: "draft",
	includeFrontmatter: false,
};

// ---------------------------------------------------------------------------

export class RinSettingTab extends PluginSettingTab {
	plugin: RinPublisherPlugin;

	constructor(app: App, plugin: RinPublisherPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Rin Publisher 设置" });
		containerEl.createEl("p", {
			text: "配置你的 Rin 博客连接信息。所有密码只存储在本地 Obsidian 配置中。",
			cls: "rin-publisher-desc",
		});

		// ---- 博客连接 ----
		containerEl.createEl("h3", { text: "博客连接" });

		new Setting(containerEl)
			.setName("博客地址")
			.setDesc("你的 Rin 博客根域名，如 https://blog.example.com")
			.addText((text) =>
				text
					.setPlaceholder("https://blog.example.com")
					.setValue(this.plugin.settings.blogUrl)
					.onChange(async (val) => {
						this.plugin.settings.blogUrl = val.trim().replace(/\/+$/, "");
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("用户名")
			.setDesc("Rin 博客后台的登录用户名")
			.addText((text) =>
				text
					.setPlaceholder("admin")
					.setValue(this.plugin.settings.username)
					.onChange(async (val) => {
						this.plugin.settings.username = val;
						// 密码变了 → 清除缓存的 token
						this.plugin.settings.savedToken = "";
						this.plugin.settings.tokenExpiresAt = 0;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("密码")
			.setDesc("Rin 博客后台的登录密码（仅本地存储，不会上传）")
			.addText((text) => {
				text
					.setPlaceholder("********")
					.setValue(this.plugin.settings.password)
					.onChange(async (val) => {
						this.plugin.settings.password = val;
						this.plugin.settings.savedToken = "";
						this.plugin.settings.tokenExpiresAt = 0;
						await this.plugin.saveSettings();
					});
				// 密码框使用 type=password
				text.inputEl.type = "password";
			});

		// ---- Token 状态 ----
		const tokenDesc = this.plugin.settings.savedToken
			? `✅ Token 已缓存（${this.plugin.settings.tokenExpiresAt > Date.now() ? "有效" : "已过期，下次推送会自动重新登录"}）`
			: "❌ 未登录，首次推送时会自动登录";

		new Setting(containerEl)
			.setName("登录状态")
			.setDesc(tokenDesc)
			.addButton((btn) =>
				btn
					.setButtonText("清除 Token")
					.onClick(async () => {
						this.plugin.settings.savedToken = "";
						this.plugin.settings.tokenExpiresAt = 0;
						await this.plugin.saveSettings();
						this.display();
						new Notice("Token 已清除");
					}),
			);

		// ---- 推送设置 ----
		containerEl.createEl("h3", { text: "推送设置" });

		new Setting(containerEl)
			.setName("默认推送模式")
			.setDesc("选择默认是推送到草稿箱还是直接发布")
			.addDropdown((dd) =>
				dd
					.addOption("draft", "草稿箱（推荐）")
					.addOption("publish", "直接发布")
					.setValue(this.plugin.settings.defaultMode)
					.onChange(async (val) => {
						this.plugin.settings.defaultMode = val as "draft" | "publish";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("包含 Frontmatter")
			.setDesc("推送时是否在正文中包含 YAML frontmatter（通常建议关闭）")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeFrontmatter)
					.onChange(async (val) => {
						this.plugin.settings.includeFrontmatter = val;
						await this.plugin.saveSettings();
					}),
			);

		// ---- 操作 ----
		containerEl.createEl("h3", { text: "操作" });

		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText("测试连接")
				.setCta()
				.onClick(async () => {
					btn.setDisabled(true);
					btn.setButtonText("连接中…");

					try {
						const result = await this.plugin.testConnectionWithMessage();
						if (result.ok) {
							new Notice("✅ 连接成功！可以开始推送文章了");
						} else {
							new Notice(`❌ ${result.message}`);
						}
					} catch (e) {
						new Notice(
							`❌ 连接失败: ${e instanceof Error ? e.message : String(e)}`,
						);
					} finally {
						btn.setDisabled(false);
						btn.setButtonText("测试连接");
					}
				}),
		);
	}
}
