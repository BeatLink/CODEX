// A model call that may use tools: the model asks for tools, gets their results, and answers within the call budget.
import { inputCharBudget, untrustedBlock } from './contextBudget.js';
import { MCPToolbox } from './mcpTools.js';
import { REPETITION_MESSAGE, type ChatCompletionRequest, type ChatMessage, type ChatModel, type ToolCall, type ToolDefinition } from './model.js';
import type { McpServerSettings } from './settings.js';

// ============================================================================
// Limits
// ============================================================================

export const MAX_TOOL_HISTORY_CHARS = 8_000;

// The part of a toolbox the stage uses, so the built-in toolbox or a stand-in can serve.
export type ToolboxLike = {
    toolDefinitions: ToolDefinition[];
    call(name: string, argumentsGiven: unknown): Promise<string> | string;
};

export type PageSummarizer = (pageJson: string, focus: string, requestContext: string) => Promise<string> | string;

export type ToolStageOptions = {
    mcpServers?: McpServerSettings[] | null;
    onToken?: ((token: string) => void) | null;
    allowedTools?: Set<string> | null;
    pageSummarizer?: PageSummarizer | null;
    blockedTools?: Set<string> | null;
    contextSize?: number | null;
    signal?: AbortSignal;
};

// Measure a value as Python's json.dumps writes it, with spaced separators and escaped non-ASCII, so budgets match.
export function pythonJsonLength(value: unknown): number {
    return pythonJson(value).length;
}

function pythonJson(value: unknown): string {
    if (value === null || value === undefined) {
        return 'null';
    }
    if (typeof value === 'string') {
        return JSON.stringify(value).replace(/[\u0080-￿]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(pythonJson).join(', ')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    return `{${entries.map(([key, item]) => `${pythonJson(key)}: ${pythonJson(item)}`).join(', ')}}`;
}

// ============================================================================
// Tool calls written as text
// ============================================================================

// Qwen models write tool calls as text that the chat template does not turn into tool calls.
const TEXT_TOOL_CALL = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g;
const XML_FUNCTION = /<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/;
const XML_PARAMETER = /<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/g;
// Spark models name the tool first and give each argument as an <arg_key>/<arg_value> pair.
const ARG_KEY_FUNCTION = /^([^\s<{]+)\s*(<arg_key>[\s\S]*)?$/;
const ARG_KEY_PARAMETER = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;

// Keep a string parameter as written, and read any other type as JSON when it parses.
function parameterValue(value: string, parameterType: unknown): unknown {
    if (parameterType === 'string') {
        return value;
    }
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

// Say whether a value counts as empty the way Python's truth test does.
function isEmpty(value: unknown): boolean {
    if (Array.isArray(value)) {
        return value.length === 0;
    }
    if (typeof value === 'object' && value !== null) {
        return Object.keys(value).length === 0;
    }
    return !value;
}

type Properties = Record<string, { type?: unknown } | undefined>;

// Read the tool calls a reply wrote as text, in Qwen's XML form, Spark's arg_key form or as JSON, in the shape of real tool calls.
export function textToolCalls(content: unknown, toolDefinitions: ToolDefinition[]): ToolCall[] {
    if (typeof content !== 'string') {
        return [];
    }
    const properties = new Map<string, Properties>(
        toolDefinitions.map((definition) => [definition.function.name, ((definition.function.parameters ?? {}).properties ?? {}) as Properties]),
    );
    const calls: ToolCall[] = [];
    for (const [, block] of content.matchAll(TEXT_TOOL_CALL)) {
        let name: string;
        let argumentsGiven: unknown;
        const xmlFunction = XML_FUNCTION.exec(block);
        const argKeyFunction = xmlFunction ? null : ARG_KEY_FUNCTION.exec(block);
        if (xmlFunction) {
            name = xmlFunction[1];
            const parameters: Record<string, unknown> = {};
            for (const [, key, value] of xmlFunction[2].matchAll(XML_PARAMETER)) {
                parameters[key] = parameterValue(value, properties.get(name)?.[key]?.type);
            }
            argumentsGiven = parameters;
        } else if (argKeyFunction) {
            name = argKeyFunction[1];
            const parameters: Record<string, unknown> = {};
            for (const [, key, value] of (argKeyFunction[2] ?? '').matchAll(ARG_KEY_PARAMETER)) {
                parameters[key] = parameterValue(value, properties.get(name)?.[key]?.type);
            }
            argumentsGiven = parameters;
        } else {
            let data: unknown;
            try {
                data = JSON.parse(block);
            } catch {
                continue;
            }
            if (typeof data !== 'object' || data === null || Array.isArray(data) || typeof (data as { name?: unknown }).name !== 'string') {
                continue;
            }
            const record = data as { name: string; arguments?: unknown };
            name = record.name;
            argumentsGiven = isEmpty(record.arguments) ? {} : record.arguments;
        }
        calls.push({ id: `text-call-${calls.length + 1}`, type: 'function', function: { name, arguments: JSON.stringify(argumentsGiven) } });
    }
    return calls;
}

// ============================================================================
// The stage
// ============================================================================

function isPermitted(name: string, allowedTools: Set<string> | null | undefined, blockedTools: Set<string> | null | undefined): boolean {
    return (allowedTools == null || allowedTools.has(name)) && !(blockedTools?.has(name) ?? false);
}

// Let the model call tools until it answers or the call limit is reached, and return its answer with the tool results.
export async function runToolStage(
    llm: ChatModel,
    systemPrompt: string,
    userInput: string,
    toolbox: ToolboxLike,
    maxTokens: number,
    temperature: number,
    maxToolCalls: number,
    options: ToolStageOptions = {},
): Promise<string> {
    if (typeof maxToolCalls !== 'number' || !Number.isInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 10) {
        throw new Error('max_tool_calls must be between 1 and 10.');
    }
    const mcpToolbox = new MCPToolbox(options.mcpServers ?? []);
    await mcpToolbox.open();
    try {
        return await toolLoop(llm, systemPrompt, userInput, toolbox, mcpToolbox, maxTokens, temperature, maxToolCalls, options);
    } finally {
        await mcpToolbox.close();
    }
}

async function toolLoop(
    llm: ChatModel,
    systemPrompt: string,
    userInput: string,
    toolbox: ToolboxLike,
    mcpToolbox: MCPToolbox,
    maxTokens: number,
    temperature: number,
    maxToolCalls: number,
    options: ToolStageOptions,
): Promise<string> {
    const { allowedTools, blockedTools, pageSummarizer, onToken } = options;
    const toolDefinitions = [...toolbox.toolDefinitions, ...mcpToolbox.toolDefinitions].filter((definition) =>
        isPermitted(definition.function.name, allowedTools, blockedTools),
    );
    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInput },
    ];
    const toolHistory: string[] = [];
    let toolCallCount = 0;
    let toolOutputChars = 0;
    const messageCharBudget = options.contextSize != null ? inputCharBudget(options.contextSize, maxTokens, pythonJson(toolDefinitions)) : null;

    while (true) {
        const request: ChatCompletionRequest = {
            messages,
            temperature,
            max_tokens: maxTokens,
            tools: toolDefinitions,
            tool_choice: toolCallCount < maxToolCalls ? 'auto' : 'none',
            signal: options.signal,
        };
        if (onToken) {
            request.on_token = onToken;
        }
        const completion = await llm.createChatCompletion(request);
        if (completion.finish_reason === 'length') {
            throw new Error(
                'The tool stage reached the token limit; raise max_tokens (background_max_tokens for background research) or context_size, or use Auto size in Options.',
            );
        }
        if (completion.finish_reason === 'repetition') {
            throw new Error(REPETITION_MESSAGE);
        }

        let assistantMessage: ChatMessage = { role: 'assistant', content: completion.content || null };
        let toolCalls = completion.tool_calls ?? [];
        if (toolCalls.length > 0) {
            assistantMessage.tool_calls = toolCalls;
        } else {
            toolCalls = textToolCalls(completion.content, toolDefinitions);
            if (toolCalls.length > 0) {
                // The text before the first call is the reply's own words; the calls go back as real tool calls.
                const beforeCalls = completion.content.split('<tool_call>', 1)[0].trim();
                assistantMessage = { role: 'assistant', content: beforeCalls || null, tool_calls: toolCalls };
            }
        }
        if (toolCalls.length === 0) {
            const content = assistantMessage.content;
            if (typeof content !== 'string' || !content.trim()) {
                throw new Error('The model returned an empty tool-stage response.');
            }
            if (toolHistory.length > 0) {
                return `${content.trim()}\n\nTool call results:\n${toolHistory.join('\n')}`;
            }
            return content.trim();
        }
        if (toolCallCount >= maxToolCalls) {
            const findings = typeof assistantMessage.content === 'string' ? assistantMessage.content.trim() : '';
            return [
                findings,
                'The tool-call limit was reached; further requested tool calls were not run.',
                toolHistory.length > 0 ? `Tool call results:\n${toolHistory.join('\n')}` : '',
            ]
                .filter(Boolean)
                .join('\n\n');
        }

        messages.push(assistantMessage);
        for (const toolCall of toolCalls) {
            const callId = toolCall.id;
            const name = toolCall.function?.name ?? '';
            if (typeof callId !== 'string' || !callId) {
                throw new Error('The model returned a tool call without an ID.');
            }

            let result: string;
            if (toolCallCount >= maxToolCalls) {
                result = 'Tool error: the configured tool-call limit was reached.';
            } else if (!isPermitted(name, allowedTools, blockedTools)) {
                result = `Tool error: tool '${name}' is not allowed in this stage.`;
            } else {
                toolCallCount += 1;
                result = await runOneCall(name, toolCall.function?.arguments ?? '{}', toolbox, mcpToolbox, pageSummarizer, userInput);
            }

            let remainingOutput = MAX_TOOL_HISTORY_CHARS - toolOutputChars;
            if (messageCharBudget !== null) {
                const usedChars = messages.reduce((total, message) => total + pythonJsonLength(message), 0);
                remainingOutput = Math.min(remainingOutput, messageCharBudget - usedChars);
            }
            remainingOutput = Math.max(0, remainingOutput);
            if (result.length > remainingOutput) {
                result = result.slice(0, remainingOutput);
            }
            toolOutputChars += result.length;

            messages.push({ role: 'tool', tool_call_id: callId, content: untrustedBlock(result) });
            toolHistory.push(`${name}: ${result}`);
        }
    }
}

// Run one permitted tool call, turning a fetched page into a summary before the model sees it.
async function runOneCall(
    name: string,
    rawArguments: string,
    toolbox: ToolboxLike,
    mcpToolbox: MCPToolbox,
    pageSummarizer: PageSummarizer | null | undefined,
    userInput: string,
): Promise<string> {
    let argumentsGiven: unknown;
    try {
        argumentsGiven = JSON.parse(rawArguments);
    } catch (error) {
        return `Tool error: invalid JSON arguments: ${(error as Error).message}`;
    }
    let result = mcpToolbox.handles(name)
        ? await mcpToolbox.call(name, argumentsGiven as Record<string, unknown>)
        : await toolbox.call(name, argumentsGiven);
    if (name === 'web_fetch' && !result.startsWith('Tool error:')) {
        if (!pageSummarizer) {
            result = 'Tool error: webpage summarization is unavailable.';
        } else {
            const focus = (argumentsGiven as { focus?: unknown }).focus ?? '';
            result = await pageSummarizer(result, String(focus), userInput);
        }
    }
    return result;
}
