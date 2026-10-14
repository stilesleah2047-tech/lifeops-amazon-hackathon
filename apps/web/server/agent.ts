/**
 * Model-driven agent loop for the LifeOps web BFF.
 *
 * This is the OPTIONAL AI layer that sits ON TOP of the deterministic
 * orchestrator in index.ts. When Amazon Bedrock is configured, an incoming
 * natural-language request is handed to this bounded Converse “tool-use” loop:
 *
 *   - The tool catalogue handed to the model is the REAL set of MCP tools,
 *     obtained from `client.listTools()` (see wiring in index.ts). We do NOT
 *     hand-write tool specs — the model sees exactly what the MCP server
 *     advertises, so there is a single source of truth.
 *   - When the model asks to use a tool, we validate the tool name and its
 *     arguments against that advertised JSON schema, then invoke the ACTUAL
 *     MCP tool and feed its real result back to the model. The model never
 *     sees fabricated data and can never invent task/event/reminder IDs —
 *     those only ever come from the MCP server / database.
 *   - The loop is bounded (max iterations + a global tool-call cap + repeat
 *     suppression) so a confused model can't loop forever or hammer a tool.
 *   - Destructive / consequential tools (create_reminder, complete_task) are
 *     NOT executed autonomously unless the caller explicitly allows writes;
 *     otherwise they are returned as `proposedActions` for the user to confirm.
 *   - ANY failure (Bedrock error, exhausted iterations, bad model output)
 *     throws, and the caller falls back to the deterministic orchestrator.
 *     We therefore NEVER pretend Bedrock succeeded when it didn't.
 *
 * This module is deliberately SDK-agnostic: it depends only on an injected
 * `converse` function. That keeps the Bedrock SDK out of this file (so it can
 * be unit-tested with a fake model) and isolates all AWS specifics to
 * bedrockClient.ts.
 */

/** JSON-schema-ish description of a single tool, as advertised by MCP. */
export interface AgentToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** Minimal subset of the Bedrock Converse content blocks we rely on. */
export interface TextBlock {
  text: string;
}
export interface ToolUseBlock {
  toolUse: { toolUseId: string; name: string; input: Record<string, unknown> };
}
export interface ToolResultBlock {
  toolResult: {
    toolUseId: string;
    content: Array<{ json?: unknown; text?: string }>;
    status: 'success' | 'error';
  };
}
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ConverseMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ConverseRequest {
  system: Array<{ text: string }>;
  messages: ConverseMessage[];
  toolConfig: { tools: Array<{ toolSpec: { name: string; description?: string; inputSchema: { json: Record<string, unknown> } } }> };
  inferenceConfig?: { maxTokens?: number; temperature?: number };
}

export interface ConverseResponse {
  stopReason: string; // 'tool_use' | 'end_turn' | 'max_tokens' | ...
  output: { message: ConverseMessage };
}

/** A tool invocation the agent actually performed (for the activity feed). */
export interface AgentToolCall {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  message: string;
}

/** A write the model wanted to do but that needs user confirmation. */
export interface ProposedAction {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface AgentResult {
  mode: 'bedrock';
  text: string;
  toolCalls: AgentToolCall[];
  proposedActions: ProposedAction[];
  iterations: number;
}

export interface AgentDeps {
  /** Send one Converse request to the model. Throws on transport/model error. */
  converse: (req: ConverseRequest) => Promise<ConverseResponse>;
  /** The REAL MCP tool catalogue (from client.listTools()). */
  tools: AgentToolDef[];
  /** Invoke a REAL MCP tool. Resolves with structuredContent, throws on error. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface AgentOptions {
  maxIterations?: number;
  /** Hard cap on total tool invocations across the whole loop. */
  maxToolCalls?: number;
  /** Allow the model to execute write tools without confirmation. Default false. */
  allowWrites?: boolean;
  /** Tool names considered destructive / consequential. */
  writeTools?: string[];
}

/** Thrown when the loop can't finish within its bounds. Caller falls back. */
export class AgentExhaustedError extends Error {}

const DEFAULT_WRITE_TOOLS = ['create_reminder', 'complete_task'];

const SYSTEM_PROMPT = [
  'You are the orchestration brain of LifeOps, an ambient productivity assistant.',
  'You help the user by calling the provided tools and then answering in a calm, concise, second-person voice.',
  'Rules you MUST follow:',
  '1. Only use the tools provided. Do not claim to have done anything you did not do with a tool.',
  '2. NEVER invent task IDs, event IDs, reminder IDs, times, or durations. These come ONLY from tool results.',
  '3. To act on tasks or the schedule, first read them with get_tasks / get_schedule, then use the IDs returned.',
  '4. Prefer the fewest tool calls that answer the request. Do not repeat an identical tool call.',
  '5. If a tool returns an error, read it and either fix your arguments or explain the limitation honestly.',
  '6. When you have enough information, STOP calling tools and give a short final answer.',
].join('\n');

/** Stable stringify (sorted keys) so repeat-call detection is order-insensitive. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Lightweight validation of model-supplied args against the tool's advertised
 * JSON schema. This is intentionally conservative: it rejects clearly invalid
 * calls (missing required props, wrong primitive type, bad enum) so the model
 * is forced to correct itself, without pulling in a full JSON-schema engine.
 * Returns null when valid, or a human-readable error string when invalid.
 */
export function validateArgs(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  if (!schema || typeof schema !== 'object') return null;
  const props = (schema.properties as Record<string, Record<string, unknown>>) ?? {};
  const required = (schema.required as string[]) ?? [];

  for (const key of required) {
    if (args[key] === undefined || args[key] === null) {
      return `Missing required argument "${key}".`;
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = props[key];
    if (!spec) continue; // unknown prop — tolerated (handler/Zod is the final gate)
    const type = spec.type as string | undefined;
    if (type && !matchesType(value, type)) {
      return `Argument "${key}" should be ${type}.`;
    }
    const en = spec.enum as unknown[] | undefined;
    if (en && !en.includes(value)) {
      return `Argument "${key}" must be one of: ${en.join(', ')}.`;
    }
  }
  return null;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    default:
      return true;
  }
}

function toolResultBlock(
  toolUseId: string,
  payload: unknown,
  status: 'success' | 'error',
): ToolResultBlock {
  return {
    toolResult: {
      toolUseId,
      content: [{ json: payload }],
      status,
    },
  };
}

/**
 * Run the bounded model-driven tool-use loop.
 *
 * Throws (so the caller falls back to deterministic orchestration) when:
 *   - `converse` throws (Bedrock error / disabled),
 *   - the loop exceeds `maxIterations` without a final answer.
 */
export async function runAgent(
  userPrompt: string,
  deps: AgentDeps,
  options: AgentOptions = {},
): Promise<AgentResult> {
  const maxIterations = options.maxIterations ?? 5;
  const maxToolCalls = options.maxToolCalls ?? 8;
  const allowWrites = options.allowWrites ?? false;
  const writeTools = new Set(options.writeTools ?? DEFAULT_WRITE_TOOLS);

  const toolByName = new Map(deps.tools.map((t) => [t.name, t]));
  const toolConfig = {
    tools: deps.tools.map((t) => ({
      toolSpec: {
        name: t.name,
        description: t.description,
        inputSchema: { json: t.inputSchema ?? { type: 'object', properties: {} } },
      },
    })),
  };

  const messages: ConverseMessage[] = [
    { role: 'user', content: [{ text: userPrompt }] },
  ];
  const toolCalls: AgentToolCall[] = [];
  const proposedActions: ProposedAction[] = [];
  const seenCalls = new Map<string, number>();
  let totalToolCalls = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const response = await deps.converse({
      system: [{ text: SYSTEM_PROMPT }],
      messages,
      toolConfig,
      inferenceConfig: { maxTokens: 700, temperature: 0.2 },
    });

    const assistantMsg = response.output?.message;
    if (!assistantMsg) throw new AgentExhaustedError('Model returned no message.');
    messages.push(assistantMsg);

    if (response.stopReason !== 'tool_use') {
      const text = assistantMsg.content
        .flatMap((b) => ('text' in b && b.text ? [b.text] : []))
        .join('\n')
        .trim();
      return { mode: 'bedrock', text, toolCalls, proposedActions, iterations: iteration };
    }

    // Collect every tool_use the model requested this turn and answer each.
    const toolUses = assistantMsg.content.filter(
      (b): b is ToolUseBlock => 'toolUse' in b && Boolean(b.toolUse),
    );
    if (toolUses.length === 0) {
      throw new AgentExhaustedError('Model signalled tool_use but requested no tool.');
    }

    const resultBlocks: ToolResultBlock[] = [];
    for (const { toolUse } of toolUses) {
      const { toolUseId, name, input } = toolUse;
      const args = (input ?? {}) as Record<string, unknown>;

      // 1) Unknown tool.
      const def = toolByName.get(name);
      if (!def) {
        resultBlocks.push(
          toolResultBlock(toolUseId, { error: `Unknown tool "${name}".` }, 'error'),
        );
        continue;
      }
      // 2) Global cap.
      if (totalToolCalls >= maxToolCalls) {
        resultBlocks.push(
          toolResultBlock(
            toolUseId,
            { error: 'Tool-call budget exhausted. Answer with what you have.' },
            'error',
          ),
        );
        continue;
      }
      // 3) Argument validation.
      const invalid = validateArgs(def.inputSchema ?? {}, args);
      if (invalid) {
        resultBlocks.push(toolResultBlock(toolUseId, { error: invalid }, 'error'));
        continue;
      }
      // 4) Repeat suppression.
      const key = `${name}:${stableStringify(args)}`;
      if ((seenCalls.get(key) ?? 0) >= 1) {
        resultBlocks.push(
          toolResultBlock(
            toolUseId,
            { error: 'Duplicate tool call suppressed — you already have this result.' },
            'error',
          ),
        );
        continue;
      }
      // 5) Confirmation gate for destructive tools.
      if (writeTools.has(name) && !allowWrites) {
        proposedActions.push({
          tool: name,
          args,
          reason: 'Consequential action — awaiting explicit user confirmation.',
        });
        resultBlocks.push(
          toolResultBlock(
            toolUseId,
            {
              status: 'needs_confirmation',
              note: `"${name}" is a consequential action and was NOT executed. Describe to the user what it would do and ask them to confirm.`,
            },
            'success',
          ),
        );
        continue;
      }

      // 6) Execute the REAL MCP tool.
      seenCalls.set(key, 1);
      totalToolCalls += 1;
      try {
        const data = await deps.callTool(name, args);
        toolCalls.push({ name, args, ok: true, message: `Called ${name}` });
        resultBlocks.push(toolResultBlock(toolUseId, data, 'success'));
      } catch (err) {
        const msg = (err as Error).message || 'tool error';
        toolCalls.push({ name, args, ok: false, message: msg });
        resultBlocks.push(toolResultBlock(toolUseId, { error: msg }, 'error'));
      }
    }

    messages.push({ role: 'user', content: resultBlocks });
  }

  throw new AgentExhaustedError(
    `Agent did not converge within ${maxIterations} iterations.`,
  );
}

