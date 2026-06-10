/**
 * 简易 Obsidian Frontmatter 解析器
 *
 * 解析 YAML frontmatter（--- 包围的区域）为键值对
 * 剥离 frontmatter 后返回纯正文
 */

interface ParseResult {
	/** 解析后的 frontmatter 字段 */
	frontmatter: Record<string, unknown>;
	/** 剥离 frontmatter 后的正文（或原始内容） */
	body: string;
	/** 是否有 frontmatter */
	hasFrontmatter: boolean;
	/** 原始 frontmatter 文本（含 ---） */
	rawFrontmatter: string;
}

/**
 * 解析笔记内容中的 YAML frontmatter
 *
 * @param content - 完整的文件内容
 * @param includeFrontmatter - 是否在正文中包含 frontmatter
 */
export function parseFrontmatter(
	content: string,
	includeFrontmatter: boolean = false,
): ParseResult {
	const result: ParseResult = {
		frontmatter: {},
		body: content,
		hasFrontmatter: false,
		rawFrontmatter: "",
	};

	// 检查是否以 --- 开头
	const lines = content.split("\n");
	if (lines.length < 2 || lines[0].trim() !== "---") {
		result.body = content;
		return result;
	}

	// 找到 closing ---
	let endIndex = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			endIndex = i;
			break;
		}
	}

	if (endIndex === -1) {
		result.body = content;
		return result;
	}

	// 提取 frontmatter 行
	const fmLines = lines.slice(1, endIndex);
	result.hasFrontmatter = true;
	result.rawFrontmatter = lines.slice(0, endIndex + 1).join("\n");

	// 粗略解析 key: value 对
	result.frontmatter = parseSimpleYaml(fmLines);

	// 提取正文
	const bodyLines = lines.slice(endIndex + 1);
	// 去掉开头的空行
	while (bodyLines.length > 0 && bodyLines[0].trim() === "") {
		bodyLines.shift();
	}

	if (includeFrontmatter) {
		result.body = content;
	} else {
		result.body = bodyLines.join("\n");
	}

	return result;
}

/**
 * 简易 YAML 键值对解析
 * 支持: string, number, boolean, string[], number[]
 * 不支持: 对象嵌套、完整 YAML 规范
 */
function parseSimpleYaml(lines: string[]): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	let currentArray: string[] | null = null;
	let arrayKey: string | null = null;

	for (const rawLine of lines) {
		const trimmed = rawLine.trim();

		// 空行或注释行（以 # 开头）
		if (!trimmed || trimmed.startsWith("#")) continue;

		// 数组项: - value
		const arrayItemMatch = trimmed.match(/^-\s+(.*)/);
		if (arrayItemMatch) {
			if (currentArray && arrayKey) {
				currentArray.push(parseSimpleValue(stripYamlComment(arrayItemMatch[1].trim())));
			}
			continue;
		}

		// flush 上一个数组
		if (currentArray !== null && arrayKey) {
			result[arrayKey] = currentArray;
			currentArray = null;
			arrayKey = null;
		}

		// key: value
		const kvMatch = trimmed.match(/^([\w-]+)\s*:\s*(.*)/);
		if (!kvMatch) continue;

		const key = kvMatch[1];
		let valuePart = kvMatch[2].trim();

		// 如果值是空 → 准备收集列表项（YAML 列表格式）
		if (!valuePart) {
			currentArray = [];
			arrayKey = key;
			continue;
		}

		// 多行标记（| >）→ 暂不支持，跳过
		if (valuePart === "|" || valuePart === ">") {
			result[key] = "";
			continue;
		}

		// 尝试解析值
		const parsed = parseYamlValue(valuePart);

		if (Array.isArray(parsed)) {
			result[key] = parsed;
		} else if (parsed === "___ARRAY_START___") {
			currentArray = [];
			arrayKey = key;
		} else {
			result[key] = parsed;
			currentArray = null;
			arrayKey = null;
		}
	}

	// Flush 最后一个数组
	if (currentArray !== null && arrayKey) {
		result[arrayKey] = currentArray;
	}

	return result;
}

function parseSimpleValue(val: string): string {
	// 去掉可能的引号
	if (
		(val.startsWith('"') && val.endsWith('"')) ||
		(val.startsWith("'") && val.endsWith("'"))
	) {
		return val.slice(1, -1);
	}
	return val;
}

function parseYamlValue(value: string): unknown {
	let trimmed = value.trim();

	// 空
	if (!trimmed) return "";

	// 引号字符串 — 先检查，引号内的 # 是内容不是注释
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}

	// 剥离 YAML 行内注释（非引号内的 # → 注释）
	trimmed = stripYamlComment(trimmed);
	if (!trimmed) return "";

	// Boolean
	if (trimmed === "true" || trimmed === "yes" || trimmed === "on") return true;
	if (trimmed === "false" || trimmed === "no" || trimmed === "off") return false;

	// null
	if (trimmed === "null" || trimmed === "~") return null;

	// Number
	const num = Number(trimmed);
	if (!isNaN(num) && trimmed !== "") return num;

	// Inline array: [a, b, c]
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		const inner = trimmed.slice(1, -1);
		return inner
			.split(",")
			.map((s) => {
				const item = s.trim();
				const itemNum = Number(item);
				if (!isNaN(itemNum) && item !== "") return itemNum;
				return parseSimpleValue(item);
			})
			.filter((s) => s !== "");
	}

	// 下一行是 - items 的标记（空值在 YAML 中可能表示列表开始）
	if (trimmed === "") return "___ARRAY_START___";

	return trimmed;
}

/** 剥离 YAML 行内注释（从第一个非引号内的 # 到行尾） */
function stripYamlComment(val: string): string {
	let inSQ = false;
	let inDQ = false;
	for (let i = 0; i < val.length; i++) {
		const ch = val[i];
		if (ch === '"' && !inSQ) inDQ = !inDQ;
		else if (ch === "'" && !inDQ) inSQ = !inSQ;
		else if (ch === "#" && !inSQ && !inDQ) {
			return val.substring(0, i).trimEnd();
		}
	}
	return val.trimEnd();
}
