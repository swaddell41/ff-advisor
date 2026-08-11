import { cn } from '@/lib/utils'
import { gradeBadgeVariant } from '@/lib/gradeUtils'
import type { GradeResult } from '@/lib/api'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface GradeBadgeProps {
  grade: GradeResult | null | undefined
  showFallbackWarning?: boolean
  className?: string
}

export function GradeBadge({ grade, showFallbackWarning = true, className }: GradeBadgeProps) {
  if (!grade) {
    return <span className={cn('text-muted-foreground text-xs', className)}>—</span>
  }

  const letter = grade.letter_grade
  const pct = grade.total_value_received || grade.total_value_given
    ? ((grade.differential / Math.max(grade.total_value_received, grade.total_value_given)) * 100).toFixed(0)
    : '0'
  const sign = grade.differential >= 0 ? '+' : ''
  const hasFallback = grade.used_value_fallback === 1

  const badge = (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-semibold font-mono',
        gradeBadgeVariant(letter),
        className,
      )}
    >
      {letter}
      {hasFallback && showFallbackWarning && (
        <span className="text-yellow-400" title="Historical values unavailable — current values used">⚠</span>
      )}
    </span>
  )

  return (
    <Tooltip>
      <TooltipTrigger render={badge} />
      <TooltipContent side="top" className="text-xs space-y-0.5">
        <p>Received: {grade.total_value_received.toLocaleString()}</p>
        <p>Given: {grade.total_value_given.toLocaleString()}</p>
        <p>Differential: {sign}{grade.differential.toLocaleString()} ({sign}{pct}%)</p>
        {hasFallback && (
          <p className="text-yellow-400 mt-1">⚠ Historical values unavailable — current values used</p>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
