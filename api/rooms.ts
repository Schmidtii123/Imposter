import { Redis } from '@upstash/redis'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { questionCards, wordCards, type QuestionCard, type WordCard } from '../src/content'

type GameSettings = { mode: 'word' | 'question'; imposterCount: 1 | 2; hintMode: 'always' | 'starter' | 'never'; contentSource: 'built-in' | 'mixed'; turnTimeSeconds: 0 | 15 | 30 | 45 | 60 }
type Player = { id: string; token: string; name: string; joinedAt: string; lastSeenAt: string }
type Game = { imposters: string[]; starterId: string; card: WordCard | QuestionCard; readyIds: string[]; turnIndex: number; clues: Record<string, string>; answers: Record<string, string>; votes: Record<string, string>; deadline: number | null }
type Room = { code: string; phase: 'lobby' | 'reveal' | 'turns' | 'answering' | 'discussion' | 'vote' | 'result'; createdAt: string; updatedAt: string; hostId: string; players: Player[]; settings: GameSettings; game?: Game }

const ROOM_LIFETIME_SECONDS = 60 * 60 * 12
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const DEFAULT_SETTINGS: GameSettings = { mode: 'word', imposterCount: 1, hintMode: 'always', contentSource: 'built-in', turnTimeSeconds: 30 }

export default async function handler(request: VercelRequest, response: VercelResponse) {
  try {
    if (request.method === 'GET') return getRoom(request, response)
    if (request.method === 'POST') return updateRoom(request, response)
    return json(response, { error: 'Metoden er ikke tilladt.' }, 405, { Allow: 'GET, POST' })
  } catch (error) {
    console.error('Room API error', error)
    return json(response, { error: 'Backend kunne ikke behandle forespørgslen.' }, 500)
  }
}

async function getRoom(request: VercelRequest, response: VercelResponse) {
  const code = normalizeCode(Array.isArray(request.query.code) ? request.query.code[0] : request.query.code)
  if (!code) return json(response, { error: 'Angiv en gyldig rumkode.' }, 400)
  const room = await getRedis().get<Room>(roomKey(code))
  if (!room) return json(response, { error: 'Rummet findes ikke eller er udløbet.' }, 404)
  return json(response, { room: publicRoom(room) })
}

async function updateRoom(request: VercelRequest, response: VercelResponse) {
  const body = readBody(request.body)
  if (!body) return json(response, { error: 'Ugyldig JSON.' }, 400)
  const action = typeof body.action === 'string' ? body.action : ''
  if (action === 'create' || action === 'join') {
    const playerName = normalizePlayerName(body.playerName)
    if (!playerName) return json(response, { error: 'Spillernavnet skal være mellem 1 og 24 tegn.' }, 400)
    return action === 'create' ? createRoom(playerName, response) : joinRoom(body.code, playerName, response)
  }
  if (action === 'leave') return leaveRoom(body, response)
  if (action === 'heartbeat') return heartbeat(body, response)
  if (action === 'settings') return updateSettings(body, response)
  if (action === 'start') return startGame(body, response)
  if (action === 'ready') return markReady(body, response)
  if (action === 'submit') return submitTurn(body, response)
  if (action === 'vote') return castVote(body, response)
  if (action === 'advance') return advanceGame(body, response)
  if (action === 'reset') return resetGame(body, response)
  return json(response, { error: 'Ukendt handling.' }, 400)
}

async function createRoom(playerName: string, response: VercelResponse) {
  const redis = getRedis()
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = createCode()
    if (await redis.exists(roomKey(code))) continue
    const now = new Date().toISOString()
    const host = createPlayer(playerName, now)
    const room: Room = { code, phase: 'lobby', createdAt: now, updatedAt: now, hostId: host.id, players: [host], settings: DEFAULT_SETTINGS }
    const created = await redis.set(roomKey(code), room, { nx: true, ex: ROOM_LIFETIME_SECONDS })
    if (created) return json(response, playerResponse(room, host, true), 201)
  }
  return json(response, { error: 'Kunne ikke oprette en unik rumkode. Prøv igen.' }, 503)
}

async function joinRoom(rawCode: unknown, playerName: string, response: VercelResponse) {
  const code = normalizeCode(rawCode)
  if (!code) return json(response, { error: 'Angiv en gyldig rumkode.' }, 400)
  const result = await mutateRoom<{ room: Room; player: Player }>(code, room => {
    if (room.phase !== 'lobby') return { error: 'Spillet er allerede startet.', status: 409 }
    if (room.players.length >= 20) return { error: 'Rummet er fyldt.', status: 409 }
    if (room.players.some(player => player.name.toLocaleLowerCase('da') === playerName.toLocaleLowerCase('da'))) return { error: 'Navnet er allerede taget i rummet.', status: 409 }
    const now = new Date().toISOString()
    const player = createPlayer(playerName, now)
    room.players.push(player)
    room.updatedAt = now
    return { room, player }
  })
  if ('error' in result) return json(response, { error: result.error }, result.status)
  return json(response, playerResponse(result.room, result.player, false), 201)
}

async function leaveRoom(body: Record<string, unknown>, response: VercelResponse) {
  const identity = readIdentity(body)
  if (!identity) return json(response, { error: 'Ugyldige spilleroplysninger.' }, 400)
  const result = await mutateRoom(identity.code, room => {
    const player = authenticatedPlayer(room, identity)
    if (!player) return { error: 'Spilleren findes ikke i rummet.', status: 403 }
    const currentTurnId = room.phase === 'turns' && room.game ? room.players[room.game.turnIndex]?.id : null
    room.players = room.players.filter(item => item.id !== player.id)
    room.updatedAt = new Date().toISOString()
    if (room.players.length && room.hostId === player.id) room.hostId = room.players[0].id
    if (room.players.length < 6) room.settings.imposterCount = 1
    if (room.game) {
      room.game.imposters = room.game.imposters.filter(id => id !== player.id)
      room.game.readyIds = room.game.readyIds.filter(id => id !== player.id)
      delete room.game.clues[player.id]; delete room.game.answers[player.id]; delete room.game.votes[player.id]
      for (const [voter, target] of Object.entries(room.game.votes)) if (target === player.id) delete room.game.votes[voter]
      if (room.players.length < 3) { room.phase = 'lobby'; delete room.game }
      else if (currentTurnId) {
        const nextIndex = room.players.findIndex(item => item.id === currentTurnId)
        if (nextIndex >= 0) room.game.turnIndex = nextIndex
        else if (room.game.turnIndex >= room.players.length) { room.phase = 'discussion'; room.game.deadline = null }
        else setDeadline(room)
      }
    }
    return { room, deleteRoom: room.players.length === 0 }
  })
  if ('error' in result) return json(response, { error: result.error }, result.status)
  return json(response, { ok: true })
}

async function heartbeat(body: Record<string, unknown>, response: VercelResponse) {
  const identity = readIdentity(body)
  if (!identity) return json(response, { error: 'Ugyldige spilleroplysninger.' }, 400)
  const result = await mutateRoom(identity.code, room => {
    const player = authenticatedPlayer(room, identity)
    if (!player) return { error: 'Spilleren findes ikke i rummet.', status: 403 }
    player.lastSeenAt = new Date().toISOString()
    advanceExpiredTurn(room)
    return { room, player }
  })
  if ('error' in result) return json(response, { error: result.error }, result.status)
  return json(response, { room: publicRoom(result.room), game: playerGame(result.room, identity.playerId), isHost: result.room.hostId === identity.playerId })
}

async function updateSettings(body: Record<string, unknown>, response: VercelResponse) {
  const identity = readIdentity(body)
  const settings = normalizeSettings(body.settings)
  if (!identity || !settings) return json(response, { error: 'Ugyldige indstillinger.' }, 400)
  const result = await mutateRoom(identity.code, room => {
    const player = authenticatedPlayer(room, identity)
    if (!player) return { error: 'Spilleren findes ikke i rummet.', status: 403 }
    if (room.hostId !== player.id) return { error: 'Kun værten kan ændre indstillingerne.', status: 403 }
    if (room.phase !== 'lobby') return { error: 'Indstillingerne kan kun ændres i lobbyen.', status: 409 }
    if (settings.imposterCount === 2 && room.players.length < 6) return { error: 'I skal være mindst 6 spillere for at vælge 2 impostere.', status: 409 }
    room.settings = settings
    room.updatedAt = new Date().toISOString()
    return { room, player }
  })
  if ('error' in result) return json(response, { error: result.error }, result.status)
  return json(response, { room: publicRoom(result.room), isHost: true })
}

async function startGame(body: Record<string, unknown>, response: VercelResponse) {
  return authenticatedMutation(body, response, true, room => {
    if (room.phase !== 'lobby') return { error: 'Spillet er allerede startet.', status: 409 }
    if (room.players.length < 3) return { error: 'I skal være mindst 3 spillere.', status: 409 }
    const order = shuffled(room.players.map(player => player.id))
    const imposters = order.slice(0, Math.min(room.settings.imposterCount, room.players.length < 6 ? 1 : 2))
    const cards = room.settings.mode === 'word' ? wordCards : questionCards
    room.game = { imposters, starterId: order[randomIndex(order.length)], card: cards[randomIndex(cards.length)], readyIds: [], turnIndex: 0, clues: {}, answers: {}, votes: {}, deadline: null }
    room.phase = 'reveal'
    room.updatedAt = new Date().toISOString()
    return room
  })
}

async function markReady(body: Record<string, unknown>, response: VercelResponse) {
  return authenticatedMutation(body, response, false, (room, player) => {
    if (room.phase !== 'reveal' || !room.game) return { error: 'Spillet er ikke i klar-fasen.', status: 409 }
    if (!room.game.readyIds.includes(player.id)) room.game.readyIds.push(player.id)
    if (room.game.readyIds.length === room.players.length) {
      room.phase = room.settings.mode === 'word' ? 'turns' : 'answering'
      room.game.turnIndex = Math.max(0, room.players.findIndex(item => item.id === room.game?.starterId))
      setDeadline(room)
    }
    return room
  })
}

async function submitTurn(body: Record<string, unknown>, response: VercelResponse) {
  const text = typeof body.text === 'string' ? body.text.trim().replace(/\s+/g, ' ') : ''
  if (!text || text.length > 120) return json(response, { error: 'Skriv et svar på højst 120 tegn.' }, 400)
  return authenticatedMutation(body, response, false, (room, player) => {
    if (!room.game) return { error: 'Spillet er ikke startet.', status: 409 }
    if (room.phase === 'turns') {
      const current = room.players[room.game.turnIndex]
      if (current?.id !== player.id) return { error: 'Det er ikke din tur.', status: 409 }
      room.game.clues[player.id] = text.split(' ')[0]
      advanceTurn(room)
    } else if (room.phase === 'answering') {
      room.game.answers[player.id] = text
      if (Object.keys(room.game.answers).length === room.players.length) room.phase = 'discussion'
    } else return { error: 'Der kan ikke svares lige nu.', status: 409 }
    return room
  })
}

async function advanceGame(body: Record<string, unknown>, response: VercelResponse) {
  return authenticatedMutation(body, response, true, room => {
    if (room.phase !== 'discussion') return { error: 'Spillet er ikke i diskussionen.', status: 409 }
    room.phase = 'vote'
    return room
  })
}

async function castVote(body: Record<string, unknown>, response: VercelResponse) {
  const targetId = typeof body.targetId === 'string' ? body.targetId : ''
  return authenticatedMutation(body, response, false, (room, player) => {
    if (room.phase !== 'vote' || !room.game) return { error: 'Afstemningen er ikke åben.', status: 409 }
    if (!room.players.some(item => item.id === targetId) || targetId === player.id) return { error: 'Ugyldigt valg.', status: 400 }
    room.game.votes[player.id] = targetId
    if (Object.keys(room.game.votes).length === room.players.length) room.phase = 'result'
    return room
  })
}

async function resetGame(body: Record<string, unknown>, response: VercelResponse) {
  return authenticatedMutation(body, response, true, room => { room.phase = 'lobby'; delete room.game; return room })
}

async function authenticatedMutation(body: Record<string, unknown>, response: VercelResponse, hostOnly: boolean, mutation: (room: Room, player: Player) => Room | { error: string; status: number }) {
  const identity = readIdentity(body)
  if (!identity) return json(response, { error: 'Ugyldige spilleroplysninger.' }, 400)
  const result = await mutateRoom<{ room: Room; player: Player }>(identity.code, room => {
    const player = authenticatedPlayer(room, identity)
    if (!player) return { error: 'Spilleren findes ikke i rummet.', status: 403 }
    if (hostOnly && room.hostId !== player.id) return { error: 'Kun værten kan gøre dette.', status: 403 }
    const changed = mutation(room, player)
    if ('error' in changed) return changed
    changed.updatedAt = new Date().toISOString()
    return { room: changed, player }
  })
  if ('error' in result) return json(response, { error: result.error }, result.status)
  return json(response, { room: publicRoom(result.room), game: playerGame(result.room, identity.playerId), isHost: result.room.hostId === identity.playerId })
}

function advanceExpiredTurn(room: Room) { if (room.phase === 'turns' && room.game?.deadline && Date.now() >= room.game.deadline) advanceTurn(room) }
function advanceTurn(room: Room) { if (!room.game) return; room.game.turnIndex += 1; if (room.game.turnIndex >= room.players.length) { room.phase = 'discussion'; room.game.deadline = null } else setDeadline(room) }
function setDeadline(room: Room) { if (room.game) room.game.deadline = room.settings.turnTimeSeconds ? Date.now() + room.settings.turnTimeSeconds * 1000 : null }
function shuffled<T>(values: T[]) { const copy = [...values]; for (let index = copy.length - 1; index > 0; index -= 1) { const other = randomIndex(index + 1); [copy[index], copy[other]] = [copy[other], copy[index]] } return copy }
function randomIndex(max: number) { const value = new Uint32Array(1); crypto.getRandomValues(value); return value[0] % max }

async function mutateRoom<T extends { room: Room; deleteRoom?: boolean }>(code: string, mutation: (room: Room) => T | { error: string; status: number }): Promise<T | { error: string; status: number }> {
  const redis = getRedis()
  const lockKey = `lock:${roomKey(code)}`
  const lockToken = crypto.randomUUID()
  let acquired = false
  for (let attempt = 0; attempt < 6; attempt += 1) {
    acquired = Boolean(await redis.set(lockKey, lockToken, { nx: true, px: 3000 }))
    if (acquired) break
    await new Promise(resolve => setTimeout(resolve, 45 * (attempt + 1)))
  }
  if (!acquired) return { error: 'Rummet er optaget. Prøv igen.', status: 409 }
  try {
    const room = await redis.get<Room>(roomKey(code))
    if (!room) return { error: 'Rummet findes ikke eller er udløbet.', status: 404 }
    room.settings ??= DEFAULT_SETTINGS
    const result = mutation(room)
    if ('error' in result) return result
    if (result.deleteRoom) await redis.del(roomKey(code))
    else await redis.set(roomKey(code), room, { ex: ROOM_LIFETIME_SECONDS })
    return result
  } finally {
    await redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end', [lockKey], [lockToken])
  }
}

function playerResponse(room: Room, player: Player, isHost: boolean) { return { room: publicRoom(room), playerId: player.id, playerToken: player.token, isHost } }
function publicRoom(room: Room) { return { code: room.code, phase: room.phase, hostId: room.hostId, settings: room.settings ?? DEFAULT_SETTINGS, createdAt: room.createdAt, updatedAt: room.updatedAt, players: room.players.map(({ id, name }) => ({ id, name })) } }
function playerGame(room: Room, playerId: string) {
  const game = room.game
  if (!game) return null
  const isImposter = game.imposters.includes(playerId)
  const card = game.card
  const secret = room.settings.mode === 'word' ? (!isImposter ? (card as WordCard).word : room.settings.hintMode === 'always' || (room.settings.hintMode === 'starter' && game.starterId === playerId) ? (card as WordCard).hint : null) : null
  const prompt = room.settings.mode === 'question' ? (isImposter ? (card as QuestionCard).alternate : (card as QuestionCard).real) : null
  const revealAll = room.phase === 'result'
  const voteCounts = Object.values(game.votes).reduce<Record<string, number>>((counts, id) => ({ ...counts, [id]: (counts[id] ?? 0) + 1 }), {})
  return {
    isImposter: room.settings.mode === 'word' || revealAll ? isImposter : false,
    secret,
    prompt,
    starterId: game.starterId,
    ready: game.readyIds.includes(playerId),
    readyCount: game.readyIds.length,
    currentPlayerId: room.phase === 'turns' ? room.players[game.turnIndex]?.id ?? null : null,
    deadline: game.deadline,
    clues: game.clues,
    submitted: Boolean(game.clues[playerId] || game.answers[playerId]),
    answers: room.phase === 'discussion' || room.phase === 'vote' || room.phase === 'result' ? game.answers : {},
    voted: Boolean(game.votes[playerId]),
    votesCast: Object.keys(game.votes).length,
    imposters: revealAll ? game.imposters : [],
    card: revealAll ? game.card : null,
    voteCounts: revealAll ? voteCounts : {},
  }
}
function authenticatedPlayer(room: Room, identity: { playerId: string; playerToken: string }) { return room.players.find(player => player.id === identity.playerId && player.token === identity.playerToken) }
function readIdentity(body: Record<string, unknown>) { const code = normalizeCode(body.code); const playerId = typeof body.playerId === 'string' ? body.playerId : ''; const playerToken = typeof body.playerToken === 'string' ? body.playerToken : ''; return code && playerId && playerToken ? { code, playerId, playerToken } : null }

function normalizeSettings(value: unknown): GameSettings | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const settings = value as Partial<GameSettings>
  if (!['word', 'question'].includes(settings.mode ?? '') || (settings.imposterCount !== 1 && settings.imposterCount !== 2) || !['always', 'starter', 'never'].includes(settings.hintMode ?? '') || !['built-in', 'mixed'].includes(settings.contentSource ?? '') || ![0, 15, 30, 45, 60].includes(settings.turnTimeSeconds ?? -1)) return null
  return settings as GameSettings
}

function createPlayer(name: string, now: string): Player { return { id: crypto.randomUUID(), token: crypto.randomUUID(), name, joinedAt: now, lastSeenAt: now } }
function createCode() { const bytes = crypto.getRandomValues(new Uint8Array(4)); return Array.from(bytes, byte => ROOM_CODE_CHARS[byte % ROOM_CODE_CHARS.length]).join('') }
function normalizeCode(value: unknown) { if (typeof value !== 'string') return ''; const code = value.trim().toUpperCase(); return /^[A-Z2-9]{4}$/.test(code) ? code : '' }
function normalizePlayerName(value: unknown) { if (typeof value !== 'string') return ''; const name = value.trim().replace(/\s+/g, ' '); return name.length >= 1 && name.length <= 24 ? name : '' }
function readBody(value: unknown): Record<string, unknown> | null { try { const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value; return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null } catch { return null } }
function roomKey(code: string) { return `room:${code}` }

let redisClient: Redis | null = null
function getRedis() {
  if (redisClient) return redisClient
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('Redis is not configured')
  redisClient = new Redis({ url, token })
  return redisClient
}

function json(response: VercelResponse, data: unknown, status = 200, headers: Record<string, string> = {}) { response.setHeader('Cache-Control', 'no-store'); for (const [name, value] of Object.entries(headers)) response.setHeader(name, value); return response.status(status).json(data) }
