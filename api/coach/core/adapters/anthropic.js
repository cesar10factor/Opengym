/* Anthropic Messages API. */
import { httpAdapter } from './http.js';
import { SYSTEM_PROMPT } from '../system-prompt.js';

export const ANTHROPIC_VERSION = '2023-06-01';

// Models from Opus 4.5 / Sonnet 4.6 on take `output_config.effort`; Haiku 4.5, Sonnet 4.5 and
// older reject it, and the picker offers every model the account can call.
export const acceptsEffort = model => /^claude-(opus-(4-[5-9]|[5-9])|sonnet-(4-6|[5-9])|fable|mythos)/.test(model || '');

export const anthropicSpec = {
  id: 'anthropic',
  path: () => '/v1/messages',
  modelsPath: '/v1/models',
  headers: key => ({
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
    // Required for a call made from a browser context. Harmless from a server, and the phone's
    // native HTTP path does not need it either — it is here so a plain-browser dev run works.
    'anthropic-dangerous-direct-browser-access': 'true'
  }),
  // The rules block is marked cacheable: identical for every job of a task, so subsequent
  // jobs read it from Anthropic's prompt cache at a tenth of the input price.
  // Opus 5 thinks unless told otherwise, and max_tokens caps thinking and answer together;
  // medium effort keeps a full plan well inside the cap.
  body: ({ model, prompt, system, maxTokens }) => ({
    model,
    max_tokens: maxTokens,
    ...(acceptsEffort(model) ? { output_config: { effort: 'medium' } } : {}),
    system: system
      ? [{ type: 'text', text: SYSTEM_PROMPT + '\n\n' + system, cache_control: { type: 'ephemeral' } }]
      : SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }]
  }),
  errorMessage: data => data && data.error && data.error.message,
  readText: data => {
    if (data.stop_reason === 'refusal') return { error: 'the model declined this request' + (data.stop_details && data.stop_details.explanation ? ': ' + data.stop_details.explanation : '') };
    const text = (data.content || []).filter(b => b && b.type === 'text').map(b => b.text).join('');
    return { text, truncated: data.stop_reason === 'max_tokens' };
  },
  readModels: data => (data.data || []).map(m => m.id)
};

export default httpAdapter(anthropicSpec);
