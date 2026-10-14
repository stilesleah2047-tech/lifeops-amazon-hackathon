# Real Amazon Bedrock smoke test (manual)

> STATUS IN THIS DELIVERY: **NOT RUN** — the build sandbox has no AWS
> credentials and no network to Bedrock. The agent code type-checks clean and
> its tool-use loop was exercised with a stubbed Bedrock client, but **no real
> AWS Converse request has succeeded yet.** Run the steps below on your machine
> to confirm the live integration.

## Prerequisites
- Node 20+ (you run Node 24 locally; fine).
- An AWS account with Amazon Bedrock enabled in your region.
- Model access granted for the model you set in `BEDROCK_MODEL_ID`
  (Bedrock console -> Model access -> request access, then wait for "Access granted").
- Credentials with `bedrock:InvokeModel` / `bedrock:Converse` permissions.

## 1. Configure env (apps/web/.env)
```
AWS_REGION=us-east-1
BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0   # verify availability in YOUR region
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
# AWS_SESSION_TOKEN=...        # only if using temporary creds
AGENT_MAX_ITERATIONS=5
AGENT_ALLOW_WRITES=false
```
Never paste these into the frontend or commit them. The agent runs only in the
BFF (`apps/web/server`), so creds stay server-side.

## 2. Start MCP server + BFF
```
# terminal 1
npm run dev -w services/mcp-server
# terminal 2
npm run dev -w apps/web
```

## 3. Confirm mode via health
```
curl http://localhost:5174/api/health
```
Expect `agent.mode` to report `bedrock` (configured) rather than
`deterministic`. If it still says deterministic, the model id / creds / region
are not wired — fix before continuing.

## 4. Fire a real Converse request
```
curl -s -X POST http://localhost:5174/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"What should I focus on right now?","userId":"demo-user"}' | jq
```
A genuine Bedrock answer returns `"mode":"bedrock"` and (when the model chose to
call tools) a populated `result.toolCalls` array naming REAL registered MCP
tools. Write tools (`create_reminder`, `complete_task`) appear under
`proposedActions` unless `AGENT_ALLOW_WRITES=true`.

## 5. Verify fallback is honest
Temporarily set a bogus `BEDROCK_MODEL_ID`, restart the BFF, repeat step 4.
Expect `"mode":"deterministic-fallback"` with a `fallbackReason` — proving the
app degrades safely and never silently claims Bedrock worked.

## What counts as PASS
- Step 3 health shows `bedrock`.
- Step 4 returns `"mode":"bedrock"` from a real AWS response (check AWS
  CloudTrail / Bedrock console for the invocation if you want independent proof).
- No AWS credential value is ever present in any browser payload or log line.
- Any tool/event/reminder IDs in the response originate from the DB
  (`randomUUID`), never invented by the model.
