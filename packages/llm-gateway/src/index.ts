export * from './client.js';
export * from './prompts.js';

export const LLM_GATEWAY_MODULE = 'llm-gateway';

export interface GatewayConfig {
  ollamaBaseUrl: string;
}

export function createGateway(config: GatewayConfig = { ollamaBaseUrl: 'http://localhost:11434' }) {
  return {
    baseUrl: config.ollamaBaseUrl
  };
}
