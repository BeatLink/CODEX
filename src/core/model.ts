// Load the local model and make one call to it.
import type {
    ChatHistoryItem,
    ChatModelFunctionCall,
    ChatModelFunctions,
    GbnfJsonSchema,
    Llama,
    LlamaContext,
    LlamaContextSequence,
    LlamaModel,
} from 'node-llama-cpp';
import { deflateRawSync } from 'node:zlib';

import { GPU_LOCK } from './gpuLock.js';
import { MAX_TOKENS, TEMPERATURE } from './settings.js';

// ============================================================================
// Request and reply shapes
// ============================================================================

export type ToolCall = {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
};

export type ChatMessage = {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
};

export type ToolDefinition = {
    type: 'function';
    function: { name: string; description?: string; parameters?: Record<string, unknown> };
};

export type ChatCompletionRequest = {
    messages: ChatMessage[];
    temperature?: number;
    max_tokens?: number;
    response_format?: { type: 'json_object'; schema?: Record<string, unknown> };
    tools?: ToolDefinition[];
    tool_choice?: 'auto' | 'none';
    on_token?: (token: string) => void;
    signal?: AbortSignal;
};

type GeneratedResponse = {
    response: string;
    functionCalls?: Array<{ functionName: string; params: unknown }>;
    metadata: { stopReason: string };
};

// 'repetition' means the reply started going round in circles and was stopped early.
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'repetition';

export const TOKEN_LIMIT_MESSAGE =
    'A model call reached the token limit; raise max_tokens (background_max_tokens for background research) or context_size, or use Auto size in Options.';
export const REPETITION_MESSAGE = 'A model call kept repeating itself, so it was stopped.';

// Phi-4-mini's template has a <|tool|> block, and the model writes calls in <|tool_call|>; it drops the "||" of node-llama-cpp's generic "||call:" syntax.
const PHI_TOOL_BLOCK = "'<|tool|>'";
const PHI_FUNCTION_CALLS = {
    call: '<|tool_call|>[{"name": "{{functionName}}", "arguments": {{functionParams}}}]<|/tool_call|>',
    result: '\n<|tool_response|>{{functionCallResult}}\n',
} as const;

export type ChatCompletion = {
    content: string;
    tool_calls: ToolCall[];
    finish_reason: FinishReason;
};

export type ChatModel = {
    createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletion>;
    tokenize?(text: string): number[];
    close?(): Promise<void>;
};

// ============================================================================
// Backends
// ============================================================================

let gpuBackend: Promise<Llama> | null = null;
let cpuBackend: Promise<Llama> | null = null;

// A CPU-only model gets its own backend, so its context cache and prompt batches stay off the GPU.
export async function llamaBackend(onCpuOnly: boolean): Promise<Llama> {
    const { getLlama, LlamaLogLevel } = await import('node-llama-cpp');
    // Only llama.cpp's errors reach the terminal, so its load messages never mix into a reply.
    const logLevel = LlamaLogLevel.error;
    if (onCpuOnly) {
        cpuBackend ??= getLlama({ gpu: false, logLevel });
        return cpuBackend;
    }
    gpuBackend ??= getLlama({ logLevel });
    return gpuBackend;
}

// Load a GGUF file; a model with layers on the GPU holds the shared GPU lock until it is disposed.
export async function loadGgufModel(
    modelPath: string,
    gpuLayers: number,
    onWait?: (message: string) => void,
): Promise<{ llama: Llama; model: LlamaModel; release: () => void }> {
    const onCpuOnly = gpuLayers === 0;
    if (!onCpuOnly) {
        await GPU_LOCK.acquire(onWait);
    }
    try {
        const llama = await llamaBackend(onCpuOnly);
        const model = await llama.loadModel({
            modelPath,
            gpuLayers: onCpuOnly ? 0 : gpuLayers < 0 ? 'max' : gpuLayers,
            ignoreMemorySafetyChecks: true,
        });
        let released = false;
        const release = () => {
            if (!released && !onCpuOnly) {
                GPU_LOCK.release();
            }
            released = true;
        };
        return { llama, model, release };
    } catch (error) {
        if (!onCpuOnly) {
            GPU_LOCK.release();
        }
        throw error;
    }
}

// ============================================================================
// Local model
// ============================================================================

export class LocalModel implements ChatModel {
    private queue: Promise<unknown> = Promise.resolve();
    private readonly grammars = new Map<string, Promise<unknown>>();
    private chatWrapper: unknown = null;

    private constructor(
        private readonly llama: Llama,
        private readonly model: LlamaModel,
        private readonly context: LlamaContext,
        private readonly sequence: LlamaContextSequence,
        private readonly release: () => void,
    ) {}

    static async load(
        modelPath: string,
        contextSize: number,
        gpuLayers: number,
        onWait?: (message: string) => void,
    ): Promise<LocalModel> {
        const { llama, model, release } = await loadGgufModel(modelPath, gpuLayers, onWait);
        try {
            // Auto size fits the context to the card, so the library's own, stricter estimate is skipped.
            const context = await model.createContext({ contextSize, ignoreMemorySafetyChecks: true });
            return new LocalModel(llama, model, context, context.getSequence(), release);
        } catch (error) {
            await model.dispose();
            release();
            throw error;
        }
    }

    tokenize(text: string): number[] {
        return Array.from(this.model.tokenize(text, false));
    }

    async createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletion> {
        // One context sequence serves every call, so calls take turns.
        const turn = this.queue.then(() => this.complete(request));
        this.queue = turn.catch(() => undefined);
        return turn;
    }

    async close(): Promise<void> {
        await this.queue;
        await this.context.dispose();
        await this.model.dispose();
        this.release();
    }

    private async complete(request: ChatCompletionRequest): Promise<ChatCompletion> {
        const { LlamaChat, resolveChatWrapper } = await import('node-llama-cpp');
        // Every call asks for a direct reply, so a model that can think out loud is told not to.
        const template = this.model.fileInfo.metadata?.tokenizer?.chat_template;
        const phiTools = typeof template === 'string' && template.includes(PHI_TOOL_BLOCK);
        this.chatWrapper ??= resolveChatWrapper(this.model, {
            customWrapperSettings: {
                qwen: { thoughts: 'discourage' },
                ...(phiTools ? { jinjaTemplate: { functionCallMessageTemplate: PHI_FUNCTION_CALLS } } : {}),
            },
        });
        const chat = new LlamaChat({ contextSequence: this.sequence, chatWrapper: this.chatWrapper as never, autoDisposeSequence: false });
        const history = chatHistory(request.messages);
        const toolsOffered = (request.tools?.length ?? 0) > 0 && request.tool_choice !== 'none';
        const grammar = request.response_format?.schema ? await this.grammarFor(request.response_format.schema) : undefined;

        // A token callback that throws stops the call, which is how a waiting run takes the model back.
        const abort = new AbortController();
        const stopFromOutside = () => abort.abort(request.signal?.reason);
        request.signal?.addEventListener('abort', stopFromOutside, { once: true });
        let callbackError: unknown = null;
        let generated = '';
        let checkedLength = 0;
        let repeating = false;
        const onTextChunk = (text: string) => {
            if (callbackError !== null || repeating) {
                return;
            }
            generated += text;
            if (generated.length - checkedLength >= REPEAT_CHECK_CHARS) {
                checkedLength = generated.length;
                if (isRepeating(generated)) {
                    repeating = true;
                    abort.abort(new Error(REPETITION_MESSAGE));
                    return;
                }
            }
            if (!request.on_token) {
                return;
            }
            try {
                request.on_token(text);
            } catch (error) {
                callbackError = error;
                abort.abort(error);
            }
        };

        try {
            const response: GeneratedResponse = await chat.generateResponse([...history, { type: 'model', response: [] }], {
                maxTokens: request.max_tokens ?? MAX_TOKENS,
                temperature: request.temperature ?? TEMPERATURE,
                grammar: grammar as never,
                functions: toolsOffered ? functionDefinitions(request.tools!) : undefined,
                onTextChunk,
                signal: abort.signal,
            } as never);
            const toolCalls = (response.functionCalls ?? []).map((call, index) => ({
                id: `call_${index}`,
                type: 'function' as const,
                function: { name: call.functionName, arguments: JSON.stringify(call.params ?? {}) },
            }));
            const stopReason = response.metadata.stopReason;
            return {
                content: response.response,
                tool_calls: toolCalls,
                finish_reason: toolCalls.length > 0 ? 'tool_calls' : stopReason === 'maxTokens' ? 'length' : 'stop',
            };
        } catch (error) {
            if (repeating && callbackError === null && !request.signal?.aborted) {
                return { content: generated, tool_calls: [], finish_reason: 'repetition' };
            }
            throw callbackError ?? error;
        } finally {
            request.signal?.removeEventListener('abort', stopFromOutside);
            chat.dispose({ disposeSequence: false });
        }
    }

    private async grammarFor(schema: Record<string, unknown>): Promise<unknown> {
        const key = JSON.stringify(schema);
        let grammar = this.grammars.get(key);
        if (!grammar) {
            grammar = this.llama.createGrammarForJsonSchema(grammarSchema(schema) as never);
            this.grammars.set(key, grammar);
        }
        return grammar;
    }
}

// ============================================================================
// Conversions
// ============================================================================

// Turn chat messages into node-llama-cpp's history, pairing each tool call with the result that answered it.
export function chatHistory(messages: ChatMessage[]): ChatHistoryItem[] {
    const history: ChatHistoryItem[] = [];
    const pendingCalls = new Map<string, ChatModelFunctionCall>();

    for (const message of messages) {
        if (message.role === 'system') {
            history.push({ type: 'system', text: message.content ?? '' });
        } else if (message.role === 'user') {
            history.push({ type: 'user', text: message.content ?? '' });
        } else if (message.role === 'assistant') {
            const response: Array<string | ChatModelFunctionCall> = [];
            if (message.content) {
                response.push(message.content);
            }
            for (const call of message.tool_calls ?? []) {
                const functionCall: ChatModelFunctionCall = {
                    type: 'functionCall',
                    name: call.function.name,
                    params: parseArguments(call.function.arguments),
                    result: '',
                };
                pendingCalls.set(call.id, functionCall);
                response.push(functionCall);
            }
            history.push({ type: 'model', response });
        } else if (message.role === 'tool') {
            const call = message.tool_call_id ? pendingCalls.get(message.tool_call_id) : undefined;
            if (call) {
                call.result = message.content ?? '';
            } else {
                history.push({ type: 'user', text: message.content ?? '' });
            }
        }
    }
    return history;
}

function functionDefinitions(tools: ToolDefinition[]): ChatModelFunctions {
    const functions: Record<string, { description?: string; params?: GbnfJsonSchema }> = {};
    for (const tool of tools) {
        functions[tool.function.name] = {
            description: tool.function.description,
            params: tool.function.parameters ? (grammarSchema(tool.function.parameters) as GbnfJsonSchema) : undefined,
        };
    }
    return functions;
}

function parseArguments(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return {};
    }
}

const GRAMMAR_KEYWORDS = new Set([
    'type',
    'properties',
    'required',
    'items',
    'enum',
    'const',
    'oneOf',
    'anyOf',
    'description',
    'minItems',
    'maxItems',
    'minLength',
    'maxLength',
    'additionalProperties',
    'format',
    'prefixItems',
]);

// Keep only the schema keywords node-llama-cpp turns into grammar, and make every listed property required.
export function grammarSchema(schema: unknown): unknown {
    if (Array.isArray(schema)) {
        return schema.map(grammarSchema);
    }
    if (schema === null || typeof schema !== 'object') {
        return schema;
    }
    const source = schema as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
        if (!GRAMMAR_KEYWORDS.has(key)) {
            continue;
        }
        if (key === 'properties' && value && typeof value === 'object') {
            result.properties = Object.fromEntries(
                Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, grammarSchema(child)]),
            );
        } else if (key === 'items' || key === 'additionalProperties' || key === 'oneOf' || key === 'anyOf' || key === 'prefixItems') {
            result[key] = grammarSchema(value);
        } else {
            result[key] = value;
        }
    }
    if (result.type === 'object' && result.properties && result.required === undefined) {
        result.required = Object.keys(result.properties as Record<string, unknown>);
    }
    return result;
}

// ============================================================================
// Model cache
// ============================================================================

type CacheKey = [string, number, number];

// Keep one loaded model and reload it only when its load settings change.
export class ModelCache {
    private key: CacheKey | null = null;
    private model: Promise<LocalModel> | null = null;

    has(modelPath: string, contextSize: number, gpuLayers: number): boolean {
        return this.model !== null && this.key !== null && this.key[0] === modelPath && this.key[1] === contextSize && this.key[2] === gpuLayers;
    }

    async get(modelPath: string, contextSize: number, gpuLayers: number, onWait?: (message: string) => void): Promise<LocalModel> {
        if (!this.has(modelPath, contextSize, gpuLayers)) {
            // Drop the old model first so two never sit in memory together.
            await this.unload();
            const loading = LocalModel.load(modelPath, contextSize, gpuLayers, onWait);
            this.model = loading;
            this.key = [modelPath, contextSize, gpuLayers];
            loading.catch(() => {
                if (this.model === loading) {
                    this.model = null;
                    this.key = null;
                }
            });
        }
        return this.model!;
    }

    // Drop the loaded model to give its memory back, returning whether one was loaded.
    async unload(): Promise<boolean> {
        const loading = this.model;
        this.model = null;
        this.key = null;
        if (!loading) {
            return false;
        }
        try {
            await (await loading).close();
        } catch {
            // A model that failed to load holds nothing to free.
        }
        return true;
    }
}

// ============================================================================
// Repetition
// ============================================================================

// Looping text compresses far better than prose, code or data does, so a reply is checked by how small its tail packs.
export const REPEAT_WINDOW_CHARS = 1200;
export const REPEAT_CHECK_CHARS = 200;
export const REPEAT_RATIO = 0.2;

export function isRepeating(text: string): boolean {
    if (text.length < REPEAT_WINDOW_CHARS) {
        return false;
    }
    const tail = Buffer.from(text.slice(-REPEAT_WINDOW_CHARS), 'utf-8');
    return deflateRawSync(tail).length / tail.length < REPEAT_RATIO;
}

// ============================================================================
// One call
// ============================================================================

export type StageOptions = {
    maxTokens?: number;
    temperature?: number;
    onToken?: (token: string) => void;
    jsonSchema?: Record<string, unknown> | null;
    keepCutOff?: boolean;
    signal?: AbortSignal;
};

// Run one model call; with keepCutOff, a prose reply that hits the token limit keeps its complete sentences.
export async function runStage(llm: ChatModel, systemPrompt: string, userInput: string, options: StageOptions = {}): Promise<string> {
    const request: ChatCompletionRequest = {
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userInput },
        ],
        temperature: options.temperature ?? TEMPERATURE,
        max_tokens: options.maxTokens ?? MAX_TOKENS,
        on_token: options.onToken,
        signal: options.signal,
    };
    if (options.jsonSchema) {
        // The schema becomes a grammar, so the reply is always valid JSON of this shape.
        request.response_format = { type: 'json_object', schema: options.jsonSchema };
    }

    const completion = await llm.createChatCompletion(request);
    const content = completion.content;
    if (completion.finish_reason === 'length' && options.keepCutOff) {
        const end = Math.max(...['. ', '.\n', '! ', '? '].map((mark) => content.lastIndexOf(mark)));
        if (end > 0) {
            return content.slice(0, end + 1).trim();
        }
    }
    if (completion.finish_reason === 'length') {
        throw new Error(TOKEN_LIMIT_MESSAGE);
    }
    if (completion.finish_reason === 'repetition') {
        throw new Error(REPETITION_MESSAGE);
    }
    if (!content.trim()) {
        throw new Error('The model returned an empty completion.');
    }
    return content.trim();
}

// Return the given model, or load one, reporting the load only when it takes time.
export async function loadModel(
    llm: ChatModel | null | undefined,
    modelPath: string,
    contextSize: number,
    gpuLayers: number,
    modelCache: ModelCache | null,
    progressCallback?: (message: string) => void,
): Promise<ChatModel> {
    if (llm) {
        return llm;
    }
    const report = progressCallback ?? ((message: string) => console.log(message));
    if (modelCache === null || !modelCache.has(modelPath, contextSize, gpuLayers)) {
        report(progressCallback ? 'Loading model' : `Loading model from ${modelPath}...`);
    }
    if (modelCache) {
        return modelCache.get(modelPath, contextSize, gpuLayers, report);
    }
    return LocalModel.load(modelPath, contextSize, gpuLayers, report);
}
