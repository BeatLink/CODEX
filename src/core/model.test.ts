import { describe, expect, it } from 'vitest';

import { ModelCache, runStage } from './model.js';

describe('model runtime helpers', () => {
  it('builds a chat request and extracts the completion text', async () => {
    const llm = {
      createChatCompletion: (request: Record<string, unknown>) => {
        const messages = Array.isArray(request.messages) ? request.messages : [];
        const first = messages[0] as Record<string, unknown> | undefined;
        const second = messages[1] as Record<string, unknown> | undefined;

        return {
          choices: [{
            message: { content: `system:${String(first?.role ?? '')} user:${String(second?.content ?? '')}` },
            finish_reason: 'stop',
          }],
        };
      },
    };

    await expect(runStage(llm as any, 'system prompt', 'hello world', 64, 0.2)).resolves.toBe('system:system user:hello world');
  });

  it('tracks model cache keys and unloads them', () => {
    const cache = new ModelCache();
    const model = { name: 'stub-model' };

    cache['model'] = model;
    cache['key'] = ['stub-model', 4096, 0] as any;

    expect(cache.has('stub-model', 4096, 0)).toBe(true);
    expect(cache.unload()).toBe(true);
    expect(cache.has('stub-model', 4096, 0)).toBe(false);
  });
});
