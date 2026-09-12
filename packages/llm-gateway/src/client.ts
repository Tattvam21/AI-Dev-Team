import { Ollama } from 'ollama';
import { ZodType, ZodError } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export class LLMValidationError extends Error {
  public readonly rawResponse: string;
  public readonly zodError?: ZodError;
  public readonly attempts: number;

  constructor(message: string, rawResponse: string, attempts: number, zodError?: ZodError) {
    super(message);
    this.name = 'LLMValidationError';
    this.rawResponse = rawResponse;
    this.attempts = attempts;
    this.zodError = zodError;
    Object.setPrototypeOf(this, LLMValidationError.prototype);
  }
}

export class LLMTimeoutError extends Error {
  public readonly timeoutMs: number;
  public readonly model: string;

  constructor(message: string, timeoutMs: number, model: string) {
    super(message);
    this.name = 'LLMTimeoutError';
    this.timeoutMs = timeoutMs;
    this.model = model;
    Object.setPrototypeOf(this, LLMTimeoutError.prototype);
  }
}

export interface GenerateStructuredOptions<T> {
  model: string;
  systemPrompt?: string;
  userPrompt: string;
  schema: ZodType<T>;
  maxRetries?: number;
  client?: Ollama;
  host?: string;
  promptVersion?: string;
  timeoutMs?: number;
}

export type StructuredResult<T> = T & { promptVersion?: string };

export const RETRY_CORRECTION_PROMPT =
  'Your last response did not match the required JSON schema. Return ONLY valid JSON matching it, no other text.';

export async function generateStructured<T>({
  model,
  systemPrompt,
  userPrompt,
  schema,
  maxRetries = 2,
  client,
  host,
  promptVersion,
  timeoutMs
}: GenerateStructuredOptions<T>): Promise<StructuredResult<T>> {
  console.log(`[LLM Gateway] Model: ${model} | Prompt Version: ${promptVersion ?? 'unversioned'}`);
  const ollamaClient =
    client ??
    new Ollama({
      host: host ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
    });

  const jsonSchema = zodToJsonSchema(schema);

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: userPrompt });

  const effectiveTimeout =
    timeoutMs ??
    (process.env.LLM_TIMEOUT_MS ? parseInt(process.env.LLM_TIMEOUT_MS, 10) : 60000);

  let attempts = 0;
  let lastRawResponse = '';
  let lastZodError: ZodError | undefined;

  while (attempts <= maxRetries) {
    attempts++;

    // Execute chat with enforceable timeout
    const chatPromise = ollamaClient.chat({
      model,
      messages,
      format: jsonSchema as any,
      options: {
        temperature: 0
      },
      stream: false
    });

    let timer: any;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new LLMTimeoutError(
            `Ollama inference timed out after ${effectiveTimeout}ms for model '${model}'`,
            effectiveTimeout,
            model
          )
        );
      }, effectiveTimeout);
    });

    let response: any;
    try {
      response = await Promise.race([chatPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }

    const rawContent = response.message?.content ?? '';
    lastRawResponse = rawContent;

    // 1. Attempt to parse JSON
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawContent);
    } catch (parseError) {
      if (attempts <= maxRetries) {
        messages.push({ role: 'assistant', content: rawContent });
        messages.push({ role: 'user', content: RETRY_CORRECTION_PROMPT });
        continue;
      }
      throw new LLMValidationError(
        `Failed to parse LLM response as JSON after ${attempts} attempt(s): ${(parseError as Error).message}`,
        lastRawResponse,
        attempts
      );
    }

    // 2. Validate against Zod schema
    const validationResult = schema.safeParse(parsedJson);
    if (validationResult.success) {
      const data = validationResult.data;
      if (promptVersion && typeof data === 'object' && data !== null) {
        (data as any).promptVersion = promptVersion;
      }
      return data as StructuredResult<T>;
    }

    lastZodError = validationResult.error;
    if (attempts <= maxRetries) {
      messages.push({ role: 'assistant', content: rawContent });
      messages.push({ role: 'user', content: RETRY_CORRECTION_PROMPT });
      continue;
    }
  }

  throw new LLMValidationError(
    `LLM output failed schema validation after ${attempts} attempt(s): ${lastZodError?.message ?? 'Invalid schema'}`,
    lastRawResponse,
    attempts,
    lastZodError
  );
}
