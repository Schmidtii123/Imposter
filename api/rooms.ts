type Player = { id: string; name: string; joinedAt: string }
type Room = {
  code: string
  phase: 'lobby'
  createdAt: string
  updatedAt: string
  hostId: string
  players: Player[]
}

const ROOM_LIFETIME_SECONDS = 60 * 60 * 12
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export default async function handler(request: Request) {
  try {
    if (request.method === 'GET') return getRoom(request)
    if (request.method === 'POST') return updateRoom(request)
    return json({ error: 'Metoden er ikke tilladt.' }, 405, { Allow: 'GET, POST' })
  } catch (error) {
    console.error('Room API error', error)
    return json({ error: 'Backend kunne ikke behandle forespørgslen.' }, 500)
  }
}

async function getRoom(request: Request) {
  const code = normalizeCode(new URL(request.url).searchParams.get('code'))
  if (!code) return json({ error: 'Angiv en gyldig rumkode.' }, 400)

  const room = await redisGet<Room>(roomKey(code))
  if (!room) return json({ error: 'Rummet findes ikke eller er udløbet.' }, 404)
  return json({ room: publicRoom(room) })
}

async function updateRoom(request: Request) {
  const body = await readBody(request)
  if (!body) return json({ error: 'Ugyldig JSON.' }, 400)

  const action = typeof body.action === 'string' ? body.action : ''
  const playerName = normalizePlayerName(body.playerName)
  if (!playerName) return json({ error: 'Spillernavnet skal være mellem 1 og 24 tegn.' }, 400)

  if (action === 'create') return createRoom(playerName)
  if (action === 'join') return joinRoom(body.code, playerName)
  return json({ error: 'Handlingen skal være create eller join.' }, 400)
}

async function createRoom(playerName: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = createCode()
    if (await redisGet<Room>(roomKey(code))) continue

    const now = new Date().toISOString()
    const host = createPlayer(playerName, now)
    const room: Room = { code, phase: 'lobby', createdAt: now, updatedAt: now, hostId: host.id, players: [host] }
    await redisSet(roomKey(code), room)
    return json({ room: publicRoom(room), playerId: host.id, isHost: true }, 201)
  }

  return json({ error: 'Kunne ikke oprette en unik rumkode. Prøv igen.' }, 503)
}

async function joinRoom(rawCode: unknown, playerName: string) {
  const code = normalizeCode(rawCode)
  if (!code) return json({ error: 'Angiv en gyldig rumkode.' }, 400)

  const room = await redisGet<Room>(roomKey(code))
  if (!room) return json({ error: 'Rummet findes ikke eller er udløbet.' }, 404)
  if (room.phase !== 'lobby') return json({ error: 'Spillet er allerede startet.' }, 409)
  if (room.players.length >= 20) return json({ error: 'Rummet er fyldt.' }, 409)
  if (room.players.some(player => player.name.toLocaleLowerCase('da') === playerName.toLocaleLowerCase('da'))) {
    return json({ error: 'Navnet er allerede taget i rummet.' }, 409)
  }

  const now = new Date().toISOString()
  const player = createPlayer(playerName, now)
  room.players.push(player)
  room.updatedAt = now
  await redisSet(roomKey(code), room)
  return json({ room: publicRoom(room), playerId: player.id, isHost: false }, 201)
}

function publicRoom(room: Room) {
  return {
    code: room.code,
    phase: room.phase,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    players: room.players.map(({ id, name }) => ({ id, name })),
  }
}

function createPlayer(name: string, joinedAt: string): Player {
  return { id: crypto.randomUUID(), name, joinedAt }
}

function createCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  return Array.from(bytes, byte => ROOM_CODE_CHARS[byte % ROOM_CODE_CHARS.length]).join('')
}

function normalizeCode(value: unknown) {
  if (typeof value !== 'string') return ''
  const code = value.trim().toUpperCase()
  return /^[A-Z2-9]{4}$/.test(code) ? code : ''
}

function normalizePlayerName(value: unknown) {
  if (typeof value !== 'string') return ''
  const name = value.trim().replace(/\s+/g, ' ')
  return name.length >= 1 && name.length <= 24 ? name : ''
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json()
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function roomKey(code: string) {
  return `room:${code}`
}

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('Redis is not configured')
  return { url: url.replace(/\/$/, ''), token }
}

async function redisGet<T>(key: string): Promise<T | null> {
  const result = await redisCommand<string | null>(['GET', key])
  return result ? JSON.parse(result) as T : null
}

async function redisSet(key: string, value: unknown) {
  await redisCommand(['SET', key, JSON.stringify(value), 'EX', String(ROOM_LIFETIME_SECONDS)])
}

async function redisCommand<T>(command: string[]): Promise<T> {
  const { url, token } = redisConfig()
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  })
  const payload = await response.json() as { result?: T; error?: string }
  if (!response.ok || payload.error) throw new Error(payload.error || `Redis returned ${response.status}`)
  return payload.result as T
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  })
}
