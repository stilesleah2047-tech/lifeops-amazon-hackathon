/**
 * Unit tests for the BFF model-driven agent loop.
 *
 * The Bedrock model is FULLY MOCKED here via an injected `converse` function,
 * and MCP tools are mocked via an injected `callTool`. These tests therefore
 * verify the ORCHESTRATION logic (tool selection, schema validation, repeat
 * suppression, write-confirmation gating, bounded iterations, graceful
 * failure) WITHOUT any AWS call. A real end-to-end Bedrock request is a
 * separate, credential-gated smoke test (see tests/bedrock-smoke.md) and is
 * NOT asserted here.
 */
import { describe, expect, it } from 'vitest';
import {
  runAgent,
  validateArgs,
  AgentExhaustedError,
  type AgentToolDef,
  type ConverseRequest,
  type ConverseResponse,
} from '../server/agent.js';
import { readBedrockConfig } from '../server/bedrockClient.js';

const tools: AgentToolDef[] = [
  {
    name: 'get_tasks',
    description: 'read tasks',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
  },
  {
    name: 'complete_task',
    description: 'complete a task',
    inputSchema: {
      type: 'object',
      properties: { userId: { type: 'string' }, taskId: { type: 'string' } },
      required: ['userId', 'taskId'],
    },
  },
];

const toolUse = (id: string, name: string, input: Record<string, unknown>): ConverseResponse => ({
  stopReason: 'tool_use',
  output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: id, name, input } }] } },
});
const final = (text: string): ConverseResponse => ({
  stopReason: 'end_turn',
  output: { message: { role: 'assistant', content: [{ text }] } },
});

describe('validateArgs', () => {
  it('rejects missing required props', () => {
    expect(validateArgs(tools[0]!.inputSchema, {})).toMatch(/Missing required/);
  });
  it('accepts valid args', () => {
    expect(validateArgs(tools[0]!.inputSchema, { userId: 'u' })).toBeNull();
  });
  it('rejects wrong primitive type', () => {
    expect(validateArgs(tools[0]!.inputSchema, { userId: 123 as unknown as string })).toMatch(/should be string/);
  });
});

describe('readBedrockConfig', () => {
  it('is disabled with no model id', () => {
    expect(readBedrockConfig({} as NodeJS.ProcessEnv).enabled).toBe(false);
  });
  it('is enabled when a model id is set', () => {
    const cfg = readBedrockConfig({ BEDROCK_MODEL_ID: 'anthropic.claude-x' } as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(true);
    expect(cfg.allowWrites).toBe(false); // safe default
  });
  it('clamps max iterations into range', () => {
    expect(readBedrockConfig({ BEDROCK_MODEL_ID: 'm', AGENT_MAX_ITERATIONS: '999' } as NodeJS.ProcessEnv).maxIterations).toBe(10);
    expect(readBedrockConfig({ BEDROCK_MODEL_ID: 'm', AGENT_MAX_ITERATIONS: '0' } as NodeJS.ProcessEnv).maxIterations).toBe(1);
  });
});

describe('runAgent: tool selection + real tool invocation', () => {
  it('hands the REAL tool catalogue to the model, calls the chosen tool, feeds the result back, then answers', async () => {
    const calls: string[] = [];
    let sawToolResult = false;
    let step = 0;
    const res = await runAgent('what are my tasks', {
      tools,
      converse: async (req: ConverseRequest) => {
        step++;
        if (step === 1) {
          expect(req.toolConfig.tools.map((t) => t.toolSpec.name)).toEqual(['get_tasks', 'complete_task']);
          return toolUse('u1', 'get_tasks', { userId: 'demo' });
        }
        sawToolResult = req.messages.some((m) => m.content.some((b) => 'toolResult' in b));
        return final('You have 2 tasks.');
      },
      callTool: async (name) => {
        calls.push(name);
        return { tasks: [{ id: 't1' }, { id: 't2' }], count: 2 };
      },
    });
    expect(calls).toEqual(['get_tasks']);
    expect(sawToolResult).toBe(true);
    expect(res.mode).toBe('bedrock');
    expect(res.text).toBe('You have 2 tasks.');
    expect(res.toolCalls).toHaveLength(1);
  });
});

describe('runAgent: guard rails', () => {
  it('never executes an unknown tool and returns an error block to the model', async () => {
    const calls: string[] = [];
    let step = 0;
    await runAgent('do magic', {
      tools,
      converse: async (req) => {
        step++;
        if (step === 1) return toolUse('x', 'nonexistent_tool', {});
        const err = req.messages.at(-1)!.content.some(
          (b) => 'toolResult' in b && b.toolResult.status === 'error',
        );
        expect(err).toBe(true);
        return final('cannot do that');
      },
      callTool: async (name) => {
        calls.push(name);
        return {};
      },
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects invalid arguments and lets the model correct itself', async () => {
    const calls: Array<Record<string, unknown>> = [];
    let step = 0;
    await runAgent('read tasks', {
      tools,
      converse: async (req) => {
        step++;
        if (step === 1) return toolUse('a', 'get_tasks', {}); // missing userId
        if (step === 2) {
          const err = req.messages.at(-1)!.content.some(
            (b) => 'toolResult' in b && b.toolResult.status === 'error',
          );
          expect(err).toBe(true);
          return toolUse('b', 'get_tasks', { userId: 'demo' });
        }
        return final('done');
      },
      callTool: async (_name, args) => {
        calls.push(args);
        return { tasks: [], count: 0 };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.userId).toBe('demo');
  });

  it('suppresses duplicate identical tool calls', async () => {
    const calls: string[] = [];
    let step = 0;
    await runAgent('tasks twice', {
      tools,
      converse: async () => {
        step++;
        if (step <= 2) return toolUse(`id${step}`, 'get_tasks', { userId: 'demo' });
        return final('ok');
      },
      callTool: async (name) => {
        calls.push(name);
        return { tasks: [], count: 0 };
      },
    });
    expect(calls).toHaveLength(1);
  });

  it('does NOT execute a write tool without confirmation, surfacing it as a proposed action', async () => {
    const calls: string[] = [];
    let step = 0;
    const res = await runAgent('mark task t1 done', {
      tools,
      converse: async () => {
        step++;
        if (step === 1) return toolUse('a', 'complete_task', { userId: 'demo', taskId: 't1' });
        return final('Confirm and I will complete it.');
      },
      callTool: async (name) => {
        calls.push(name);
        return {};
      },
    });
    expect(calls).toHaveLength(0);
    expect(res.proposedActions).toHaveLength(1);
    expect(res.proposedActions[0]!.tool).toBe('complete_task');
  });

  it('DOES execute a write tool when allowWrites is enabled', async () => {
    const calls: string[] = [];
    let step = 0;
    await runAgent(
      'mark done',
      {
        tools,
        converse: async () => {
          step++;
          if (step === 1) return toolUse('a', 'complete_task', { userId: 'demo', taskId: 't1' });
          return final('done');
        },
        callTool: async (name) => {
          calls.push(name);
          return { ok: true };
        },
      },
      { allowWrites: true },
    );
    expect(calls).toEqual(['complete_task']);
  });
});

describe('runAgent: failure handling (so the caller can fall back)', () => {
  it('propagates a Bedrock/transport error', async () => {
    await expect(
      runAgent('x', {
        tools,
        converse: async () => {
          throw new Error('bedrock down');
        },
        callTool: async () => ({}),
      }),
    ).rejects.toThrow('bedrock down');
  });

  it('throws AgentExhaustedError when it never converges', async () => {
    await expect(
      runAgent(
        'loop',
        {
          tools,
          converse: async () => toolUse(`${Math.random()}`, 'get_tasks', { userId: `${Math.random()}` }),
          callTool: async () => ({ tasks: [], count: 0 }),
        },
        { maxIterations: 3, maxToolCalls: 99 },
      ),
    ).rejects.toBeInstanceOf(AgentExhaustedError);
  });
});
