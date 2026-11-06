import { Agent, request } from 'node:https';
import { BUTTON_SCHEMA, type ButtonProposal } from '../shared/button-agent.ts';
import type { ButtonRunner } from './button-agent-runner.ts';

const agent = new Agent();
const MAX_RESPONSE = 256 * 1024;
let apiKey: string | undefined;
let model: string | undefined;

/**
 * Set the Claude API credential. The CLI passes the environment once at startup; the desktop app
 * passes the Keychain-held key over its private channel. Empty values turn AI design off.
 */
export function configureInference(config: { apiKey?: string | null; model?: string | null }): void {
  apiKey = config.apiKey?.trim() || undefined;
  model = config.model?.trim() || undefined;
}

export function inferenceAvailable(): boolean {
  return Boolean(apiKey && model);
}

export const runInference: ButtonRunner = async (provider, prompt, _workspace, signal) => {
  if (provider !== 'claude') throw new Error('Choose Claude API. CLI agents are unavailable under the local-only policy.');
  if (!apiKey || !model) throw new Error('Add a Claude API key and model before designing a button.');
  const raw = await postMessages(apiKey, {
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: { type: 'json_schema', schema: BUTTON_SCHEMA } },
  }, signal);
  const result = JSON.parse(raw) as { stop_reason?: string; content?: { type?: string; text?: string }[] };
  const text = result.content?.find((part) => part.type === 'text')?.text;
  if (!text || result.stop_reason !== 'end_turn') throw new Error('Claude did not return a complete button proposal.');
  return JSON.parse(text) as ButtonProposal;
};

/** Settings > AI > Test: one tiny request with the configured key and model. */
export async function testInference(): Promise<{ ok: boolean; message: string }> {
  if (!apiKey || !model) return { ok: false, message: 'Add a Claude API key and model first.' };
  try {
    await postMessages(apiKey, { model, max_tokens: 1, messages: [{ role: 'user', content: 'Reply with OK.' }] }, AbortSignal.timeout(30_000));
    return { ok: true, message: `Connected to Claude with ${model}.` };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

async function postMessages(key: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const body = JSON.stringify(payload);
  return new Promise<string>((resolve, reject) => {
    const req = request({
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      agent,
      rejectUnauthorized: true,
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      headers: {
        'anthropic-version': '2023-06-01',
        'x-api-key': key,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      res.on('error', reject);
      if (res.statusCode !== 200) {
        res.destroy();
        const status = res.statusCode ?? 0;
        reject(new Error(status === 401 ? 'Claude rejected the API key.'
          : status === 404 ? 'Claude did not recognize the model name.'
          : `Claude API request failed (HTTP ${status || 'unknown'}).`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE) res.destroy(new Error('Claude response exceeded the size limit.'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.end(body);
  });
}
