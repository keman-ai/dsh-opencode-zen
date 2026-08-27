import { LlmAdapter, LlmError, attributionHeaders } from "@deepseek-ai/dsh-llm";

//#region src/catalog.ts
/** The seven free models as of 2026-08-18, largest context first. */
const FALLBACK_MODELS = [
	{
		id: "nemotron-3-ultra-free",
		name: "Nemotron 3 Ultra (free)",
		description: "1M context — the pick for reading a whole repository",
		contextWindow: 1e6,
		maxOutputTokens: 128e3
	},
	{
		id: "nemotron-3.5-lightning-free",
		name: "Nemotron 3.5 Lightning (free)",
		description: "Output cap as large as the context — suits long-form generation",
		contextWindow: 262144,
		maxOutputTokens: 262144
	},
	{
		id: "laguna-s-2.1-free",
		name: "Laguna S 2.1 (free)",
		description: "A 256K-context generalist",
		contextWindow: 256e3,
		maxOutputTokens: 32e3
	},
	{
		id: "deepseek-v4-flash-free",
		name: "DeepSeek V4 Flash (free)",
		description: "DeepSeek, same lineage as the harness; 128K output",
		contextWindow: 2e5,
		maxOutputTokens: 128e3
	},
	{
		id: "big-pickle",
		name: "Big Pickle (free)",
		description: "Zen's own anonymous evaluation model",
		contextWindow: 2e5,
		maxOutputTokens: 32e3
	},
	{
		id: "mimo-v2.5-free",
		name: "MiMo v2.5 (free)",
		description: "A lightweight 200K-context model",
		contextWindow: 2e5,
		maxOutputTokens: 32e3
	},
	{
		id: "hy3-free",
		name: "HY3 (free)",
		description: "190K context, 64K output",
		contextWindow: 19e4,
		maxOutputTokens: 64e3
	}
];
/**
* Find an entry by id in a catalog.
* @param models - The current catalog (live or snapshot).
* @param id - Model id.
* @returns The matching entry, or undefined if absent — which does not mean
*          unavailable; see the module comment.
*/
function findModel(models, id) {
	return models.find((model) => model.id === id);
}

//#endregion
//#region src/translate.ts
/**
* Convert harness history into OpenAI messages.
*
* @param messages - Conversation history; the order is what the model sees.
* @param system - System prompt; when present it becomes the first `role: "system"`.
* @returns The wire-format message array.
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
* Flatten a tool result's content blocks into one string.
*
* OpenAI's `role: "tool"` message accepts only a string. Image blocks have no place
* here, so a placeholder states that an image existed but this provider cannot accept
* it — far more diagnosable than dropping it silently.
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
* Convert tool schemas into the OpenAI `tools` array.
*
* @param tools - The harness tool schemas.
* @returns The wire-format tools array, or undefined when empty — never send an empty
*   array, as some gateways read it as "tool calls are forbidden this turn".
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
* Split a byte stream into SSE `data:` payloads.
*
* Only `data:` lines count; comments, `event:` and keep-alive blanks are skipped.
* `[DONE]` is a terminator, not a payload. A partial line is held in the buffer —
* network chunking splits a JSON line in two, and parsing per chunk is the most
* common bug in implementations like this.
*
* @param stream - The response body byte stream.
* @returns The raw payload text of each `data:` line.
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
* Consume an SSE stream into the harness block sequence.
*
* @param body - The response body.
* @returns The block sequence, always ending with a `finish`.
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
* Convert upstream usage into the harness's accounting.
*
* 🔴 The harness requires the three counts to be **disjoint**, but OpenAI-style
* `prompt_tokens` folds cache hits into itself. Without subtracting them, a cached
* conversation double-counts its input every turn.
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
/** Take the minimum of request cap, deployment cap and the model's own cap; omit the field if none exist. */
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
* Translate an HTTP failure into an error the user can act on.
*
* Exhausted free quota is this plugin's most common failure, and the gateway only says
* "Rate limit exceeded" without mentioning that a key would unblock it. We add that
* here; otherwise users just conclude the plugin is broken.
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
	if (response.status === 429) return new LlmError(`opencode-zen: free quota limited (${kind ?? "rate limit"}): ${detail}. ${hadKey ? "Retry later, or check this account's free quota at https://opencode.ai/zen" : "This plugin is calling Zen anonymously; the shared free quota is rate-limited by source. Get a key at https://opencode.ai/zen and set OPENCODE_API_KEY for a private quota"}`, "RATE_LIMIT");
	if (response.status === 401 || response.status === 403) return new LlmError(hadKey ? `opencode-zen: API key rejected (HTTP ${response.status}): ${detail}` : `opencode-zen: this request needs a credential (HTTP ${response.status}): ${detail}. Get a key at https://opencode.ai/zen and set OPENCODE_API_KEY`, hadKey ? "INVALID_CREDENTIAL" : "MISSING_CREDENTIAL");
	return new LlmError(`opencode-zen: provider returned HTTP ${response.status}: ${detail}`, "PROVIDER_ERROR");
}

//#endregion
//#region src/discovery.ts
/**
* Catalog service: one per plugin instance.
*
* Fetch failures **never throw** — a missing catalog should cost the picker a few entries, not stop a conversation whose model is already chosen.
*/
var Catalog = class {
	#cache;
	/** In-flight fetch, for deduplication: opening the settings page asks several times at once. */
	#inflight;
	#lastFailureAt = 0;
	#options;
	#now;
	/**
	* @param options - Upstream URLs and cache parameters.
	* @param now - Current-time source; injectable for tests.
	*/
	constructor(options, now = Date.now) {
		this.#options = options;
		this.#now = now;
	}
	/**
	* The catalog as currently known, **without any network request**.
	*
	* For the request path: the model cap affects only the `max_tokens` field, and waiting
	* on a catalog fetch for it would add a network round trip to every turn. A cold cache
	* uses the snapshot.
	* @returns The cached catalog, or the bundled snapshot.
	*/
	peek() {
		return this.#cache?.models ?? FALLBACK_MODELS;
	}
	/**
	* Get the free-model catalog.
	* @param signal - The caller's abort signal.
	* @returns The catalog and its source. Never throws.
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
/** The ids Zen currently offers; undefined when unavailable — meaning "unconfirmed", not "empty". */
function liveIds(list) {
	const ids = list?.data?.map((entry) => entry.id).filter((id) => typeof id === "string" && id.length > 0);
	return ids === void 0 || ids.length === 0 ? void 0 : new Set(ids);
}
/**
* Select the free models from models.dev's opencode section.
*
* The test is `cost.input === 0 && cost.output === 0`, not the id's `-free` suffix —
* the suffix is a naming habit (`big-pickle` has none); price is the fact.
*
* @param dev - The models.dev response.
* @param available - Ids Zen currently offers; undefined means that source failed, so no filtering.
* @returns The catalog, largest context first.
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
/** Plugin name (the `name` of the loader entry). */
const name = "opencode-zen";
/** Wait for the LLM service; without it this plugin is pointless. */
const inject = ["llm"];
/** The provider route this plugin owns. */
const PROVIDER = "opencode-zen";
/** Zen's endpoint root — also what models.dev lists for the `opencode` provider. */
const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
/** Source of the free/paid verdict: Zen's own `/models` omits pricing. */
const DEFAULT_CATALOG_URL = "https://models.dev/api.json";
/** Same credential variable opencode uses, so one key serves both. */
const DEFAULT_API_KEY_ENV = "OPENCODE_API_KEY";
/** Catalog TTL. The list changes on a weekly scale; an hour is fresh enough and gentle upstream. */
const DEFAULT_CATALOG_TTL_MS = 3600 * 1e3;
/** Catalog request timeout. The catalog is an enhancement — fall back to the snapshot fast rather than stall the settings page. */
const DEFAULT_CATALOG_TIMEOUT_MS = 8e3;
/** Context window assumed when the catalog has no entry for a model. */
const DEFAULT_CONTEXT_WINDOW = 128e3;
/** Validate and complete the config. Out-of-range values fail here, not mid-request. */
function resolveConfig(config) {
	const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW;
	if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) throw new Error("opencode-zen: defaultContextWindow must be a positive integer");
	if (config.maxTokens !== void 0 && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) throw new Error("opencode-zen: maxTokens must be a positive integer");
	const catalogTtlMs = config.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS;
	if (!Number.isFinite(catalogTtlMs) || catalogTtlMs < 0) throw new Error("opencode-zen: catalogTtlMs must be a non-negative number");
	const catalogTimeoutMs = config.catalogTimeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS;
	if (!Number.isFinite(catalogTimeoutMs) || catalogTimeoutMs <= 0) throw new Error("opencode-zen: catalogTimeoutMs must be a positive number");
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
	* Prefer the credentials service (where the web Models page stores the key);
	* without it, the env var is the whole credential surface. Neither present
	* returns undefined — an anonymous call.
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
	ctx.logger.info("[opencode-zen] registered provider %s (endpoint %s, credential env %s)", PROVIDER, resolved.connection.baseURL, resolved.apiKeyEnv);
}

//#endregion
export { Catalog, DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, DEFAULT_CATALOG_URL, FALLBACK_MODELS, PROVIDER, ZenAdapter, apply, findModel, freeModels, inject, name, resolveConfig };