import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Ollama } from 'ollama';
import { generateStructured, LLMValidationError, RETRY_CORRECTION_PROMPT } from './client.js';

describe('generateStructured', () => {
  const testSchema = z.object({
    name: z.string(),
    score: z.number()
  });

  it('should successfully validate structured output on the first attempt', async () => {
    const mockChat = vi.fn().mockResolvedValue({
      message: {
        role: 'assistant',
        content: JSON.stringify({ name: 'test-agent', score: 95 })
      }
    });

    const mockClient = { chat: mockChat } as unknown as Ollama;

    const result = await generateStructured({
      model: 'qwen3:8b',
      systemPrompt: 'You are a test helper.',
      userPrompt: 'Generate a score.',
      schema: testSchema,
      client: mockClient
    });

    expect(result).toEqual({ name: 'test-agent', score: 95 });
    expect(mockChat).toHaveBeenCalledTimes(1);

    const callArgs = mockChat.mock.calls[0][0];
    expect(callArgs.model).toBe('qwen3:8b');
    expect(callArgs.options).toEqual({ temperature: 0 });
    expect(callArgs.messages).toEqual([
      { role: 'system', content: 'You are a test helper.' },
      { role: 'user', content: 'Generate a score.' }
    ]);
    expect(callArgs.format).toBeDefined();
    expect(callArgs.format.properties.name.type).toBe('string');
  });

  it('should retry when response is malformed JSON and succeed on retry', async () => {
    const mockChat = vi
      .fn()
      .mockResolvedValueOnce({
        message: {
          role: 'assistant',
          content: 'not valid json at all'
        }
      })
      .mockResolvedValueOnce({
        message: {
          role: 'assistant',
          content: JSON.stringify({ name: 'recovered-agent', score: 80 })
        }
      });

    const mockClient = { chat: mockChat } as unknown as Ollama;

    const result = await generateStructured({
      model: 'qwen3:8b',
      userPrompt: 'Score again.',
      schema: testSchema,
      client: mockClient,
      maxRetries: 2
    });

    expect(result).toEqual({ name: 'recovered-agent', score: 80 });
    expect(mockChat).toHaveBeenCalledTimes(2);

    // Verify retry message contains correction prompt
    const secondCallArgs = mockChat.mock.calls[1][0];
    expect(secondCallArgs.messages).toHaveLength(3);
    expect(secondCallArgs.messages[1]).toEqual({ role: 'assistant', content: 'not valid json at all' });
    expect(secondCallArgs.messages[2]).toEqual({ role: 'user', content: RETRY_CORRECTION_PROMPT });
  });

  it('should retry when response violates Zod schema and succeed on retry', async () => {
    const mockChat = vi
      .fn()
      .mockResolvedValueOnce({
        message: {
          role: 'assistant',
          // Missing 'score' and wrong type for 'name'
          content: JSON.stringify({ name: 12345 })
        }
      })
      .mockResolvedValueOnce({
        message: {
          role: 'assistant',
          content: JSON.stringify({ name: 'fixed-agent', score: 100 })
        }
      });

    const mockClient = { chat: mockChat } as unknown as Ollama;

    const result = await generateStructured({
      model: 'qwen3:8b',
      userPrompt: 'Generate agent.',
      schema: testSchema,
      client: mockClient,
      maxRetries: 2
    });

    expect(result).toEqual({ name: 'fixed-agent', score: 100 });
    expect(mockChat).toHaveBeenCalledTimes(2);
  });

  it('should throw LLMValidationError when all retries fail with invalid JSON', async () => {
    const mockChat = vi.fn().mockResolvedValue({
      message: {
        role: 'assistant',
        content: 'broken json response'
      }
    });

    const mockClient = { chat: mockChat } as unknown as Ollama;

    await expect(
      generateStructured({
        model: 'qwen3:8b',
        userPrompt: 'Test broken.',
        schema: testSchema,
        client: mockClient,
        maxRetries: 2
      })
    ).rejects.toThrow(LLMValidationError);

    // Initial attempt + 2 retries = 3 calls
    expect(mockChat).toHaveBeenCalledTimes(3);

    try {
      await generateStructured({
        model: 'qwen3:8b',
        userPrompt: 'Test broken.',
        schema: testSchema,
        client: mockClient,
        maxRetries: 1
      });
    } catch (err) {
      expect(err).toBeInstanceOf(LLMValidationError);
      const valErr = err as LLMValidationError;
      expect(valErr.rawResponse).toBe('broken json response');
      expect(valErr.attempts).toBe(2);
    }
  });

  it('should throw LLMValidationError when all retries fail with invalid schema', async () => {
    const mockChat = vi.fn().mockResolvedValue({
      message: {
        role: 'assistant',
        content: JSON.stringify({ wrongField: true })
      }
    });

    const mockClient = { chat: mockChat } as unknown as Ollama;

    try {
      await generateStructured({
        model: 'qwen3:8b',
        userPrompt: 'Invalid schema.',
        schema: testSchema,
        client: mockClient,
        maxRetries: 1
      });
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMValidationError);
      const valErr = err as LLMValidationError;
      expect(valErr.rawResponse).toBe(JSON.stringify({ wrongField: true }));
      expect(valErr.attempts).toBe(2);
      expect(valErr.zodError).toBeDefined();
    }
  });
});
