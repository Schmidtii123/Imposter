import type { VercelRequest, VercelResponse } from '@vercel/node'

export default function handler(_request: VercelRequest, response: VercelResponse) {
  return response.status(200).json({
    ok: true,
    service: 'imposter-game-api',
    version: 1,
    storage: hasRedisConfig() ? 'ready' : 'not-configured',
    timestamp: new Date().toISOString(),
  })
}

function hasRedisConfig() {
  return Boolean(
    (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
    (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN),
  )
}
