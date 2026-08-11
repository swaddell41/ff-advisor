/**
 * Grade display utilities.
 */

export type GradeColor = 'green' | 'yellow' | 'red' | 'neutral'

export function gradeColor(grade: string | null | undefined): GradeColor {
  if (!grade) return 'neutral'
  if (['A+', 'A', 'A-'].includes(grade)) return 'green'
  if (['B+', 'B', 'B-'].includes(grade)) return 'yellow'
  return 'red'
}

export function gradeClass(grade: string | null | undefined): string {
  const color = gradeColor(grade)
  if (color === 'green') return 'text-green-400 font-bold'
  if (color === 'yellow') return 'text-yellow-400 font-bold'
  if (color === 'red') return 'text-red-400 font-bold'
  return 'text-muted-foreground'
}

export function gradeBadgeVariant(grade: string | null | undefined) {
  const color = gradeColor(grade)
  if (color === 'green') return 'bg-green-900/40 text-green-300 border-green-700'
  if (color === 'yellow') return 'bg-yellow-900/40 text-yellow-300 border-yellow-700'
  if (color === 'red') return 'bg-red-900/40 text-red-300 border-red-700'
  return 'bg-muted text-muted-foreground'
}

export function formatDifferential(diff: number): string {
  if (diff > 0) return `+${diff.toLocaleString()}`
  return diff.toLocaleString()
}

export function formatDate(ts: string | null | undefined): string {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return ts
  }
}

export function formatValue(v: number | undefined | null): string {
  if (v == null) return '—'
  return v.toLocaleString()
}
