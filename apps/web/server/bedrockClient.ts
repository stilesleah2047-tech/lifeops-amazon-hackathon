/**
 * Amazon Bedrock adapter for the BFF agent loop.
 *
 * Responsibility: own ALL AWS-SDK specifics and expose a single, SDK-agnostic
 * `converse(req)` function that agent.ts can drive. Keeping the SDK isolated
 * here means agent.ts stays pure and unit-testable with a fake model.
 *
 * This is deliberately SEPARATE from services/mcp-server/src/services/bedrock.ts:
 * that module does a narrow summary-rewrite for the planner INSIDE the MCP
 * server; this one runs the multi-turn tool-use orchestration INSIDE the BFF,
 * where the MCP client (and therefore the real tools) lives. They solve
 * different problems, so sharing one abstraction would couple two services.
 *
 * SECURITY: credentials are read from the BFF process environment only and are
 * NEVER sent to the browser or logged. The SPA talks to the BFF over REST; it
 * never sees AWS creds or the model wire protocol.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type { ConverseRequest, ConverseResponse } from './agent.js';

export interface BedrockConfig {
  region: string;
  modelId: string;
  enabled: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  maxIterations: number;
  allowWrites: boolean;
}

export function readBedrockConfig(env: NodeJS.ProcessEnv = process.env): BedrockConfig {
  const modelId = env.BEDROCK_MODEL_ID ?? '';
  return {
    region: env.AWS_REGION ?? 'us-east-1',
    modelId,
    // Bedrock is only “on” when a model id is explicitly configured.
    enabled: Boolean(modelId),
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
    sessionToken: env.AWS_SESSION_TOKEN ?? '',
    maxIterations: clampInt(env.AGENT_MAX_ITERATIONS, 5, 1, 10),
    // Off by default: the agent proposes writes for the user to confirm.
    allowWrites: /^(1|true|yes)$/i.test(env.AGENT_ALLOW_WRITES ?? ''),
  };
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

let cachedClient: BedrockRuntimeClient | null = null;

function getClient(cfg: BedrockConfig): BedrockRuntimeClient {
  if (cachedClient) return cachedClient;
  cachedClient = new BedrockRuntimeClient({
    region: cfg.region,
    // With an IAM role (ECS/EC2/Lambda/AgentCore) the SDK auto-discovers
    // credentials. We only pass explicit creds when BOTH are set (local dev).
    ...(cfg.accessKeyId && cfg.secretAccessKey
      ? {
          credentials: {
            accessKeyId: cfg.accessKeyId,
            secretAccessKey: cfg.secretAccessKey,
            ...(cfg.sessionToken ? { sessionToken: cfg.sessionToken } : {}),
          },
        }
      : {}),
  });
  return cachedClient;
}

/**
 * Build the `converse` function agent.ts needs. The returned function throws on
 * any Bedrock/transport error (so the agent caller falls back to deterministic).
 */
export function createConverse(
  cfg: BedrockConfig,
): (req: ConverseRequest) => Promise<ConverseResponse> {
  const client = getClient(cfg);
  return async (req: ConverseRequest): Promise<ConverseResponse> => {
    const command = new ConverseCommand({
      modelId: cfg.modelId,
      system: req.system,
      // Our minimal message/content types are structurally compatible with the
      // SDK's Converse shapes (text / toolUse / toolResult blocks).
      messages: req.messages as unknown as ConverseCommand['input']['messages'],
      toolConfig: req.toolConfig as unknown as ConverseCommand['input']['toolConfig'],
      inferenceConfig: req.inferenceConfig,
    });
    const response = await Promise.race([
      client.send(command),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('bedrock timeout')), 15_000),
      ),
    ]);
    return {
      stopReason: String(response.stopReason ?? 'end_turn'),
      output: {
        message: (response.output?.message ?? {
          role: 'assistant',
          content: [],
        }) as unknown as ConverseResponse['output']['message'],
      },
    };
  };
}
