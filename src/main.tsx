import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { questionCards, wordCards, type QuestionCard, type WordCard } from './content'
import './style.css'

type Mode = 'word' | 'question'
type Phase = 'setup' | 'handoff' | 'private' | 'discuss' | 'vote' | 'result'
type ContentSource = 'built-in' | 'custom'
type HintMode = 'always' | 'starter' | 'never'
type Round = {
  mode: Mode
  players: string[]
  imposters: number[]
  starter: number
  card: WordCard | QuestionCard
  hintMode: HintMode
  answers: string[]
}

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

function nextCard<T>(mode: Mode, cards: T[]): T {
  const key = `imposter-used-${mode}`
  let used: number[] = []
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '[]')
    if (Array.isArray(stored)) used = stored.filter((value): value is number => Number.isInteger(value) && value >= 0 && value < cards.length)
  } catch { /* Ignore old or invalid browser data. */ }
  const remaining = cards.map((_, index) => index).filter(index => !used.includes(index))
  const pool = remaining.length ? remaining : cards.map((_, index) => index)
  const index = pool[randomInt(pool.length)]
  try { localStorage.setItem(key, JSON.stringify([...(!remaining.length ? [] : used), index])) } catch { /* Private browsing may disable storage. */ }
  return cards[index]
}

function App() {
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
      ? source === 'custom' ? { word: customWord.trim(), hint: customHint.trim() } : nextCard('word', wordCards)
      : source === 'custom' ? { real: customReal.trim(), alternate: customAlternate.trim() } : nextCard('question', questionCards)
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
    setSource('built-in')
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

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">?</span><span>HVEM ER <strong>IMPOSTER</strong></span></div>
      {phase !== 'setup' && <button className="text-button" onClick={() => { if (window.confirm('Afslut denne runde og gå tilbage til opsætning?')) reset() }}>Afslut runde</button>}
    </header>

    <main>
      {phase === 'setup' && <>
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
          <div className="setting-row"><div><strong>Indhold</strong><small>Brug danske kort eller skriv jeres eget.</small></div><div className="segmented"><button className={source === 'built-in' ? 'selected' : ''} onClick={() => { setSource('built-in'); setError('') }} aria-pressed={source === 'built-in'}>Kort</button><button className={source === 'custom' ? 'selected' : ''} onClick={() => { setSource('custom'); setError('') }} aria-pressed={source === 'custom'}>Eget</button></div></div>
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

createRoot(document.getElementById('root')!).render(<App />)
