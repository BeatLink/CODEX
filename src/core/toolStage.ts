export type ToolParameter = {
    type?: string;
    properties?: Record<string, { type?: string;[key: string]: unknown }>;
};

export type ToolDefinition = {
    function?: {
        name?: string;
        parameters?: {
            type?: string;
            properties?: Record<string, ToolParameter>;
        };
    };
};

export type ToolCall = {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
};

export type ToolBoxLike = {
    call: (name: string, args: Record<string, unknown>) => string;
    toolDefinitions?: ToolDefinition[];
};

const _TEXT_TOOL_CALL = /<tool_call>\s*([\s\S]*?)(?:<\/tool_call>|$)/g;
const _XML_FUNCTION = /<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/g;
const _XML_PARAMETER = /<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/g;

function parameterValue(value: string, parameterType?: string): unknown {
    if (parameterType === 'string' || parameterType === undefined) {
        return value;
    }
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function jsonToolBlocks(content: string): string[] {
    const blocks: string[] = [];
    let cursor = 0;

    while (cursor < content.length) {
        const start = content.indexOf('{', cursor);
        if (start === -1) {
            break;
        }

        let depth = 0;
        let inString = false;
        let escaped = false;
        let end = -1;

        for (let index = start; index < content.length; index += 1) {
            const char = content[index];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === '"') {
                    inString = false;
                }
                continue;
            }

            if (char === '"') {
                inString = true;
            } else if (char === '{') {
                depth += 1;
            } else if (char === '}') {
                depth -= 1;
                if (depth === 0) {
                    end = index;
                    break;
                }
            }
        }

        if (end === -1) {
            break;
        }

        const block = content.slice(start, end + 1);
        if (block.includes('"name"')) {
            blocks.push(block);
        }
        cursor = end + 1;
    }

    return blocks;
}

export function textToolCalls(content: string, toolDefinitions: ToolDefinition[]): ToolCall[] {
    if (typeof content !== 'string' || !content.trim()) {
        return [];
    }

    const propertiesByName = Object.fromEntries(
        (toolDefinitions ?? []).map((definition) => {
            const name = definition.function?.name ?? '';
            return [name, definition.function?.parameters?.properties ?? {}];
        }),
    );

    const calls: ToolCall[] = [];
    const seen = new Set<string>();

    const blocks: string[] = [];
    for (const match of content.matchAll(_TEXT_TOOL_CALL)) {
        blocks.push(match[1] ?? '');
    }
    for (const block of jsonToolBlocks(content)) {
        blocks.push(block);
    }

    for (const block of blocks) {
        const functionMatch = /<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/.exec(block);
        if (functionMatch) {
            const name = functionMatch[1];
            const argsSource = functionMatch[2] ?? '';
            const argumentsObject: Record<string, unknown> = {};
            for (const paramMatch of argsSource.matchAll(_XML_PARAMETER)) {
                const key = paramMatch[1];
                const rawValue = paramMatch[2] ?? '';
                const type = propertiesByName[name]?.[key]?.type ?? undefined;
                argumentsObject[key] = parameterValue(rawValue.trim(), type);
            }
            const payload = JSON.stringify(argumentsObject);
            const item: ToolCall = {
                id: `text-call-${calls.length + 1}`,
                type: 'function',
                function: { name, arguments: payload },
            };
            calls.push(item);
            seen.add(`${name}:${payload}`);
            continue;
        }

        try {
            const parsed = JSON.parse(block);
            if (!parsed || typeof parsed !== 'object' || typeof parsed.name !== 'string') {
                continue;
            }
            const functionName = parsed.name;
            const argumentsText = JSON.stringify(parsed.arguments ?? {});
            const key = `${functionName}:${argumentsText}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            calls.push({
                id: `text-call-${calls.length + 1}`,
                type: 'function',
                function: { name: functionName, arguments: argumentsText },
            });
        } catch {
            // Not a JSON call block.
        }
    }

    return calls;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    return !!value && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function';
}

export async function runToolStage(
    llm: { createChatCompletion: (request: Record<string, unknown>) => any },
    systemPrompt: string,
    userInput: string,
    toolbox: ToolBoxLike,
    maxTokens: number,
    temperature: number,
    maxToolCalls: number,
    onToken?: (token: string) => void,
    allowedTools?: Set<string> | null,
    pageSummarizer?: (body: string, focus: string, prompt: string) => string,
    blockedTools?: Set<string> | null,
    contextSize?: number,
): Promise<string> {
    const toolDefinitions = toolbox.toolDefinitions ?? [];
    const toolHistory: string[] = [];
    const messages: Array<Record<string, unknown>> = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInput },
    ];

    let toolCallCount = 0;
    while (true) {
        const request: Record<string, unknown> = {
            messages,
            temperature,
            max_tokens: maxTokens,
            tools: toolDefinitions,
            tool_choice: toolCallCount < maxToolCalls ? 'auto' : 'none',
        };
        if (onToken) {
            request.stream = true;
        }

        let response = llm.createChatCompletion(request);
        if (onToken && isAsyncIterable(response)) {
            const contentParts: string[] = [];
            const toolCallsByIndex: Record<number, ToolCall> = {};
            let finishReason: string | null = null;

            for await (const chunk of response) {
                const typedChunk = chunk as Record<string, unknown> | null | undefined;
                const choices = Array.isArray(typedChunk?.choices) ? (typedChunk.choices as Array<Record<string, unknown>>) : [];
                if (!choices.length) {
                    continue;
                }
                const choice = (choices[0] ?? {}) as Record<string, unknown>;
                finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : finishReason;
                const delta = (choice.delta ?? {}) as Record<string, unknown>;
                const content = typeof delta.content === 'string' ? delta.content : '';
                if (content) {
                    contentParts.push(content);
                    onToken(content);
                }

                const streamToolCalls = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Array<Record<string, unknown>>) : [];
                for (const streamedCall of streamToolCalls) {
                    const callIndex = Number((streamedCall.index ?? 0) as number);
                    const toolCall = toolCallsByIndex[callIndex] ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
                    if (typeof streamedCall.id === 'string' && streamedCall.id) {
                        toolCall.id = streamedCall.id;
                    }
                    if (typeof streamedCall.type === 'string' && streamedCall.type) {
                        toolCall.type = streamedCall.type as 'function';
                    }
                    const functionDelta = (streamedCall.function ?? {}) as Record<string, unknown>;
                    if (typeof functionDelta.name === 'string') {
                        toolCall.function.name += functionDelta.name;
                    }
                    if (typeof functionDelta.arguments === 'string') {
                        toolCall.function.arguments += functionDelta.arguments;
                    }
                    toolCallsByIndex[callIndex] = toolCall;
                }
            }

            const assistantMessage: Record<string, unknown> = {
                role: 'assistant',
                content: contentParts.join('') || null,
            };
            if (Object.keys(toolCallsByIndex).length > 0) {
                assistantMessage.tool_calls = Object.keys(toolCallsByIndex)
                    .map((key) => toolCallsByIndex[Number(key)])
                    .sort((left, right) => left.id.localeCompare(right.id, 'en'));
            }
            response = { choices: [{ finish_reason: finishReason, message: assistantMessage }] };
        }

        const choices = Array.isArray(response?.choices) ? response.choices : [];
        if (!choices.length) {
            throw new Error('The model returned no completion choices.');
        }

        const choice = choices[0];
        if (choice?.finish_reason === 'length') {
            throw new Error('The tool stage reached the token limit; raise max_tokens or context_size.');
        }

        const assistantMessage = choice.message ?? {};
        let toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
        if (!toolCalls.length) {
            const parsedToolCalls = textToolCalls(String(assistantMessage.content ?? ''), toolDefinitions);
            if (parsedToolCalls.length) {
                toolCalls = parsedToolCalls;
                assistantMessage.content = assistantMessage.content ? String(assistantMessage.content).split('<tool_call>', 1)[0].trim() : '';
            }
        }

        if (!toolCalls.length) {
            const content = typeof assistantMessage.content === 'string' ? assistantMessage.content.trim() : '';
            if (!content) {
                throw new Error('The model returned an empty tool-stage response.');
            }
            return toolHistory.length ? `${content}\n\nTool call results:\n${toolHistory.join('\n')}` : content;
        }

        if (toolCallCount >= maxToolCalls) {
            const content = typeof assistantMessage.content === 'string' ? assistantMessage.content.trim() : '';
            const extra = [
                content,
                'The tool-call limit was reached; further requested tool calls were not run.',
                toolHistory.length ? `Tool call results:\n${toolHistory.join('\n')}` : '',
            ].filter(Boolean).join('\n\n');
            return extra;
        }

        messages.push({ role: 'assistant', ...assistantMessage });
        for (const toolCall of toolCalls as ToolCall[]) {
            const callId = toolCall.id;
            const functionName = toolCall.function.name;
            if (typeof callId !== 'string' || !callId) {
                throw new Error('The model returned a tool call without an ID.');
            }
            if (allowedTools && !allowedTools.has(functionName)) {
                throw new Error(`Tool error: tool '${functionName}' is not allowed in this stage.`);
            }
            if (blockedTools && blockedTools.has(functionName)) {
                throw new Error(`Tool error: tool '${functionName}' is not allowed in this stage.`);
            }

            try {
                const argumentsValue = typeof toolCall.function.arguments === 'string' ? JSON.parse(toolCall.function.arguments) : toolCall.function.arguments;
                const args = argumentsValue && typeof argumentsValue === 'object' ? argumentsValue as Record<string, unknown> : {};
                const result = toolbox.call(functionName, args);
                toolHistory.push(`${functionName}: ${result}`);
                messages.push({ role: 'tool', tool_call_id: callId, content: result });
            } catch {
                const error = `Tool error: invalid JSON arguments for ${functionName}.`;
                toolHistory.push(`${functionName}: ${error}`);
                messages.push({ role: 'tool', tool_call_id: callId, content: error });
            }
            toolCallCount += 1;
        }
    }
}
