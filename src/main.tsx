import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { questionCards, wordCards, type QuestionCard, type WordCard } from './content'
import { loadQuestionCards, loadWordCards, nextCard, saveQuestionCards, saveWordCards } from './cards'
import './style.css'

// Shared client-side models for the local and online game flows.
type Mode = 'word' | 'question'
type Phase = 'setup' | 'handoff' | 'private' | 'discuss' | 'vote' | 'result'
type ContentSource = 'built-in' | 'mixed' | 'custom'
type HintMode = 'always' | 'starter' | 'never'
type PlayLocation = 'choose' | 'local' | 'online'
type OnlineView = 'menu' | 'create' | 'join' | 'lobby'
type OnlineSettings = { mode: Mode; imposterCount: 1 | 2; hintMode: HintMode; contentSource: 'built-in' | 'mixed'; turnTimeSeconds: 0 | 15 | 30 | 45 | 60 }
type OnlineRoom = {
  code: string
  phase: 'lobby' | 'reveal' | 'turns' | 'answering' | 'discussion' | 'vote' | 'result'
  hostId: string
  settings: OnlineSettings
  players: { id: string; name: string }[]
}
type OnlineGame = { isImposter: boolean; secret: string | null; prompt: string | null; starterId: string; ready: boolean; readyCount: number; currentPlayerId: string | null; deadline: number | null; clues: Record<string, string>; submitted: boolean; answers: Record<string, string>; voted: boolean; votesCast: number; imposters: string[]; card: WordCard | QuestionCard | null; voteCounts: Record<string, number> }
type RoomResponse = { room?: OnlineRoom; game?: OnlineGame; playerId?: string; playerToken?: string; isHost?: boolean; error?: string }
type Round = {
  mode: Mode
  players: string[]
  imposters: number[]
  starter: number
  card: WordCard | QuestionCard
  hintMode: HintMode
  answers: string[]
}

// Cryptographically random helpers used for local role assignment.
function randomInt(max: number) {
  if (window.crypto?.getRandomValues) {
    const value = new Uint32Array(1)
    window.crypto.getRandomValues(value)
    return value[0] % max
  }
  return Math.floor(Math.random() * max)
}

function randomIndexes(total: number, count: number) {
  const available = Array.from({ length: total }, (_, index) => index)
  const picked: number[] = []
  for (let i = 0; i < count; i++) {
    picked.push(available.splice(randomInt(available.length), 1)[0])
  }
  return picked
}

function App() {
  // Navigation and online lobby session.
  const [playLocation, setPlayLocation] = useState<PlayLocation>('choose')
  const [onlineView, setOnlineView] = useState<OnlineView>('menu')
  const [onlineName, setOnlineName] = useState('')
  const [onlineCode, setOnlineCode] = useState('')
  const [onlineRoom, setOnlineRoom] = useState<OnlineRoom | null>(null)
  const [onlinePlayerId, setOnlinePlayerId] = useState('')
  const [onlinePlayerToken, setOnlinePlayerToken] = useState('')
  const [onlineGame, setOnlineGame] = useState<OnlineGame | null>(null)
  const [onlineText, setOnlineText] = useState('')
  const [onlineVote, setOnlineVote] = useState('')
  const [clock, setClock] = useState(Date.now())
  const [onlineIsHost, setOnlineIsHost] = useState(false)
  const [onlineBusy, setOnlineBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  // Local-game setup and round state.
  const [mode, setMode] = useState<Mode>('word')
  const [phase, setPhase] = useState<Phase>('setup')
  const [players, setPlayers] = useState<string[]>([])
  const [name, setName] = useState('')
  const [imposterCount, setImposterCount] = useState(2)
  const [hintMode, setHintMode] = useState<HintMode>('always')
  const [source, setSource] = useState<ContentSource>('built-in')
  const [customWord, setCustomWord] = useState('')
  const [customHint, setCustomHint] = useState('')
  const [customReal, setCustomReal] = useState('')
  const [customAlternate, setCustomAlternate] = useState('')
  const [ownWords, setOwnWords] = useState(loadWordCards)
  const [ownQuestions, setOwnQuestions] = useState(loadQuestionCards)
  const [round, setRound] = useState<Round | null>(null)
  const [turn, setTurn] = useState(0)
  const [answer, setAnswer] = useState('')
  const [selected, setSelected] = useState<number[]>([])
  const [error, setError] = useState('')

  const effectiveCount = players.length < 6 ? 1 : imposterCount
  const activePlayer = round?.players[turn]
  const isImposter = round?.imposters.includes(turn)
  const receivesHint = round?.hintMode === 'always' || (round?.hintMode === 'starter' && round.starter === turn)
  const starterReceivesHint = round?.hintMode === 'always' || (round?.hintMode === 'starter' && round.imposters.includes(round.starter))
  const wordCard = round?.mode === 'word' ? round.card as WordCard : null
  const questionCard = round?.mode === 'question' ? round.card as QuestionCard : null
  const allFound = round !== null && selected.length === round.imposters.length && selected.every(index => round.imposters.includes(index))

  // Keep each online client synchronized and authenticated with the room.
  const onlineRoomCode = onlineRoom?.code
  useEffect(() => {
    if (!onlineRoomCode) return
    const refreshRoom = async () => {
      try {
        const response = onlinePlayerId && onlinePlayerToken
          ? await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'heartbeat', code: onlineRoomCode, playerId: onlinePlayerId, playerToken: onlinePlayerToken }) })
          : await fetch(`/api/rooms?code=${onlineRoomCode}`, { cache: 'no-store' })
        const data = await response.json() as RoomResponse
        if (response.ok && data.room) {
          setOnlineRoom(data.room)
          setOnlineGame(data.game ?? null)
          setOnlineIsHost(data.room.hostId === onlinePlayerId)
        }
      } catch {
        // A kortvarig netværksfejl skal ikke smide spilleren ud af lobbyen.
      }
    }
    const timer = window.setInterval(refreshRoom, 3000)
    return () => window.clearInterval(timer)
  }, [onlineRoomCode, onlinePlayerId, onlinePlayerToken])

  useEffect(() => {
    if (!onlineGame?.deadline) return
    const timer = window.setInterval(() => setClock(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [onlineGame?.deadline])

  useEffect(() => {
    if (!onlineRoomCode || !onlinePlayerId || !onlinePlayerToken) return
    const leaveOnClose = () => navigator.sendBeacon('/api/rooms', JSON.stringify({ action: 'leave', code: onlineRoomCode, playerId: onlinePlayerId, playerToken: onlinePlayerToken }))
    window.addEventListener('beforeunload', leaveOnClose)
    return () => window.removeEventListener('beforeunload', leaveOnClose)
  }, [onlineRoomCode, onlinePlayerId, onlinePlayerToken])

  // Online lobby commands.
  async function submitOnline(action: 'create' | 'join') {
    const playerName = onlineName.trim().replace(/\s+/g, ' ')
    const code = onlineCode.trim().toUpperCase()
    if (!playerName) return setError('Skriv dit navn først.')
    if (action === 'join' && !/^[A-Z2-9]{4}$/.test(code)) return setError('Rumkoden skal være på fire tegn.')

    setOnlineBusy(true)
    setError('')
    try {
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, playerName, ...(action === 'join' ? { code } : {}) }),
      })
      const data = await response.json() as RoomResponse
      if (!response.ok || !data.room || !data.playerId || !data.playerToken) throw new Error(data.error || 'Kunne ikke forbinde til rummet.')
      setOnlineRoom(data.room)
      setOnlinePlayerId(data.playerId)
      setOnlinePlayerToken(data.playerToken)
      setOnlineIsHost(Boolean(data.isHost))
      setOnlineView('lobby')
    } catch (onlineError) {
      setError(onlineError instanceof Error ? onlineError.message : 'Kunne ikke forbinde til rummet.')
    } finally {
      setOnlineBusy(false)
    }
  }

  function clearOnline() {
    setOnlineRoom(null)
    setOnlinePlayerId('')
    setOnlinePlayerToken('')
    setOnlineGame(null)
    setOnlineText('')
    setOnlineVote('')
    setOnlineIsHost(false)
    setOnlineView('menu')
    setError('')
  }

  async function leaveOnline() {
    if (onlineRoom && onlinePlayerId && onlinePlayerToken) {
      try {
        await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'leave', code: onlineRoom.code, playerId: onlinePlayerId, playerToken: onlinePlayerToken }), keepalive: true })
      } catch {
        // Lobbyen forsvinder lokalt, selv hvis netværket afbrydes under udmeldingen.
      }
    }
    clearOnline()
  }

  async function updateOnlineSettings(changes: Partial<OnlineSettings>) {
    if (!onlineRoom || !onlineIsHost || !onlinePlayerToken) return
    const settings = { ...onlineRoom.settings, ...changes }
    setOnlineRoom({ ...onlineRoom, settings })
    setError('')
    try {
      const response = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'settings', code: onlineRoom.code, playerId: onlinePlayerId, playerToken: onlinePlayerToken, settings }) })
      const data = await response.json() as RoomResponse
      if (!response.ok || !data.room) throw new Error(data.error || 'Indstillingerne kunne ikke gemmes.')
      setOnlineRoom(data.room)
    } catch (settingsError) {
      setError(settingsError instanceof Error ? settingsError.message : 'Indstillingerne kunne ikke gemmes.')
    }
  }

  async function onlineAction(action: 'start' | 'ready' | 'submit' | 'advance' | 'vote' | 'reset', extras: Record<string, unknown> = {}) {
    if (!onlineRoom || !onlinePlayerToken) return
    setOnlineBusy(true); setError('')
    try {
      const response = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, code: onlineRoom.code, playerId: onlinePlayerId, playerToken: onlinePlayerToken, ...extras }) })
      const data = await response.json() as RoomResponse
      if (!response.ok || !data.room) throw new Error(data.error || 'Handlingen kunne ikke gennemføres.')
      setOnlineRoom(data.room); setOnlineGame(data.game ?? null); setOnlineIsHost(Boolean(data.isHost)); setOnlineText('')
    } catch (actionError) { setError(actionError instanceof Error ? actionError.message : 'Handlingen kunne ikke gennemføres.') }
    finally { setOnlineBusy(false) }
  }

  function goHome() {
    if (phase !== 'setup') reset(false)
    void leaveOnline()
    setPlayLocation('choose')
  }

  async function copyRoomCode() {
    if (!onlineRoom) return
    await navigator.clipboard.writeText(onlineRoom.code)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  // Local-game commands.
  function addPlayer() {
    const trimmed = name.trim().replace(/\s+/g, ' ')
    if (!trimmed) return setError('Skriv et navn først.')
    if (players.length >= 12) return setError('Der kan højst være 12 spillere.')
    if (players.some(player => player.toLocaleLowerCase('da') === trimmed.toLocaleLowerCase('da'))) return setError('Navnet er allerede på listen.')
    setPlayers([...players, trimmed])
    setName('')
    setError('')
  }

  function startRound() {
    if (players.length < 3) return setError('Tilføj mindst 3 spillere.')
    if (source === 'custom') {
      if (mode === 'word' && (!customWord.trim() || (hintMode !== 'never' && !customHint.trim()))) return setError(hintMode === 'never' ? 'Skriv et ord til den brugerdefinerede runde.' : 'Skriv et ord og et hint til den brugerdefinerede runde.')
      if (mode === 'question' && (!customReal.trim() || !customAlternate.trim())) return setError('Skriv begge spørgsmål til den brugerdefinerede runde.')
      if (mode === 'question' && customReal.trim().toLocaleLowerCase('da') === customAlternate.trim().toLocaleLowerCase('da')) return setError('De to spørgsmål skal være forskellige.')
    }
    const card = mode === 'word'
      ? source === 'custom' ? { word: customWord.trim(), hint: customHint.trim() } : nextCard('word', wordCards, ownWords, source === 'mixed')
      : source === 'custom' ? { real: customReal.trim(), alternate: customAlternate.trim() } : nextCard('question', questionCards, ownQuestions, source === 'mixed')
    setRound({ mode, players: [...players], imposters: randomIndexes(players.length, effectiveCount), starter: randomInt(players.length), card, hintMode, answers: Array(players.length).fill('') })
    setTurn(0)
    setAnswer('')
    setSelected([])
    setError('')
    setPhase('handoff')
  }

  function finishPrivateTurn() {
    if (!round) return
    if (round.mode === 'question') {
      if (!answer.trim()) return setError('Skriv et svar, før du sender telefonen videre.')
      setRound({ ...round, answers: round.answers.map((value, index) => index === turn ? answer.trim() : value) })
    }
    setAnswer('')
    setError('')
    if (turn + 1 < round.players.length) {
      setTurn(turn + 1)
      setPhase('handoff')
    } else {
      setPhase('discuss')
    }
  }

  function reset(keepPlayers = true) {
    setRound(null)
    setTurn(0)
    setAnswer('')
    setSelected([])
    setError('')
    setSource(source === 'custom' ? 'built-in' : source)
    setCustomWord('')
    setCustomHint('')
    setCustomReal('')
    setCustomAlternate('')
    if (!keepPlayers) setPlayers([])
    setPhase('setup')
  }

  function toggleVote(index: number) {
    if (!round) return
    setSelected(current => current.includes(index) ? current.filter(value => value !== index) : current.length < round.imposters.length ? [...current, index] : [...current.slice(1), index])
  }

  function addOwnCard() {
    if (mode === 'word') {
      const word = customWord.trim()
      const hint = customHint.trim()
      if (!word || !hint) return setError('Skriv både ord og hint for at gemme kortet. Hintet bruges, hvis hint er slået til i runden.')
      if ([...wordCards, ...ownWords].some(card => card.word.toLocaleLowerCase('da') === word.toLocaleLowerCase('da'))) return setError('Ordet findes allerede i kortbunken.')
      const updated = [...ownWords, { id: crypto.randomUUID(), word, hint }]
      if (!saveWordCards(updated)) return setError('Kortet kunne ikke gemmes på denne enhed. Kontrollér browserens lagerindstillinger.')
      setOwnWords(updated)
      setCustomWord('')
      setCustomHint('')
    } else {
      const real = customReal.trim()
      const alternate = customAlternate.trim()
      if (!real || !alternate) return setError('Skriv begge spørgsmål for at gemme kortet.')
      if (real.toLocaleLowerCase('da') === alternate.toLocaleLowerCase('da')) return setError('De to spørgsmål skal være forskellige.')
      if ([...questionCards, ...ownQuestions].some(card => card.real.toLocaleLowerCase('da') === real.toLocaleLowerCase('da'))) return setError('Spørgsmålet findes allerede i kortbunken.')
      const updated = [...ownQuestions, { id: crypto.randomUUID(), real, alternate }]
      if (!saveQuestionCards(updated)) return setError('Kortet kunne ikke gemmes på denne enhed. Kontrollér browserens lagerindstillinger.')
      setOwnQuestions(updated)
      setCustomReal('')
      setCustomAlternate('')
    }
    setError('')
  }

  function removeOwnCard(id: string) {
    if (mode === 'word') {
      const updated = ownWords.filter(card => card.id !== id)
      if (!saveWordCards(updated)) return setError('Kortet kunne ikke fjernes fra denne enhed.')
      setOwnWords(updated)
    } else {
      const updated = ownQuestions.filter(card => card.id !== id)
      if (!saveQuestionCards(updated)) return setError('Kortet kunne ikke fjernes fra denne enhed.')
      setOwnQuestions(updated)
    }
    setError('')
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">?</span><span>HVEM ER <strong>IMPOSTER</strong></span></div>
      {playLocation !== 'choose' && <button className="text-button" onClick={() => { if (phase === 'setup' || window.confirm('Afslut denne runde og gå tilbage?')) goHome() }}>{phase === 'setup' ? 'Tilbage' : 'Afslut runde'}</button>}
    </header>

    <main>
      {playLocation === 'choose' && <section className="entry-screen">
        <section className="hero entry-hero">
          <div className="eyebrow"><span className="live-dot" /> VÆLG HVORDAN I SPILLER</div>
          <h1>Samme bluff.<br /><em>Jeres måde.</em></h1>
          <p>Spil sammen på én telefon, eller opret et online-rum, hvor alle deltager fra deres egen enhed.</p>
        </section>
        <div className="location-grid">
          <button className="location-card" onClick={() => setPlayLocation('local')}>
            <span className="location-icon coral">▣</span>
            <span className="location-copy"><strong>Spil lokalt</strong><small>Send én telefon rundt mellem alle spillere.</small></span>
            <span className="mode-arrow">→</span>
          </button>
          <button className="location-card featured" onClick={() => setPlayLocation('online')}>
            <span className="location-icon purple">◎</span>
            <span className="location-copy"><strong>Spil online</strong><small>Opret eller deltag i et rum fra hver jeres telefon.</small></span>
            <span className="online-pill">NY</span><span className="mode-arrow">→</span>
          </button>
        </div>
      </section>}

      {playLocation === 'online' && <section className="online-screen">
        {onlineView !== 'lobby' && <>
          <section className="hero online-hero">
            <div className="eyebrow"><span className="live-dot" /> ONLINE MULTIPLAYER</div>
            <h1>Spil fra <em>hver jeres skærm.</em></h1>
            <p>En spiller opretter rummet. Resten deltager med den korte rumkode.</p>
          </section>
          {onlineView === 'menu' && <div className="location-grid compact">
            <button className="location-card" onClick={() => { setOnlineView('create'); setError('') }}><span className="location-icon coral">＋</span><span className="location-copy"><strong>Opret et rum</strong><small>Du bliver vært og inviterer de andre.</small></span><span className="mode-arrow">→</span></button>
            <button className="location-card" onClick={() => { setOnlineView('join'); setError('') }}><span className="location-icon purple">↗</span><span className="location-copy"><strong>Deltag i et rum</strong><small>Brug koden, som værten viser dig.</small></span><span className="mode-arrow">→</span></button>
          </div>}
          {(onlineView === 'create' || onlineView === 'join') && <section className="panel online-form-panel">
            <div className="section-heading"><span className="step">{onlineView === 'create' ? '＋' : '↗'}</span><div><h2>{onlineView === 'create' ? 'Opret et rum' : 'Deltag i et rum'}</h2><p>{onlineView === 'create' ? 'Vælg det navn, de andre spillere kan se.' : 'Skriv dit navn og den firetegnskode, du har fået.'}</p></div></div>
            <form className="online-form" onSubmit={event => { event.preventDefault(); void submitOnline(onlineView) }}>
              <label>Dit navn<input value={onlineName} onChange={event => setOnlineName(event.target.value)} placeholder="F.eks. Emil" maxLength={24} autoComplete="nickname" /></label>
              {onlineView === 'join' && <label>Rumkode<input className="room-code-input" value={onlineCode} onChange={event => setOnlineCode(event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 4))} placeholder="AB12" maxLength={4} autoCapitalize="characters" /></label>}
              {error && <p className="error" role="alert">{error}</p>}
              <button className="primary" disabled={onlineBusy}>{onlineBusy ? 'Forbinder…' : onlineView === 'create' ? 'Opret rum' : 'Deltag'} <span>→</span></button>
              <button className="secondary" type="button" onClick={() => { setOnlineView('menu'); setError('') }}>Tilbage</button>
            </form>
          </section>}
        </>}
        {onlineView === 'lobby' && onlineRoom?.phase === 'lobby' && <section className="game-screen online-lobby">
          <div className="eyebrow"><span className="live-dot" /> ONLINE LOBBY</div>
          <h1>Rummet er <em>klar.</em></h1>
          <p>Del koden med de andre spillere. Listen opdateres automatisk.</p>
          <button className="room-code-card" onClick={() => void copyRoomCode()} aria-label="Kopiér rumkode"><small>RUMKODE</small><strong>{onlineRoom.code}</strong><span>{copied ? 'Kopieret!' : 'Tryk for at kopiere'}</span></button>
          <div className="lobby-layout">
          <div className="lobby-panel">
            <div className="lobby-heading"><div><strong>Spillere</strong><small>{onlineRoom.players.length} / 20 i lobbyen</small></div><span className="connection-state"><i /> LIVE</span></div>
            <div className="lobby-players">{onlineRoom.players.map(player => <div className="lobby-player" key={player.id}><span className="avatar">{player.name.charAt(0).toLocaleUpperCase('da')}</span><strong>{player.name}</strong>{player.id === onlineRoom.hostId && <small className="host-pill">VÆRT</small>}{player.id === onlinePlayerId && <small>DIG</small>}</div>)}</div>
          </div>
          <div className="lobby-panel lobby-settings">
            <div className="lobby-heading"><div><strong>Indstillinger</strong><small>{onlineIsHost ? 'Du kan ændre dem frem til spilstart.' : 'Kun værten kan ændre dem.'}</small></div></div>
            <div className="setting-row"><div><strong>Spil</strong><small>Vælg typen af imposter-runde.</small></div><div className="segmented"><button className={onlineRoom.settings.mode === 'word' ? 'selected' : ''} disabled={!onlineIsHost} onClick={() => void updateOnlineSettings({ mode: 'word' })}>Hemmelig ord</button><button className={onlineRoom.settings.mode === 'question' ? 'selected' : ''} disabled={!onlineIsHost} onClick={() => void updateOnlineSettings({ mode: 'question' })}>Forkert spørgsmål</button></div></div>
            <div className="setting-row"><div><strong>Antal impostere</strong><small>To kræver mindst 6 spillere.</small></div><div className="segmented"><button className={onlineRoom.settings.imposterCount === 1 ? 'selected' : ''} disabled={!onlineIsHost} onClick={() => void updateOnlineSettings({ imposterCount: 1 })}>1</button><button className={onlineRoom.settings.imposterCount === 2 ? 'selected' : ''} disabled={!onlineIsHost || onlineRoom.players.length < 6} onClick={() => void updateOnlineSettings({ imposterCount: 2 })}>2</button></div></div>
            {onlineRoom.settings.mode === 'word' && <div className="setting-row"><div><strong>Hvad ser imposteren?</strong><small>Vælg hvor meget hjælp imposteren får.</small></div><div className="segmented hint-options"><button className={onlineRoom.settings.hintMode === 'always' ? 'selected' : ''} disabled={!onlineIsHost} onClick={() => void updateOnlineSettings({ hintMode: 'always' })}>Hint</button><button className={onlineRoom.settings.hintMode === 'starter' ? 'selected' : ''} disabled={!onlineIsHost} onClick={() => void updateOnlineSettings({ hintMode: 'starter' })}>Kun hvis starter</button><button className={onlineRoom.settings.hintMode === 'never' ? 'selected' : ''} disabled={!onlineIsHost} onClick={() => void updateOnlineSettings({ hintMode: 'never' })}>Intet</button></div></div>}
            {onlineRoom.settings.mode === 'word' && <div className="setting-row"><div><strong>Tid til hint</strong><small>Hvor længe hver spiller må skrive.</small></div><div className="segmented timer-options">{([0, 15, 30, 45, 60] as const).map(seconds => <button key={seconds} className={onlineRoom.settings.turnTimeSeconds === seconds ? 'selected' : ''} disabled={!onlineIsHost} onClick={() => void updateOnlineSettings({ turnTimeSeconds: seconds })}>{seconds === 0 ? 'Ingen' : `${seconds}s`}</button>)}</div></div>}
            <div className="setting-row"><div><strong>Indhold</strong><small>Egne online-kort kommer i næste trin.</small></div><div className="segmented"><button className="selected" disabled>Indbyggede kort</button></div></div>
          </div>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          {onlineIsHost ? <><button className="primary" disabled={onlineRoom.players.length < 3 || onlineBusy} onClick={() => void onlineAction('start')}>Start spillet <span>→</span></button>{onlineRoom.players.length < 3 && <p className="selection-count">I skal være mindst 3 spillere.</p>}</> : <p className="waiting-note"><span /> Venter på at værten starter spillet…</p>}
          <button className="secondary" onClick={() => void leaveOnline()}>Forlad rummet</button>
        </section>}
        {onlineView === 'lobby' && onlineRoom && onlineRoom.phase !== 'lobby' && onlineGame && <OnlineGameScreen room={onlineRoom} game={onlineGame} playerId={onlinePlayerId} isHost={onlineIsHost} text={onlineText} setText={setOnlineText} vote={onlineVote} setVote={setOnlineVote} clock={clock} busy={onlineBusy} error={error} action={onlineAction} leave={() => void leaveOnline()} />}
      </section>}

      {playLocation === 'local' && phase === 'setup' && <>
        <section className="hero">
          <div className="eyebrow"><span className="live-dot" /> SPIL SAMMEN · ÉN TELEFON</div>
          <h1>Kan du finde<br /><em>imposteren?</em></h1>
          <p>To spil. Én hemmelighed. Send telefonen rundt, læs dit kort, og find ud af hvem der prøver at passe ind.</p>
        </section>

        <section className="panel">
          <div className="section-heading"><span className="step">01</span><div><h2>Vælg spil</h2><p>Hvilken slags imposter spiller I?</p></div></div>
          <div className="mode-grid">
            <button className={`mode-card ${mode === 'word' ? 'active' : ''}`} onClick={() => { setMode('word'); setError('') }} aria-pressed={mode === 'word'}>
              <span className="mode-icon coral">Aa</span><strong>Det hemmelige ord</strong><small>Alle får samme ord. Imposteren får et hint eller ingenting.</small><span className="mode-arrow">↗</span>
            </button>
            <button className={`mode-card ${mode === 'question' ? 'active' : ''}`} onClick={() => { setMode('question'); setError('') }} aria-pressed={mode === 'question'}>
              <span className="mode-icon purple">?!</span><strong>Det forkerte spørgsmål</strong><small>Alle svarer. Imposteren ved ikke, at deres spørgsmål er anderledes.</small><span className="mode-arrow">↗</span>
            </button>
          </div>
        </section>

        <section className="panel">
          <div className="section-heading"><span className="step">02</span><div><h2>Hvem spiller?</h2><p>Tilføj 3–12 spillere. Rækkefølgen bliver tur-rækkefølgen.</p></div></div>
          <form className="add-row" onSubmit={event => { event.preventDefault(); addPlayer() }}>
            <input value={name} onChange={event => setName(event.target.value)} placeholder="Skriv et navn" maxLength={32} aria-label="Spillerens navn" />
            <button className="add-button" type="submit" disabled={players.length >= 12}>+ Tilføj</button>
          </form>
          <div className="player-list">{players.map((player, index) => <div className="player-chip" key={player}><span className="avatar">{player.charAt(0).toLocaleUpperCase('da')}</span><span>{player}</span><button aria-label={`Fjern ${player}`} onClick={() => setPlayers(players.filter((_, i) => i !== index))}>×</button></div>)}</div>
          <div className="counter">{players.length} / 12 spillere</div>
        </section>

        <section className="panel">
          <div className="section-heading"><span className="step">03</span><div><h2>Indstil runden</h2><p>Vælg antal impostere og indhold.</p></div></div>
          <div className="setting-row"><div><strong>Antal impostere</strong><small>To impostere er muligt fra 6 spillere.</small></div><div className="segmented"><button className={effectiveCount === 1 ? 'selected' : ''} onClick={() => setImposterCount(1)} aria-pressed={effectiveCount === 1}>1</button><button className={effectiveCount === 2 ? 'selected' : ''} onClick={() => setImposterCount(2)} disabled={players.length < 6} aria-pressed={effectiveCount === 2}>2</button></div></div>
          {mode === 'word' && <div className="setting-row"><div><strong>Hvad ser imposteren?</strong><small>Vælg om og hvornår imposteren får et hint.</small></div><div className="segmented hint-options"><button className={hintMode === 'always' ? 'selected' : ''} onClick={() => setHintMode('always')} aria-pressed={hintMode === 'always'}>Hint</button><button className={hintMode === 'starter' ? 'selected' : ''} onClick={() => setHintMode('starter')} aria-pressed={hintMode === 'starter'}>Hint hvis imposter starter</button><button className={hintMode === 'never' ? 'selected' : ''} onClick={() => setHintMode('never')} aria-pressed={hintMode === 'never'}>Intet</button></div></div>}
          <div className="setting-row"><div><strong>Indhold</strong><small>Vælg indbyggede kort, en blandet bunke eller ét eget kort.</small></div><div className="segmented"><button className={source === 'built-in' ? 'selected' : ''} onClick={() => { setSource('built-in'); setError('') }} aria-pressed={source === 'built-in'}>Kort</button><button className={source === 'mixed' ? 'selected' : ''} onClick={() => { setSource('mixed'); setError('') }} aria-pressed={source === 'mixed'}>Blandet</button><button className={source === 'custom' ? 'selected' : ''} onClick={() => { setSource('custom'); setError('') }} aria-pressed={source === 'custom'}>Én egen runde</button></div></div>
          {source === 'mixed' && <div className="custom-fields"><p className="notice">Egne kort gemmes kun i denne browser og blandes med de indbyggede. Hvis en spiller selv har skrevet et kort, kan vedkommende genkende det.</p><div className="saved-card-heading"><strong>Egne {mode === 'word' ? 'ord' : 'spørgsmål'} ({mode === 'word' ? ownWords.length : ownQuestions.length})</strong></div>{mode === 'word' ? <><label>Tilføj ord<input value={customWord} onChange={event => setCustomWord(event.target.value)} placeholder="F.eks. Strand" maxLength={60} /></label><label>Hint til imposter<input value={customHint} onChange={event => setCustomHint(event.target.value)} placeholder="F.eks. Sommer" maxLength={60} /></label></> : <><label>Det rigtige spørgsmål<textarea value={customReal} onChange={event => setCustomReal(event.target.value)} placeholder="Spørgsmål til de gode" maxLength={240} /></label><label>Imposterens spørgsmål<textarea value={customAlternate} onChange={event => setCustomAlternate(event.target.value)} placeholder="Et andet, men beslægtet spørgsmål" maxLength={240} /></label></>}<button className="add-button save-card-button" onClick={addOwnCard}>+ Gem i kortbunken</button><div className="saved-card-list">{(mode === 'word' ? ownWords : ownQuestions).map(card => <div className="saved-card" key={card.id}><span>{'word' in card ? card.word : card.real}</span><button aria-label={`Fjern kort: ${'word' in card ? card.word : card.real}`} onClick={() => removeOwnCard(card.id)}>×</button></div>)}</div></div>}
          {source === 'custom' && <div className="custom-fields"><p className="notice">Den, der skriver kortet, er spilleder og skal ikke stå på spillerlisten i denne runde.</p>{mode === 'word' ? <><label>Det rigtige ord<input value={customWord} onChange={event => setCustomWord(event.target.value)} placeholder="F.eks. Strand" maxLength={60} /></label>{hintMode !== 'never' && <label>Hint til imposter<input value={customHint} onChange={event => setCustomHint(event.target.value)} placeholder="F.eks. Sommer" maxLength={60} /></label>}</> : <><label>Det rigtige spørgsmål<textarea value={customReal} onChange={event => setCustomReal(event.target.value)} placeholder="Spørgsmål til de gode" maxLength={240} /></label><label>Imposterens spørgsmål<textarea value={customAlternate} onChange={event => setCustomAlternate(event.target.value)} placeholder="Et andet, men beslægtet spørgsmål" maxLength={240} /></label></>}</div>}
        </section>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary start-button" onClick={startRound}>Start spillet <span>→</span></button>
        <p className="footer-note">Ingen konto. Ingen download. Bare spil.</p>
      </>}

      {phase === 'handoff' && round && <section className="game-screen"><div className="progress-label">PRIVAT TUR <span>{turn + 1} / {round.players.length}</span></div><div className="progress-track"><div style={{ width: `${(turn / round.players.length) * 100}%` }} /></div><div className="handoff-icon">◉</div><p className="eyebrow">GIV TELEFONEN VIDERE</p><h1>Det er <em>{activePlayer}s</em> tur</h1><p>Kun {activePlayer} må se den næste skærm. Sørg for, at ingen kigger med.</p><button className="primary" onClick={() => setPhase('private')}>Jeg er {activePlayer} <span>→</span></button></section>}

      {phase === 'private' && round && <section className="game-screen private-screen"><div className="progress-label">KUN FOR {activePlayer?.toLocaleUpperCase('da')} <span>{turn + 1} / {round.players.length}</span></div><div className="progress-track"><div style={{ width: `${((turn + 1) / round.players.length) * 100}%` }} /></div>{round.mode === 'word' ? <><div className={`role-badge ${isImposter ? 'imposter' : 'civilian'}`}>{isImposter ? 'DU ER IMPOSTER' : 'DU KENDER ORDET'}</div><h1>{isImposter ? receivesHint ? 'Dit hint er' : 'Du fik intet ord' : 'Dit ord er'}</h1>{(!isImposter || receivesHint) && <div className="secret-card">{isImposter ? wordCard?.hint : wordCard?.word}</div>}<p>{isImposter ? 'Lyt godt efter, og prøv at passe ind uden at afsløre dig selv.' : 'Gem ordet. Giv et godt hint, men gør det ikke for let.'}</p></> : <><div className="role-badge question">DIT SPØRGSMÅL</div><h1>{questionCard && (isImposter ? questionCard.alternate : questionCard.real)}</h1><p>Svar uden at vise skærmen til de andre. Dit svar vises med dit navn, når alle er færdige.</p><textarea className="answer-input" value={answer} onChange={event => { setAnswer(event.target.value); setError('') }} placeholder="Skriv dit svar her…" maxLength={300} aria-label="Dit svar" /></>}{error && <p className="error" role="alert">{error}</p>}<button className="primary" onClick={finishPrivateTurn}>{turn + 1 === round.players.length ? 'Alle er klar' : 'Skjul og giv videre'} <span>→</span></button></section>}

      {phase === 'discuss' && round && <section className="game-screen discuss-screen"><div className="large-icon">{round.mode === 'word' ? '✦' : '☰'}</div><p className="eyebrow">NU BEGYNDER SPILLET</p>{round.mode === 'word' ? <><h1><em>{round.players[round.starter]}</em> starter</h1><p>Sig ét ord ad gangen i rækkefølge. Tag så mange runder, I vil, og diskutér hvem der lyder mistænkelig.</p></> : <><h1>Hvem fik det <em>forkerte spørgsmål?</em></h1><div className="reveal-question"><small>DET RIGTIGE SPØRGSMÅL</small><strong>{questionCard?.real}</strong></div><div className="answers-list">{round.players.map((player, index) => <div className="answer-item" key={player}><strong>{player}</strong><span>{round.answers[index]}</span></div>)}</div><p>Læs svarene, og diskutér hvem der svarede på noget andet.</p></>}<button className="primary" onClick={() => setPhase('vote')}>Gå til afstemning <span>→</span></button></section>}

      {phase === 'vote' && round && <section className="game-screen vote-screen"><p className="eyebrow">DEN ENDELIGE BESLUTNING</p><h1>Hvem er <em>imposter?</em></h1><p>Vælg {round.imposters.length} {round.imposters.length === 1 ? 'person' : 'personer'}. Gruppen har én fælles stemme. Et nyt valg erstatter det først valgte, hvis alle pladser er brugt.</p><div className="vote-grid">{round.players.map((player, index) => <button className={`vote-option ${selected.includes(index) ? 'chosen' : ''}`} key={player} onClick={() => toggleVote(index)} aria-pressed={selected.includes(index)}><span className="avatar">{player.charAt(0).toLocaleUpperCase('da')}</span><strong>{player}</strong><span className="vote-check">{selected.includes(index) ? '✓' : ''}</span></button>)}</div><p className="selection-count">{selected.length} af {round.imposters.length} valgt</p><button className="primary" disabled={selected.length !== round.imposters.length} onClick={() => setPhase('result')}>Afslør resultatet <span>→</span></button><button className="secondary" onClick={() => setPhase('discuss')}>Tilbage til diskussion</button></section>}

      {phase === 'result' && round && <section className="game-screen result-screen"><div className="large-icon">{allFound ? '✦' : '◆'}</div><p className="eyebrow">RUNDEN ER SLUT</p><h1>{allFound ? <>De gode <em>vinder!</em></> : <>Imposteren{round.imposters.length === 2 ? 'e' : ''} <em>vinder!</em></>}</h1><p>{allFound ? 'I fandt alle imposterne.' : 'I fandt ikke alle imposterne.'}</p><div className="result-card"><small>IMPOSTER{round.imposters.length === 2 ? 'E' : ''}</small><div className="imposter-names">{round.imposters.map(index => <span key={index}>{round.players[index]}</span>)}</div><div className="result-divider" /><small>{round.mode === 'word' ? 'DET RIGTIGE ORD' : 'DET RIGTIGE SPØRGSMÅL'}</small><strong>{round.mode === 'word' ? wordCard?.word : questionCard?.real}</strong>{round.mode === 'word' && starterReceivesHint && <p>{round.hintMode === 'starter' ? `Hint til startspilleren ${round.players[round.starter]}` : 'Hint til imposter'}: {wordCard?.hint}</p>}{round.mode === 'question' && <p>Imposterens spørgsmål: {questionCard?.alternate}</p>}</div><div className="result-votes"><strong>Jeres valg</strong><span>{selected.map(index => round.players[index]).join(' & ')}</span></div><button className="primary" onClick={() => reset()}>Spil igen <span>→</span></button><button className="secondary" onClick={() => reset(false)}>Ny spillergruppe</button></section>}
    </main>
  </div>
}

// Renders every server-controlled phase after the host starts an online round.
type OnlineGameScreenProps = { room: OnlineRoom; game: OnlineGame; playerId: string; isHost: boolean; text: string; setText: (value: string) => void; vote: string; setVote: (value: string) => void; clock: number; busy: boolean; error: string; action: (action: 'start' | 'ready' | 'submit' | 'advance' | 'vote' | 'reset', extras?: Record<string, unknown>) => Promise<void>; leave: () => void }

function OnlineGameScreen({ room, game, playerId, isHost, text, setText, vote, setVote, clock, busy, error, action, leave }: OnlineGameScreenProps) {
  const playerName = (id: string | null) => room.players.find(player => player.id === id)?.name ?? 'Ukendt'
  const secondsLeft = game.deadline ? Math.max(0, Math.ceil((game.deadline - clock) / 1000)) : null
  const isMyTurn = room.phase === 'turns' && game.currentPlayerId === playerId
  const wordCard = game.card && 'word' in game.card ? game.card : null
  const questionCard = game.card && 'real' in game.card ? game.card : null

  return <section className="game-screen online-game">
    <div className="progress-label">RUM {room.code}<span>{room.players.length} SPILLERE</span></div>
    {room.phase === 'reveal' && <><div className={`role-badge ${room.settings.mode === 'question' ? 'question' : game.isImposter ? 'imposter' : 'civilian'}`}>{room.settings.mode === 'question' ? 'DIT SPØRGSMÅL' : game.isImposter ? 'DU ER IMPOSTER' : 'DU ER USKYLDIG'}</div><h1>{room.settings.mode === 'word' ? game.secret ? 'Dit ord eller hint er' : 'Du får intet hint' : 'Dit spørgsmål er'}</h1>{(game.secret || game.prompt) && <div className={room.settings.mode === 'word' ? 'secret-card' : 'reveal-question'}><strong>{game.secret || game.prompt}</strong></div>}<p>Husk det, og vis ikke skærmen til de andre.</p><button className="primary" disabled={game.ready || busy} onClick={() => void action('ready')}>{game.ready ? `Venter på de andre (${game.readyCount}/${room.players.length})` : 'Jeg er klar'} <span>→</span></button></>}
    {room.phase === 'turns' && <><p className="eyebrow">ÉT ORD AD GANGEN</p><h1>{isMyTurn ? <>Det er <em>din tur</em></> : <><em>{playerName(game.currentPlayerId)}</em> skriver</>}</h1>{secondsLeft !== null && <div className={`timer-ring ${secondsLeft <= 5 ? 'urgent' : ''}`}>{secondsLeft}</div>}<div className="online-clues">{room.players.map(player => <div key={player.id}><strong>{player.name}</strong><span>{game.clues[player.id] || (player.id === game.currentPlayerId ? 'skriver…' : '—')}</span></div>)}</div>{isMyTurn && <form className="turn-form" onSubmit={event => { event.preventDefault(); void action('submit', { text }) }}><input value={text} onChange={event => setText(event.target.value.replace(/\s/g, ''))} placeholder="Skriv ét ord" maxLength={30} autoFocus /><button className="primary" disabled={!text.trim() || busy}>Send hint <span>→</span></button></form>}</>}
    {room.phase === 'answering' && <><p className="eyebrow">SVAR HEMMELIGT</p><h1>{game.submitted ? 'Dit svar er sendt' : game.prompt}</h1>{!game.submitted ? <form className="turn-form" onSubmit={event => { event.preventDefault(); void action('submit', { text }) }}><textarea className="answer-input" value={text} onChange={event => setText(event.target.value)} placeholder="Skriv dit svar…" maxLength={120} autoFocus /><button className="primary" disabled={!text.trim() || busy}>Send svar <span>→</span></button></form> : <p>Venter på de andre spillere…</p>}</>}
    {room.phase === 'discussion' && <><p className="eyebrow">DISKUTÉR SVARENE</p><h1>Hvem virker <em>mistænkelig?</em></h1><div className="answers-list">{room.players.map(player => <div className="answer-item" key={player.id}><strong>{player.name}</strong><span>{room.settings.mode === 'word' ? game.clues[player.id] || 'Intet svar' : game.answers[player.id] || 'Intet svar'}</span></div>)}</div>{isHost ? <button className="primary" onClick={() => void action('advance')}>Start afstemning <span>→</span></button> : <p>Venter på at værten starter afstemningen…</p>}</>}
    {room.phase === 'vote' && <><p className="eyebrow">AFSTEMNING</p><h1>Hvem er <em>imposter?</em></h1>{!game.voted ? <><div className="vote-grid">{room.players.filter(player => player.id !== playerId).map(player => <button className={`vote-option ${vote === player.id ? 'chosen' : ''}`} key={player.id} onClick={() => setVote(player.id)}><span className="avatar">{player.name[0]}</span><strong>{player.name}</strong><span className="vote-check">{vote === player.id ? '✓' : ''}</span></button>)}</div><button className="primary" disabled={!vote || busy} onClick={() => void action('vote', { targetId: vote })}>Afgiv stemme <span>→</span></button></> : <p>Din stemme er afgivet. Venter på de andre ({game.votesCast}/{room.players.length})…</p>}</>}
    {room.phase === 'result' && <><p className="eyebrow">RESULTATET</p><h1>Imposteren var <em>{game.imposters.map(playerName).join(' og ')}</em></h1><div className="result-card"><small>{room.settings.mode === 'word' ? 'DET HEMMELIGE ORD' : 'DET RIGTIGE SPØRGSMÅL'}</small><strong>{wordCard?.word || questionCard?.real}</strong><div className="result-divider" />{room.players.map(player => <div className="result-votes" key={player.id}><strong>{player.name}</strong><span>{game.voteCounts[player.id] ?? 0} stemmer</span></div>)}</div>{isHost ? <button className="primary" onClick={() => void action('reset')}>Tilbage til lobbyen <span>→</span></button> : <p>Venter på værten…</p>}</>}
    {error && <p className="error" role="alert">{error}</p>}
    <button className="secondary" onClick={leave}>Forlad rummet</button>
  </section>
}

createRoot(document.getElementById('root')!).render(<App />)
