import type { QuestionCard, WordCard } from './content'

export type SavedWordCard = WordCard & { id: string }
export type SavedQuestionCard = QuestionCard & { id: string }

const wordKey = 'imposter-own-words'
const questionKey = 'imposter-own-questions'

function readCards<T>(key: string, valid: (value: unknown) => value is T): T[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(value) ? value.filter(valid) : []
  } catch { return [] }
}

export function loadWordCards(): SavedWordCard[] {
  return readCards(wordKey, (value): value is SavedWordCard => typeof value === 'object' && value !== null &&
    typeof (value as SavedWordCard).id === 'string' && typeof (value as SavedWordCard).word === 'string' && typeof (value as SavedWordCard).hint === 'string')
}

export function loadQuestionCards(): SavedQuestionCard[] {
  return readCards(questionKey, (value): value is SavedQuestionCard => typeof value === 'object' && value !== null &&
    typeof (value as SavedQuestionCard).id === 'string' && typeof (value as SavedQuestionCard).real === 'string' && typeof (value as SavedQuestionCard).alternate === 'string')
}

export function saveWordCards(cards: SavedWordCard[]): boolean {
  try { localStorage.setItem(wordKey, JSON.stringify(cards)); return true } catch { return false }
}

export function saveQuestionCards(cards: SavedQuestionCard[]): boolean {
  try { localStorage.setItem(questionKey, JSON.stringify(cards)); return true } catch { return false }
}

export function nextCard<T>(mode: 'word' | 'question', builtIn: T[], own: (T & { id: string })[], mixed: boolean): T {
  const cards = [
    ...builtIn.map((card, index) => ({ key: `b:${index}`, card })),
    ...(mixed ? own.map(card => ({ key: `o:${card.id}`, card })) : []),
  ]
  const storageKey = `imposter-used-${mode}`
  let used: string[] = []
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || '[]')
    if (Array.isArray(stored)) used = stored.filter((value): value is string => typeof value === 'string')
  } catch { /* An invalid history starts a new cycle. */ }
  const available = cards.filter(({ key }) => !used.includes(key))
  const pool = available.length ? available : cards
  const picked = pool[Math.floor(Math.random() * pool.length)]
  try { localStorage.setItem(storageKey, JSON.stringify([...(!available.length ? [] : used), picked.key])) } catch { /* Cards still work without storage. */ }
  return picked.card
}
