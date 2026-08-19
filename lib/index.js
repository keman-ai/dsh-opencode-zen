import { LlmAdapter, LlmError, attributionHeaders } from "@deepseek-ai/dsh-llm";

//#region src/catalog.ts
/** 2026-08-18 那天的七个免费模型，按上下文容量从大到小排。 */
const FALLBACK_MODELS = [
	{
		id: "nemotron-3-ultra-free",
		name: "Nemotron 3 Ultra (free)",
		description: "百万上下文，长仓库通读的首选",
		contextWindow: 1e6,
		maxOutputTokens: 128e3
	},
	{
		id: "nemotron-3.5-lightning-free",
		name: "Nemotron 3.5 Lightning (free)",
		description: "输出上限与上下文一样大，适合长篇生成",
		contextWindow: 262144,
		maxOutputTokens: 262144
	},
	{
		id: "laguna-s-2.1-free",
		name: "Laguna S 2.1 (free)",
		description: "25.6 万上下文的通用款",
		contextWindow: 256e3,
		maxOutputTokens: 32e3
	},
	{
		id: "deepseek-v4-flash-free",
		name: "DeepSeek V4 Flash (free)",
		description: "与 harness 同源的 DeepSeek，12.8 万输出",
		contextWindow: 2e5,
		maxOutputTokens: 128e3
	},
	{
		id: "big-pickle",
		name: "Big Pickle (free)",
		description: "Zen 自家的匿名评测模型",
		contextWindow: 2e5,
		maxOutputTokens: 32e3
	},
	{
		id: "mimo-v2.5-free",
		name: "MiMo v2.5 (free)",
		description: "20 万上下文的轻量款",
		contextWindow: 2e5,
		maxOutputTokens: 32e3
	},
	{
		id: "hy3-free",
		name: "HY3 (free)",
		description: "19 万上下文，6.4 万输出",
		contextWindow: 19e4,
		maxOutputTokens: 64e3
	}
];
/**
* 在一份目录里按 id 找条目。
* @param models - 当前目录（实时或快照）。
* @param id - 模型 id。
* @returns 命中的条目；未收录时 undefined —— 不代表不可用，见模块注释。
*/
function findModel(models, id) {
	return models.find((model) => model.id === id);
}

//#endregion
//#region src/translate.ts
/**
* 把 harness 历史转成 OpenAI messages。
*
* @param messages - 会话历史，顺序即模型看到的顺序。
* @param system - 系统提示；有值时作为第一条 `role: "system"`。
* @returns 线格式消息数组。
*/
function toWireMessages(messages, system) {
	const out = [];
	if (system !== void 0 && system.length > 0) out.push({
		role: "system",
		content: system
	});
	for (const message of messages) pushMessage(out, message);
	return out;
}
function pushMessage(out, message) {
	const text = [];
	const toolCalls = [];
	for (const block of message.content) switch (block.type) {
		case "text":
			text.push(block.text);
			break;
		case "reasoning": break;
		case "image": break;
		case "tool-call":
			toolCalls.push({
				id: block.id,
				type: "function",
				function: {
					name: block.name,
					arguments: block.arguments
				}
			});
			break;
		case "tool-result":
			flush(out, message.role, text, toolCalls);
			out.push({
				role: "tool",
				tool_call_id: block.toolCallId,
				content: flattenResult(block.content)
			});
			break;
		default: break;
	}
	flush(out, message.role, text, toolCalls);
}
function flush(out, role, text, toolCalls) {
	if (text.length === 0 && toolCalls.length === 0) return;
	const content = text.join("");
	const wire = { role: role === "system" ? "system" : role };
	if (content.length > 0) wire.content = content;
	if (toolCalls.length > 0) wire.tool_calls = [...toolCalls];
	out.push(wire);
	text.length = 0;
	toolCalls.length = 0;
}
/**
* 工具结果的内容块压成一段文本。
*
* OpenAI 的 `role: "tool"` 消息只收字符串。结果里的图片块在这里没有位置，
* 用占位符点明「有一张图但这个 provider 收不了」，比静默丢弃可诊断。
*/
function flattenResult(blocks) {
	const parts = [];
	for (const block of blocks) switch (block.type) {
		case "text":
			parts.push(block.text);
			break;
		case "image":
			parts.push("[image omitted: this provider accepts text only]");
			break;
		case "reasoning":
			parts.push(block.text);
			break;
		default: break;
	}
	return parts.join("\n");
}
/**
* 工具 schema 转成 OpenAI `tools` 数组。
*
* @param tools - harness 的工具 schema。
* @returns 线格式工具数组；入参为空时 undefined（不要发空数组，部分网关会因此
*   认为「本轮禁止调用工具」）。
*/
function toWireTools(tools) {
	if (tools === void 0 || tools.length === 0) return;
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			...tool.description === void 0 ? {} : { description: tool.description },
			...tool.inputSchema === void 0 ? {} : { parameters: tool.inputSchema }
		}
	}));
}

//#endregion
//#region src/wire.ts
/**
* 把字节流切成 SSE `data:` 负载。
*
* 只认 `data:` 行，其余（注释、`event:`、心跳空行）跳过；`[DONE]` 是终止哨兵，
* 不作为负载吐出。跨 chunk 的半行留在缓冲里 —— 网络分片会把一行 JSON 劈成两半，
* 逐 chunk 解析是这类实现最常见的错。
*
* @param stream - 响应体的字节流。
* @returns 每个 `data:` 行的原始负载文本。
*/
async function* sseLines(stream) {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line.startsWith("data:")) continue;
				const payload = line.slice(5).trim();
				if (payload === "[DONE]") return;
				if (payload.length > 0) yield payload;
			}
		}
		const tail = buffer.trim();
		if (tail.startsWith("data:")) {
			const payload = tail.slice(5).trim();
			if (payload.length > 0 && payload !== "[DONE]") yield payload;
		}
	} finally {
		reader.releaseLock();
	}
}

//#endregion
//#region src/stream.ts
/**
* 把一条 SSE 流消费成 harness 的块序列。
*
* @param body - 响应体。
* @returns 块序列，末尾必有一个 `finish`。
*/
async function* consume(body) {
	const state = {
		nextIndex: 0,
		text: void 0,
		reasoning: void 0,
		tools: /* @__PURE__ */ new Map(),
		finish: void 0,
		usage: void 0,
		sawToolCall: false
	};
	for await (const payload of sseLines(body)) {
		let event;
		try {
			event = JSON.parse(payload);
		} catch {
			continue;
		}
		if (event.usage != null) state.usage = event.usage;
		const choice = event.choices?.[0];
		if (choice === void 0) continue;
		if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) state.finish = choice.finish_reason;
		const delta = choice.delta;
		if (delta === void 0) continue;
		const reasoning = delta.reasoning_content ?? delta.reasoning;
		if (typeof reasoning === "string" && reasoning.length > 0) {
			yield* openReasoning(state);
			state.reasoning?.parts.push(reasoning);
			yield {
				type: "reasoning-delta",
				index: state.reasoning.index,
				text: reasoning
			};
		}
		if (typeof delta.content === "string" && delta.content.length > 0) {
			yield* closeReasoning(state);
			yield* openText(state);
			state.text?.parts.push(delta.content);
			yield {
				type: "text-delta",
				index: state.text.index,
				text: delta.content
			};
		}
		for (const call of delta.tool_calls ?? []) {
			state.sawToolCall = true;
			let entry = state.tools.get(call.index);
			if (entry === void 0) {
				yield* closeReasoning(state);
				yield* closeText(state);
				entry = {
					index: state.nextIndex++,
					id: call.id ?? "",
					name: "",
					args: []
				};
				state.tools.set(call.index, entry);
				yield {
					type: "block-start",
					index: entry.index,
					blockType: "tool-call"
				};
			}
			if (call.id !== void 0 && call.id.length > 0) entry.id = call.id;
			const name$1 = call.function?.name;
			if (name$1 !== void 0 && name$1.length > 0) entry.name = name$1;
			const args = call.function?.arguments ?? "";
			if (args.length > 0) entry.args.push(args);
			if (args.length > 0 || name$1 !== void 0) yield {
				type: "tool-call-delta",
				index: entry.index,
				id: entry.id,
				...entry.name.length > 0 ? { name: entry.name } : {},
				argumentsDelta: args
			};
		}
	}
	yield* closeReasoning(state);
	yield* closeText(state);
	for (const entry of state.tools.values()) {
		const block = {
			type: "tool-call",
			id: entry.id,
			name: entry.name,
			arguments: entry.args.join("")
		};
		yield {
			type: "block-end",
			index: entry.index,
			block
		};
	}
	if (state.usage !== void 0) yield {
		type: "usage",
		usage: toTokenUsage(state.usage)
	};
	yield {
		type: "finish",
		reason: toFinishReason(state)
	};
}
function* openText(state) {
	if (state.text !== void 0) return;
	state.text = {
		index: state.nextIndex++,
		parts: []
	};
	yield {
		type: "block-start",
		index: state.text.index,
		blockType: "text"
	};
}
function* closeText(state) {
	const open = state.text;
	if (open === void 0) return;
	state.text = void 0;
	yield {
		type: "block-end",
		index: open.index,
		block: {
			type: "text",
			text: open.parts.join("")
		}
	};
}
function* openReasoning(state) {
	if (state.reasoning !== void 0) return;
	state.reasoning = {
		index: state.nextIndex++,
		parts: []
	};
	yield {
		type: "block-start",
		index: state.reasoning.index,
		blockType: "reasoning"
	};
}
function* closeReasoning(state) {
	const open = state.reasoning;
	if (open === void 0) return;
	state.reasoning = void 0;
	yield {
		type: "block-end",
		index: open.index,
		block: {
			type: "reasoning",
			text: open.parts.join("")
		}
	};
}
/**
* 上游用量换算成 harness 的口径。
*
* 🔴 harness 要求三个计数**不相交**，而 OpenAI 风格的 `prompt_tokens` 把缓存命中
* 折在里面。不减这一刀，带缓存的会话每轮都会把输入重复计一遍。
*/
function toTokenUsage(usage) {
	const prompt = usage.prompt_tokens ?? 0;
	const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
	const reasoning = usage.completion_tokens_details?.reasoning_tokens;
	return {
		inputTokens: Math.max(prompt - cached, 0),
		outputTokens: usage.completion_tokens ?? 0,
		...cached > 0 ? { cacheReadTokens: cached } : {},
		...reasoning === void 0 ? {} : { reasoningTokens: reasoning }
	};
}
function toFinishReason(state) {
	switch (state.finish) {
		case "tool_calls": return { kind: "tool-calls" };
		case "length": return { kind: "max-tokens" };
		case "stop": return { kind: "stop" };
		default: return state.sawToolCall ? { kind: "tool-calls" } : { kind: "stop" };
	}
}

//#endregion
//#region src/adapter.ts
var ZenAdapter = class extends LlmAdapter {
	#options;
	#resolveApiKey;
	#catalog;
	constructor(options) {
		super();
		this.#options = options.options;
		this.#resolveApiKey = options.resolveApiKey;
		this.#catalog = options.catalog;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "OpenCode Zen"
		};
	}
	async listModels(provider) {
		const { models } = await this.#catalog.list();
		return models.map((model) => ({
			provider,
			id: model.id,
			name: model.name,
			description: model.description
		}));
	}
	async resolveModel(provider, model, signal) {
		const { models } = await this.#catalog.list(signal);
		const known = findModel(models, model);
		const connection = this.#options();
		if (known === void 0) return {
			provider,
			id: model,
			name: model,
			context: { contextWindow: connection.defaultContextWindow }
		};
		return {
			provider,
			id: known.id,
			name: known.name,
			description: known.description,
			context: {
				contextWindow: known.contextWindow,
				maxOutputTokens: known.maxOutputTokens
			}
		};
	}
	async *stream(options) {
		const connection = this.#options();
		const apiKey = await this.#resolveApiKey();
		const model = findModel(this.#catalog.peek(), options.model);
		const body = {
			model: options.model,
			messages: toWireMessages(options.messages, options.system),
			stream: true,
			stream_options: { include_usage: true }
		};
		const tools = toWireTools(options.tools);
		if (tools !== void 0) body.tools = tools;
		if (options.temperature !== void 0) body.temperature = options.temperature;
		const maxTokens = resolveMaxTokens(options.maxTokens, connection.maxTokens, model?.maxOutputTokens);
		if (maxTokens !== void 0) body.max_tokens = maxTokens;
		if (options.stop !== void 0 && options.stop.length > 0) body.stop = [...options.stop];
		const response = await fetch(`${trimSlash(connection.baseURL)}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "text/event-stream",
				...attributionHeaders(),
				...apiKey === void 0 ? {} : { authorization: `Bearer ${apiKey}` }
			},
			body: JSON.stringify(body),
			...options.signal === void 0 ? {} : { signal: options.signal }
		});
		if (!response.ok) throw await describeFailure(response, apiKey !== void 0);
		if (response.body === null) throw new LlmError("opencode-zen: provider returned no response body", "PROVIDER_ERROR");
		yield* consume(response.body);
	}
};
/** 请求上限、部署上限、模型自身上限取最小；都没有就不发这个字段。 */
function resolveMaxTokens(requested, configured, modelCap) {
	const candidates = [
		requested,
		configured,
		modelCap
	].filter((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
	return candidates.length === 0 ? void 0 : Math.min(...candidates);
}
function trimSlash(url) {
	return url.replace(/\/+$/, "");
}
/**
* 把 HTTP 失败翻译成能照着做事的错误。
*
* 免费额度耗尽是本插件最常见的失败，而网关只回一句「Rate limit exceeded」，
* 不说清「配个 key 就能继续」——这里补上，否则用户只会以为插件坏了。
*/
async function describeFailure(response, hadKey) {
	const raw = await response.text().catch(() => "");
	let detail = raw.slice(0, 500);
	let kind;
	try {
		const parsed = JSON.parse(raw);
		kind = parsed.error?.type;
		detail = parsed.error?.message ?? parsed.message ?? detail;
	} catch {}
	if (response.status === 429) return new LlmError(`opencode-zen: 免费额度受限（${kind ?? "rate limit"}）：${detail}。${hadKey ? "稍后重试，或在 https://opencode.ai/zen 查看该账号的免费额度" : "本插件当前在匿名调用 Zen，公共免费额度按来源限流；到 https://opencode.ai/zen 取一个 key 并设进 OPENCODE_API_KEY 可获得独立额度"}`, "RATE_LIMIT");
	if (response.status === 401 || response.status === 403) return new LlmError(hadKey ? `opencode-zen: API key 被拒（HTTP ${response.status}）：${detail}` : `opencode-zen: 该请求需要凭证（HTTP ${response.status}）：${detail}。到 https://opencode.ai/zen 取 key 并设进 OPENCODE_API_KEY`, hadKey ? "INVALID_CREDENTIAL" : "MISSING_CREDENTIAL");
	return new LlmError(`opencode-zen: provider 返回 HTTP ${response.status}：${detail}`, "PROVIDER_ERROR");
}

//#endregion
//#region src/discovery.ts
/**
* 目录服务：一个插件实例一个。
*
* 拉取失败**不抛**——目录拉不到只该让选择器少几项，不该让已经选好模型的对话发不出去。
*/
var Catalog = class {
	#cache;
	/** 进行中的拉取，用于并发去重：设置页一打开会同时问好几次。 */
	#inflight;
	#lastFailureAt = 0;
	#options;
	#now;
	/**
	* @param options - 上游地址与缓存参数。
	* @param now - 取当前时间，测试可注入。
	*/
	constructor(options, now = Date.now) {
		this.#options = options;
		this.#now = now;
	}
	/**
	* 当前已知的目录，**不发网络请求**。
	*
	* 给发请求那条路径用：模型上限只影响 `max_tokens` 这一个字段，为它去等一次
	* 目录拉取，等于给每轮对话平白加一个网络往返。缓存没热就用快照。
	* @returns 缓存目录，或随包快照。
	*/
	peek() {
		return this.#cache?.models ?? FALLBACK_MODELS;
	}
	/**
	* 取免费模型目录。
	* @param signal - 调用方的取消信号。
	* @returns 目录与它的来源；永不抛。
	*/
	async list(signal) {
		const cached = this.#cache;
		if (cached !== void 0 && this.#now() - cached.at < this.#options.ttlMs) return {
			models: cached.models,
			source: "cache"
		};
		if (this.#now() - this.#lastFailureAt < this.#options.timeoutMs) return {
			models: cached?.models ?? FALLBACK_MODELS,
			source: cached === void 0 ? "fallback" : "cache"
		};
		this.#inflight ??= this.#fetchAll(signal).finally(() => {
			this.#inflight = void 0;
		});
		const models = await this.#inflight;
		if (models.length === 0) {
			this.#lastFailureAt = this.#now();
			return {
				models: cached?.models ?? FALLBACK_MODELS,
				source: cached === void 0 ? "fallback" : "cache"
			};
		}
		this.#cache = {
			at: this.#now(),
			models
		};
		return {
			models,
			source: "live"
		};
	}
	async #fetchAll(signal) {
		const [dev, live] = await Promise.all([this.#json(this.#options.catalogUrl, signal), this.#json(this.#options.modelsUrl, signal)]);
		if (dev === void 0) return [];
		return freeModels(dev, liveIds(live));
	}
	async #json(url, signal) {
		try {
			const response = await fetch(url, {
				headers: { accept: "application/json" },
				signal: signal ?? AbortSignal.timeout(this.#options.timeoutMs)
			});
			if (!response.ok) return;
			return await response.json();
		} catch {
			return;
		}
	}
};
/** zen 当前在售的 id 集合；拿不到时 undefined（表示「无法确认」，不是「空」）。 */
function liveIds(list) {
	const ids = list?.data?.map((entry) => entry.id).filter((id) => typeof id === "string" && id.length > 0);
	return ids === void 0 || ids.length === 0 ? void 0 : new Set(ids);
}
/**
* 从 models.dev 的 opencode 段筛出免费模型。
*
* 判据是 `cost.input === 0 && cost.output === 0`，不是 id 的 `-free` 后缀 ——
* 后缀是命名习惯（`big-pickle` 就没有），价格才是事实。
*
* @param dev - models.dev 响应。
* @param available - zen 当前在售的 id；undefined 表示这一路没拿到，不做过滤。
* @returns 按上下文容量降序的目录。
*/
function freeModels(dev, available) {
	const models = dev.opencode?.models;
	if (models === void 0) return [];
	const out = [];
	for (const [key, model] of Object.entries(models)) {
		const id = model.id ?? key;
		if (model.cost?.input !== 0 || model.cost?.output !== 0) continue;
		if (available !== void 0 && !available.has(id)) continue;
		const context = model.limit?.context;
		const output = model.limit?.output;
		if (typeof context !== "number" || context <= 0) continue;
		out.push({
			id,
			name: model.name ?? id,
			description: model.description ?? "",
			contextWindow: context,
			maxOutputTokens: typeof output === "number" && output > 0 ? output : context
		});
	}
	return out.sort((a, b) => b.contextWindow - a.contextWindow);
}

//#endregion
//#region src/index.ts
/** 插件名（loader 行的 name）。 */
const name = "opencode-zen";
/** 等 LLM 服务就绪；没有它这个插件没有意义。 */
const inject = ["llm"];
/** 本插件拥有的那一条 provider 路由。 */
const PROVIDER = "opencode-zen";
/** Zen 的端点根。models.dev 上 `opencode` provider 登记的也是它。 */
const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
/** 免费判定的数据源：Zen 自己的 `/models` 不返回价格，只能从这里看。 */
const DEFAULT_CATALOG_URL = "https://models.dev/api.json";
/** 与 opencode 官方一致的凭证变量名，两边可共用一个 key。 */
const DEFAULT_API_KEY_ENV = "OPENCODE_API_KEY";
/** 目录缓存时长：模型清单变化以周计，一小时足够新，也不会把上游打疼。 */
const DEFAULT_CATALOG_TTL_MS = 3600 * 1e3;
/** 目录请求超时。目录是可有可无的增强，宁可快速回落到快照也不要卡住设置页。 */
const DEFAULT_CATALOG_TIMEOUT_MS = 8e3;
/** 目录里查不到该模型时假定的上下文容量。 */
const DEFAULT_CONTEXT_WINDOW = 128e3;
/** 校验并补全配置。越界一律在这里失败，而不是等到发请求时才炸。 */
function resolveConfig(config) {
	const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW;
	if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) throw new Error("opencode-zen: defaultContextWindow 必须是正整数");
	if (config.maxTokens !== void 0 && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) throw new Error("opencode-zen: maxTokens 必须是正整数");
	const catalogTtlMs = config.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS;
	if (!Number.isFinite(catalogTtlMs) || catalogTtlMs < 0) throw new Error("opencode-zen: catalogTtlMs 必须是非负数");
	const catalogTimeoutMs = config.catalogTimeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS;
	if (!Number.isFinite(catalogTimeoutMs) || catalogTimeoutMs <= 0) throw new Error("opencode-zen: catalogTimeoutMs 必须是正数");
	return {
		connection: {
			baseURL: config.baseURL ?? DEFAULT_BASE_URL,
			...config.maxTokens === void 0 ? {} : { maxTokens: config.maxTokens },
			defaultContextWindow
		},
		apiKeyEnv: config.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
		catalogUrl: config.catalogUrl ?? DEFAULT_CATALOG_URL,
		catalogTtlMs,
		catalogTimeoutMs
	};
}
function apply(ctx, config = {}) {
	const resolved = resolveConfig(config);
	const catalog = new Catalog({
		catalogUrl: resolved.catalogUrl,
		modelsUrl: `${resolved.connection.baseURL.replace(/\/+$/, "")}/models`,
		ttlMs: resolved.catalogTtlMs,
		timeoutMs: resolved.catalogTimeoutMs
	});
	/**
	* 凭证优先走 credentials 服务（网页「模型」页写进去的 key 在那儿），
	* 没有这个服务时环境变量就是全部的凭证面。两处都没有就返回 undefined —— 匿名调用。
	*/
	const resolveApiKey = async () => {
		const credentials = ctx.get("credentials");
		if (credentials !== void 0) {
			const hit = await credentials.resolve(resolved.apiKeyEnv);
			if (hit !== void 0 && hit.value.length > 0) return hit.value;
		}
		const ambient = process.env[resolved.apiKeyEnv];
		return ambient !== void 0 && ambient.length > 0 ? ambient : void 0;
	};
	const adapter = new ZenAdapter({
		options: () => resolved.connection,
		resolveApiKey,
		catalog
	});
	ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter), `opencode-zen: ${PROVIDER}`);
	ctx.logger.info("[opencode-zen] 已注册 provider %s（端点 %s，凭证变量 %s）", PROVIDER, resolved.connection.baseURL, resolved.apiKeyEnv);
}

//#endregion
export { Catalog, DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, DEFAULT_CATALOG_URL, FALLBACK_MODELS, PROVIDER, ZenAdapter, apply, findModel, freeModels, inject, name, resolveConfig };