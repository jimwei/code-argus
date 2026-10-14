import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Load credentials only in the target process; never print or persist them.
const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const packageRoot = path.resolve(option('--package-root') ?? '.');
const require = createRequire(path.join(packageRoot, 'package.json'));
const envFile = option('--env-file');
const env = envFile ? require('dotenv').parse(readFileSync(envFile)) : process.env;
const { default: OpenAI } = await import(pathToFileURL(require.resolve('openai')).href);
const apiKey = env.ARGUS_OPENAI_API_KEY || env.OPENAI_API_KEY;
const baseURL = (
  env.ARGUS_OPENAI_BASE_URL ||
  env.OPENAI_BASE_URL ||
  'https://api.openai.com/v1'
).replace(/\/+$/, '');
if (!apiKey) throw new Error('No configured OpenAI API key');
const client = new OpenAI({ apiKey, baseURL, timeout: 90_000, maxRetries: 0 });
if (args.includes('--list-models')) {
  const models = await client.models.list();
  console.log(
    JSON.stringify({
      endpoint: new URL(baseURL).host,
      models: models.data.map((model) => model.id),
    })
  );
  process.exit(0);
}
const modelIds = option('--models')?.split(',') ?? [env.ARGUS_OPENAI_MODEL || env.ARGUS_MODEL];
const supportsMaxTokens = !['false', '0', 'no', 'off'].includes(
  (env.ARGUS_OPENAI_SUPPORTS_MAX_OUTPUT_TOKENS ?? '').toLowerCase()
);
const instructions =
  'Call lookup_review_fixture exactly once, then report its value in one sentence.';
const input = [{ role: 'user', content: 'Look up fixture review-1 and report its status.' }];
const tools = [
  {
    type: 'function',
    name: 'lookup_review_fixture',
    description: 'Returns the status of a synthetic review fixture.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];
const safeError = (error) =>
  String(error?.message ?? error)
    .split(apiKey)
    .join('[REDACTED]');
const summarize = (response) => ({
  status: response.status,
  incompleteReason: response.incomplete_details?.reason,
  error: response.error?.message ? safeError(response.error) : undefined,
  outputTextChars: (response.output_text ?? '').length,
  items: response.output?.map((item) => ({
    type: item.type,
    id: item.id,
    callId: item.call_id,
    encryptedChars: item.encrypted_content?.length,
  })),
  usage: response.usage,
});
async function request(params) {
  const start = Date.now();
  try {
    let response;
    const stream = await client.responses.create({ ...params, stream: true });
    for await (const event of stream) {
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
        response = event.response;
      } else if (event.type === 'error') {
        throw new Error(event.message || 'Response stream error');
      }
    }
    if (!response) throw new Error('Stream ended without a final response');
    return {
      response,
      evidence: {
        ok: response.status === 'completed',
        ms: Date.now() - start,
        ...summarize(response),
      },
    };
  } catch (error) {
    return {
      evidence: {
        ok: false,
        ms: Date.now() - start,
        httpStatus: error.status,
        error: safeError(error),
      },
    };
  }
}

console.log(
  JSON.stringify({
    event: 'probe-config',
    endpoint: new URL(baseURL).host,
    models: modelIds,
    reasoningEffort: 'high',
    store: false,
    supportsMaxTokens,
  })
);
for (const model of modelIds) {
  if (!model) continue;
  for (const firstMode of ['keep', 'drop']) {
    const common = {
      model,
      instructions,
      store: false,
      tools,
      ...(supportsMaxTokens ? { max_output_tokens: 4096 } : {}),
    };
    const first = await request({
      ...common,
      input,
      reasoning: { effort: 'high', ...(firstMode === 'keep' ? { summary: 'auto' } : {}) },
      ...(firstMode === 'keep' ? { include: ['reasoning.encrypted_content'] } : {}),
      tool_choice: 'auto',
    });
    console.log(JSON.stringify({ model, firstMode, phase: 'first', ...first.evidence }));
    const output = first.response?.output;
    const calls = output?.filter((item) => item.type === 'function_call');
    if (!first.evidence.ok || !calls?.length) continue;
    const toolResults = calls.map((call) => ({
      type: 'function_call_output',
      call_id: call.call_id,
      output: JSON.stringify({ id: 'review-1', status: 'confirmed', fixture: true }),
    }));
    for (const replay of firstMode === 'keep'
      ? ['keep', 'drop', 'drop-without-item-id']
      : ['drop', 'drop-without-item-id']) {
      const history =
        replay === 'keep' ? output : output.filter((item) => item.type !== 'reasoning');
      const replayed = history.map((item) => {
        if (replay !== 'drop-without-item-id' || item.type !== 'function_call') return item;
        const { id: _itemId, ...withoutId } = item;
        return withoutId;
      });
      const result = await request({
        ...common,
        input: [...input, ...replayed, ...toolResults],
        tool_choice: 'auto',
        reasoning: { effort: 'high', ...(replay === 'keep' ? { summary: 'auto' } : {}) },
        ...(replay === 'keep' ? { include: ['reasoning.encrypted_content'] } : {}),
      });
      console.log(
        JSON.stringify({
          model,
          firstMode,
          phase: 'follow-up',
          replay,
          reasoningItems: replayed.filter((item) => item.type === 'reasoning').length,
          toolItemIds: replayed
            .filter((item) => item.type === 'function_call')
            .map((item) => item.id ?? null),
          ...result.evidence,
        })
      );
    }
  }
}
