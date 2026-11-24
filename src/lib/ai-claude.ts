/**
 * Claude (Anthropic) provider for the panel's AI assistant.
 *
 * Used when ANTHROPIC_API_KEY is set. Model: ANTHROPIC_MODEL, default
 * claude-opus-5-5. Chat is a light workload, so effort is "low" (configurable
 * with ANTHROPIC_EFFORT). Server-side refusal fallback is on ("default"
 * routing), so a request declined by a safety classifier is answered by a
 * fallback model inside the same call instead of failing.
 *
 * Returns null when no key is configured; throws on API errors so the caller
 * can fall back to its offline answer.
 */
import Anthropic from '@anthropic-ai/sdk'

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type Effort = (typeof EFFORTS)[number]

let client: Anthropic | null = null

export function isClaudeConfigured(): boolean {
  return Boolean((process.env.ANTHROPIC_API_KEY || '').trim())
}

function getClient(): Anthropic {
  if (!client) client = new Anthropic({ maxRetries: 2, timeout: 60_000 })
  return client
}

/** Drop leading assistant turns and merge nothing: the API needs a user turn first. */
function normalise(turns: ChatTurn[]): ChatTurn[] {
  const out = turns.filter((t) => t.content.trim().length > 0)
  while (out.length && out[0].role !== 'user') out.shift()
  return out
}

export async function claudeReply(system: string, turns: ChatTurn[]): Promise<string | null> {
  if (!isClaudeConfigured()) return null
  const messages = normalise(turns)
  if (messages.length === 0) return null

  const model = (process.env.ANTHROPIC_MODEL || 'claude-opus-5-5').trim()
  const effortEnv = (process.env.ANTHROPIC_EFFORT || 'low').trim() as Effort
  const effort: Effort = EFFORTS.includes(effortEnv) ? effortEnv : 'low'

  const response = await getClient().beta.messages.create({
    model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort },
    system,
    messages,
  })

  if (response.stop_reason === 'refusal') {
    return 'I can’t help with that request. For account questions, please open a ticket under Support.'
  }
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
  if (!text) return null
  if (response.stop_reason === 'max_tokens') {
    return `${text}\n\n(The answer was cut short. Ask me to continue.)`
  }
  return text
}
