# Rin Publisher

Obsidian 插件 —— 将笔记一键推送到 [Rin](https://github.com/openRin/Rin) 博客的草稿箱或直接发布。

## 功能

- **推送为草稿** —— 在 Obsidian 里写好文章，一键推送到 Rin 草稿箱
- **推送并发布** —— 写完直接发布
- **同步文章** —— 按 `alias` 自动匹配，有则更新、无则新建
- **自动登录** —— 首次推送自动登录，缓存 JWT Token，过期自动重登
- **设置面板** —— 管理博客地址、用户名密码、推送模式

## 安装

### 通过 BRAT 安装（手机端推荐）

1. 安装 BRAT 插件（社区插件 → 搜索 BRAT）
2. BRAT 设置 → `Add Beta plugin` → 填入 `https://github.com/xiangshenchi/rin-obsidian-publisher`
3. 启用插件，进入设置填写博客地址、用户名、密码

### 手动安装

1. 在 [Releases](https://github.com/xiangshenchi/rin-obsidian-publisher/releases) 下载最新版
2. 解压到 `.obsidian/plugins/rin-publisher/`
3. 重启 Obsidian，在设置 → 第三方插件 中启用 `Rin Publisher`
4. 进入插件设置，填写博客地址、用户名、密码

## 使用

### 前置条件

1. 你的 Rin 博客已部署并可以访问
2. 你有博客的管理员账号密码（用于登录 `POST /api/auth/login`）
3. 插件设置中已配置 `博客地址`、`用户名`、`密码`

### 在笔记中指定元信息

在 Obsidian 笔记的 frontmatter（YAML 头部）中设置：

```yaml
---
title: 我的文章标题
alias: my-article-slug   # 可选，用于更新已有文章
summary: 文章摘要
tags: [tag1, tag2]
draft: true               # 默认由插件设置控制
---
```

### 命令

| 命令 | 快捷键（建议） | 说明 |
|------|---------------|------|
| `Rin Publisher: 推送为草稿` | `Ctrl+Shift+D` | 将当前笔记推送到草稿箱 |
| `Rin Publisher: 推送并发布` | `Ctrl+Shift+P` | 推送并直接发布 |
| `Rin Publisher: 同步文章` | `Ctrl+Shift+S` | 按 alias 匹配，有则更新无则新建 |

## 工作原理

```
Obsidian 笔记
    │  读取 frontmatter + Markdown 正文
    │
    ▼
buildFeedPayload()
    │  解析标题、标签、摘要、alias
    │
    ▼
ensureAuthenticated()
    │  POST /api/auth/login → JWT Token（自动缓存）
    │
    ▼
POST /api/feed         新建草稿/文章
    │  或
POST /api/feed/:id     更新已有文章
    │
    ▼
Rin 博客草稿箱 / 已发布
```

## API 参考

该插件使用 Rin 的以下 API：

| 端点 | 方法 | 用途 |
|------|------|------|
| `/` | GET | 健康检查 |
| `/api/auth/login` | POST | 登录获取 JWT |
| `/api/feed` | POST | 创建文章 |
| `/api/feed/:id` | POST | 更新文章 |
| `/api/feed/:alias` | GET | 按 alias 查询文章 |
| `/api/feed?type=draft` | GET | 获取草稿列表 |

## License

MIT
