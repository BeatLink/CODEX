export type ChatMessage = {
  role: string;
  content: string;
};

export type ChatCompletionRequest = {
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  response_format?: { type: string; schema?: Record<string, unknown> };
};

export type ChatCompletionResponse = {
  choices: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null };
    delta?: { content?: string | null };
  }>;
};

export type LLMLike = {
  createChatCompletion: (request: ChatCompletionRequest) => ChatCompletionResponse | AsyncIterable<ChatCompletionResponse>;
};

export async function runStage(
  llm: LLMLike,
  systemPrompt: string,
  userInput: string,
  maxTokens = 256,
  temperature = 0.2,
  onToken?: (token: string) => void,
  jsonSchema?: Record<string, unknown>,
): Promise<string> {
  const request: ChatCompletionRequest = {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userInput },
    ],
    temperature,
    max_tokens: maxTokens,
  };

  if (jsonSchema) {
    request.response_format = { type: 'json_object', schema: jsonSchema };
  }

  if (onToken) {
    request.stream = true;
  }

  const response = llm.createChatCompletion(request);
  if (onToken && typeof (response as AsyncIterable<ChatCompletionResponse>)[Symbol.asyncIterator] === 'function') {
    const parts: string[] = [];
    for await (const chunk of response as AsyncIterable<ChatCompletionResponse>) {
      const choice = chunk.choices[0];
      const content = choice?.delta?.content ?? '';
      if (content) {
        parts.push(content);
        onToken(content);
      }
    }
    return parts.join('');
  }

  const choice = (response as ChatCompletionResponse).choices[0];
  const content = choice?.message?.content ?? '';
  if (!content.trim()) {
    throw new Error('The model returned an empty completion.');
  }
  return content.trim();
}

export class ModelCache {
  private model: unknown = null;
  private key: [string, number, number] | null = null;

  has(modelPath: string, contextSize: number, gpuLayers: number): boolean {
    return this.model !== null && this.key !== null && this.key[0] === modelPath && this.key[1] === contextSize && this.key[2] === gpuLayers;
  }

  get(modelPath: string, contextSize: number, gpuLayers: number): unknown {
    if (!this.has(modelPath, contextSize, gpuLayers)) {
      this.model = { path: modelPath, contextSize, gpuLayers };
      this.key = [modelPath, contextSize, gpuLayers];
    }
    return this.model;
  }

  unload(): boolean {
    const hadModel = this.model !== null;
    this.model = null;
    this.key = null;
    return hadModel;
  }
}

export function createModel(
  modelPath: string,
  contextSize: number,
  gpuLayers: number,
  onWait?: (message: string) => void,
): unknown {
  if (onWait) {
    onWait(`Loading model from ${modelPath}`);
  }
  return { modelPath, contextSize, gpuLayers };
}

export function loadModel(
  llm: unknown,
  modelPath: string,
  contextSize: number,
  gpuLayers: number,
  modelCache: ModelCache | null,
  progressCallback?: (message: string) => void,
): unknown {
  if (llm !== undefined && llm !== null) {
    return llm;
  }

  if (modelCache && modelCache.has(modelPath, contextSize, gpuLayers)) {
    return modelCache.get(modelPath, contextSize, gpuLayers);
  }

  if (progressCallback) {
    progressCallback(`Loading model from ${modelPath}`);
  }

  const model = modelCache ? modelCache.get(modelPath, contextSize, gpuLayers) : createModel(modelPath, contextSize, gpuLayers, progressCallback);
  return model;
}
