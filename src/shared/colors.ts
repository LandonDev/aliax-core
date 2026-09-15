/** Account colour palette, shared by the vault (assignment) and the UI (picker). */
export const ACCOUNT_COLORS = [
  { id: 'emerald', value: '#34d399' },
  { id: 'sky', value: '#38bdf8' },
  { id: 'violet', value: '#a78bfa' },
  { id: 'amber', value: '#fbbf24' },
  { id: 'rose', value: '#fb7185' },
  { id: 'orange', value: '#fb923c' },
  { id: 'teal', value: '#2dd4bf' },
  { id: 'zinc', value: '#a1a1aa' }
]

export const DEFAULT_COLOR = ACCOUNT_COLORS[0].value

/** A random palette colour, preferring ones no sibling account already uses. */
export function randomAccountColor(taken: (string | undefined)[]): string {
  const free = ACCOUNT_COLORS.filter((c) => !taken.includes(c.value))
  const pool = free.length > 0 ? free : ACCOUNT_COLORS
  return pool[Math.floor(Math.random() * pool.length)].value
}
