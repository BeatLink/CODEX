// A model call that may use tools: the model asks for tools, gets their results, and answers within the call budget.
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';

import { inputCharBudget, untrustedBlock } from './contextBudget.js';
import { MCPToolbox } from './mcpTools.js';
import { REPETITION_MESSAGE, type ChatCompletionRequest, type ChatMessage, type ChatModel, type ToolCall, type ToolDefinition } from './model.js';
import type { McpServerSettings } from './settings.js';

// ============================================================================
// Limits
// ============================================================================

export const MAX_TOOL_HISTORY_CHARS = 8_000;
// Connected tools are the MCP servers' tools, named with this prefix.
export const CONNECTED_TOOL_PREFIX = 'mcp__';
export const REPEATED_CALL_NOTE = 'Same call as before; this result is already above. Answer from it now.';
const LIMIT_REACHED_ERROR = 'Tool error: the configured tool-call limit was reached.';
export const ANSWER_NOW_CALL_NOTE = 'The model tried to call a tool after being told to answer; the call was not run.';

// The part of a toolbox the stage uses, so the built-in toolbox or a stand-in can serve.
export type ToolboxLike = {
    toolDefinitions: ToolDefinition[];
    call(name: string, argumentsGiven: unknown): Promise<string> | string;
};

// One tool call as the loop saw it: whether it named an offered tool with arguments its schema accepts, and whether it failed.
export type ToolCallRecord = { name: string; arguments: string; valid: boolean; error: boolean };

export type PageSummarizer = (pageJson: string, focus: string, requestContext: string) => Promise<string> | string;

export type ToolStageOptions = {
    mcpServers?: McpServerSettings[] | null;
    onToken?: ((token: string) => void) | null;
    allowedTools?: Set<string> | null;
    pageSummarizer?: PageSummarizer | null;
    blockedTools?: Set<string> | null;
    contextSize?: number | null;
    signal?: AbortSignal;
    // Hears every tool call the model makes in this stage, in order, once its result is known.
    onToolCall?: ((call: ToolCallRecord) => void) | null;
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

// node-llama-cpp parses tool calls natively; these patterns read a call it missed and left in the reply text.
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
// Checking a call's arguments
// ============================================================================

const SCHEMA_VALIDATOR = new AjvJsonSchemaValidator();

// Say whether a call names one of the offered tools and gives arguments its JSON schema accepts.
export function callIsValid(name: string, rawArguments: string, toolDefinitions: ToolDefinition[]): boolean {
    const definition = toolDefinitions.find((offered) => offered.function.name === name);
    if (definition === undefined) {
        return false;
    }
    let argumentsGiven: unknown;
    try {
        argumentsGiven = JSON.parse(rawArguments);
    } catch {
        return false;
    }
    if (typeof argumentsGiven !== 'object' || argumentsGiven === null || Array.isArray(argumentsGiven)) {
        return false;
    }
    try {
        return SCHEMA_VALIDATOR.getValidator((definition.function.parameters ?? {}) as JsonSchemaType)(argumentsGiven).valid;
    } catch {
        // A schema the validator cannot read says nothing against the call.
        return true;
    }
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
    const { allowedTools, blockedTools, pageSummarizer, onToken, onToolCall } = options;
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
    // Each call's result by tool name and arguments, so a repeated call is answered without running the tool again.
    const earlierResults = new Map<string, string>();
    const usedTools = new Set<string>();
    let connectedAnswered = false;
    let roundsWithoutNewTool = 0;
    let answerNow = false;
    const messageCharBudget = options.contextSize != null ? inputCharBudget(options.contextSize, maxTokens, pythonJson(toolDefinitions)) : null;

    const recordCall = (toolCall: ToolCall, result: string) => {
        const name = toolCall.function?.name ?? '';
        const rawArguments = toolCall.function?.arguments ?? '{}';
        onToolCall?.({ name, arguments: rawArguments, valid: callIsValid(name, rawArguments, toolDefinitions), error: isToolError(result) });
    };

    while (true) {
        const request: ChatCompletionRequest = {
            messages,
            temperature,
            max_tokens: maxTokens,
            tools: toolDefinitions,
            tool_choice: toolCallCount < maxToolCalls && !answerNow ? 'auto' : 'none',
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
        } else if (request.tool_choice === 'none') {
            // A turn told to answer never runs a call written as text, so a reply that is only a call ends with the findings so far.
            if (typeof completion.content === 'string' && completion.content.trim() && !completion.content.replace(TEXT_TOOL_CALL, '').trim()) {
                return [ANSWER_NOW_CALL_NOTE, toolHistory.length > 0 ? `Tool call results:\n${toolHistory.join('\n')}` : ''].filter(Boolean).join('\n\n');
            }
        } else {
            toolCalls = textToolCalls(completion.content, toolDefinitions);
            if (toolCalls.length > 0) {
                // Native parsing catches every call to an offered tool, so a call read from text then is reported as a fault to trace.
                if (request.tool_choice === 'auto') {
                    console.warn(`Tool calls arrived as text and were read by textToolCalls: ${toolCalls.map((call) => call.function.name).join(', ')}`);
                }
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
            for (const toolCall of toolCalls) {
                recordCall(toolCall, LIMIT_REACHED_ERROR);
            }
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
        let allRepeats = true;
        let newTool = false;
        for (const toolCall of toolCalls) {
            const callId = toolCall.id;
            const name = toolCall.function?.name ?? '';
            if (typeof callId !== 'string' || !callId) {
                throw new Error('The model returned a tool call without an ID.');
            }

            let result: string;
            let historyEntry: string | null = null;
            const key = callKey(name, toolCall.function?.arguments ?? '{}');
            const earlier = earlierResults.get(key);
            if (toolCallCount >= maxToolCalls) {
                result = LIMIT_REACHED_ERROR;
                allRepeats = false;
            } else if (!isPermitted(name, allowedTools, blockedTools)) {
                result = `Tool error: tool '${name}' is not allowed in this stage.`;
                allRepeats = false;
            } else if (earlier !== undefined) {
                // A repeat still counts toward the limit, so a model that keeps repeating itself cannot loop forever.
                toolCallCount += 1;
                result = `${REPEATED_CALL_NOTE}\n\n${earlier}`;
                historyEntry = `${name}: ${REPEATED_CALL_NOTE}`;
            } else {
                toolCallCount += 1;
                allRepeats = false;
                newTool = newTool || !usedTools.has(name);
                usedTools.add(name);
                result = await runOneCall(name, toolCall.function?.arguments ?? '{}', toolbox, mcpToolbox, pageSummarizer, userInput);
                earlierResults.set(key, result);
                connectedAnswered = connectedAnswered || (name.startsWith(CONNECTED_TOOL_PREFIX) && !isToolError(result));
            }

            // A repeat failed when the call it repeats failed.
            recordCall(toolCall, earlier !== undefined && result.startsWith(REPEATED_CALL_NOTE) ? earlier : result);

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
            toolHistory.push(historyEntry ?? `${name}: ${result}`);
        }
        // Once a connected tool has answered, a round of only repeats or two rounds without a new tool make the next turn answer without tools.
        roundsWithoutNewTool = newTool ? 0 : roundsWithoutNewTool + 1;
        answerNow = connectedAnswered && (allRepeats || roundsWithoutNewTool >= 2);
    }
}

// Say whether a tool's result reports an error instead of an answer.
function isToolError(result: string): boolean {
    return result.startsWith('Tool error:') || result.startsWith('MCP tool error:');
}

// Key a call by its tool and its arguments, with keys sorted, so the same call written differently matches.
function callKey(name: string, rawArguments: string): string {
    try {
        return `${name} ${pythonJson(sortedKeys(JSON.parse(rawArguments)))}`;
    } catch {
        return `${name} ${rawArguments}`;
    }
}

function sortedKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortedKeys);
    }
    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
                .map(([key, item]) => [key, sortedKeys(item)]),
        );
    }
    return value;
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
