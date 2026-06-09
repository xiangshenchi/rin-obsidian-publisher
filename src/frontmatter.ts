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
		// 没有 frontmatter
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
		// 没有 closing ---，当作没有 frontmatter
		result.body = content;
		return result;
	}

	// 提取 frontmatter 行
	const fmLines = lines.slice(1, endIndex);
	result.hasFrontmatter = true;
	result.rawFrontmatter = lines.slice(0, endIndex + 1).join("\n");

	// 粗略解析 key: value 对（支持多行值用缩进，但不支持完整的 YAML）
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
 * 支持: string, number, boolean, string[], number[], 嵌套数组
 * 不支持: 完整的 YAML 规范（对象嵌套、引用等）
 */
function parseSimpleYaml(lines: string[]): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const stack: Array<{
		key: string;
		obj: Record<string, unknown>;
		indent: number;
	}> = [];
	let currentArray: string[] | null = null;
	let arrayKey: string | null = null;

	for (const rawLine of lines) {
		const line = rawLine;
		const indent = line.search(/\S/);
		const trimmed = line.trim();

		// 空行或注释
		if (!trimmed || trimmed.startsWith("#")) continue;

		// 数组项: - value
		const arrayItemMatch = trimmed.match(/^-\s+(.*)/);
		if (arrayItemMatch) {
			if (currentArray && arrayKey) {
				currentArray.push(arrayItemMatch[1].trim());
			}
			continue;
		}

		// 如果之前在处理数组，flush
		if (currentArray !== null && arrayKey) {
			// 已经 flush 过了在下面
		}

		// key: value
		const kvMatch = trimmed.match(/^([\w-]+)\s*:\s*(.*)/);
		if (!kvMatch) continue;

		const key = kvMatch[1];
		const valuePart = kvMatch[2].trim();

		// 如果是列表的开始（下一行是 - item），暂存
		// 简单值
		if (valuePart === "" || valuePart === "|" || valuePart === ">") {
			// 可能是多行值或空值，存空字符串
			result[key] = "";
			currentArray = null;
			arrayKey = null;
			continue;
		}

		// 尝试解析值
		const parsed = parseYamlValue(valuePart);

		if (Array.isArray(parsed)) {
			// inline array: [a, b, c]
			result[key] = parsed;
		} else if (parsed === "___ARRAY_START___") {
			// 后面跟 - item 列表
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

function parseYamlValue(value: string): unknown {
	const trimmed = value.trim();

	// 空
	if (!trimmed) return "";

	// 引号字符串
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}

	// Boolean
	if (trimmed === "true" || trimmed === "yes" || trimmed === "on") return true;
	if (trimmed === "false" || trimmed === "no" || trimmed === "off") return false;

	// null
	if (trimmed === "null" || trimmed === "~" || trimmed === "") return null;

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
				// 去掉可能的引号
				if (
					(item.startsWith('"') && item.endsWith('"')) ||
					(item.startsWith("'") && item.endsWith("'"))
				) {
					return item.slice(1, -1);
				}
				return item;
			})
			.filter((s) => s !== "");
	}

	// 列表标记（下一行是 - items）
	if (trimmed === "") return "___ARRAY_START___";

	return trimmed;
}
