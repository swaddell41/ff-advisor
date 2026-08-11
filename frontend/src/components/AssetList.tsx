import { cn } from '@/lib/utils'
import type { AssetItem } from '@/lib/api'

const POSITION_COLORS: Record<string, string> = {
  QB: 'text-red-400',
  RB: 'text-green-400',
  WR: 'text-blue-400',
  TE: 'text-yellow-400',
}

function positionClass(pos?: string) {
  return pos ? (POSITION_COLORS[pos] ?? 'text-muted-foreground') : 'text-muted-foreground'
}

interface AssetListProps {
  assets: AssetItem[]
  className?: string
}

export function AssetList({ assets, className }: AssetListProps) {
  if (!assets || assets.length === 0) {
    return <span className="text-muted-foreground text-xs italic">—</span>
  }

  return (
    <ul className={cn('space-y-0.5', className)}>
      {assets.map((a, i) => {
        if (a.type === 'player') {
          return (
            <li key={i} className="flex items-center gap-1.5 text-sm">
              {a.position && (
                <span className={cn('text-xs font-mono font-semibold w-6', positionClass(a.position))}>
                  {a.position}
                </span>
              )}
              <span className="text-foreground">{a.name ?? a.player_id}</span>
            </li>
          )
        }
        if (a.type === 'pick') {
          return (
            <li key={i} className="flex items-center gap-1.5 text-sm">
              <span className="text-xs font-mono font-semibold w-6 text-purple-400">PK</span>
              <span className="text-foreground">{a.label}</span>
            </li>
          )
        }
        return (
          <li key={i} className="text-sm text-muted-foreground">
            {a.label}
          </li>
        )
      })}
    </ul>
  )
}
