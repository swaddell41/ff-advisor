import { useEffect, useState } from 'react'
import { Routes, Route, Link, Navigate, useLocation } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import MyDashboard from '@/pages/MyDashboard'
import Onboarding from '@/pages/Onboarding'
import TradeHub from '@/pages/TradeHub'
import LeaguePicker from '@/pages/LeaguePicker'
import TradeHistory from '@/pages/TradeHistory'
import TradeDetail from '@/pages/TradeDetail'
import ManagerList from '@/pages/ManagerList'
import ManagerProfile from '@/pages/ManagerProfile'
import DraftCompanion from '@/pages/DraftCompanion'
import RedraftEval from '@/pages/RedraftEval'
import StartSit from '@/pages/StartSit'
import Waivers from '@/pages/Waivers'

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  const { pathname } = useLocation()
  const active = pathname === to || (to !== '/' && pathname.startsWith(to))
  return (
    <Link
      to={to}
      className={cn(
        'text-sm transition-colors',
        active ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </Link>
  )
}

function ageLabel(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso.includes('T') ? iso : iso + 'T00:00:00Z').getTime()
  const hours = ms / 3.6e6
  if (hours < 1) return 'just now'
  if (hours < 24) return `${Math.round(hours)}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function FreshnessChip() {
  const [rostersAt, setRostersAt] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    api.getFreshness().then(f => setRostersAt(f.rosters_fetched_at)).catch(console.error)
  }, [])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      const r = await api.refreshData()
      setRostersAt(r.rosters_fetched_at)
      // Reload so every view reflects the fresh rosters/trades.
      window.location.reload()
    } catch (e) {
      console.error(e)
      setRefreshing(false)
    }
  }

  const stale = rostersAt != null && Date.now() - new Date(rostersAt).getTime() > 24 * 3.6e6
  return (
    <button
      onClick={handleRefresh}
      disabled={refreshing}
      title="Re-pull rosters, this season's trades, and traded picks from Sleeper (grades any new trades). Values refresh separately via make snapshot."
      className={cn(
        'text-xs px-2 py-1 rounded border font-mono transition-colors',
        refreshing
          ? 'border-border text-muted-foreground animate-pulse'
          : stale
            ? 'border-yellow-400 bg-yellow-100 text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-300 hover:border-ring'
            : 'border-border text-muted-foreground hover:text-foreground hover:border-ring'
      )}
    >
      {refreshing ? 'refreshing…' : `↻ rosters ${ageLabel(rostersAt)}`}
    </button>
  )
}

function SessionBadge() {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    api.authMe().then(u => setName(u.display_name ?? u.username ?? u.user_id)).catch(() => {})
  }, [])
  if (!name) return null
  return (
    <span className="text-xs text-muted-foreground">
      {name}{' '}
      <button
        onClick={() => api.logout().then(() => window.location.reload())}
        className="underline underline-offset-2 hover:text-foreground"
      >
        sign out
      </button>
    </span>
  )
}

export default function App() {
  // Gate: /api/me succeeds for a session user OR the local .env fallback.
  const [gate, setGate] = useState<'loading' | 'in' | 'out'>('loading')
  useEffect(() => {
    api.getMe().then(() => setGate('in')).catch(() => setGate('out'))
  }, [])

  if (gate === 'loading') return null
  if (gate === 'out') {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <Onboarding onDone={() => window.location.reload()} />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link to="/" className="text-lg font-semibold tracking-tight hover:text-primary transition-colors">
            Dynasty Advisor
          </Link>
          <nav className="flex items-center gap-4">
            <NavLink to="/">My Dashboard</NavLink>
            <NavLink to="/trade">Trade Hub</NavLink>
            <NavLink to="/draft">Draft</NavLink>
            <NavLink to="/redraft">Redraft</NavLink>
            <NavLink to="/lineup">Start/Sit</NavLink>
            <NavLink to="/waivers">Waivers</NavLink>
            <NavLink to="/leagues">Browse Leagues</NavLink>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <SessionBadge />
          <FreshnessChip />
          <span className="text-xs text-muted-foreground">
            Values by{' '}
            <a
              href="https://rosteraudit.com"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground transition-colors"
            >
              RosterAudit.com
            </a>
          </span>
        </div>
      </header>

      <main className="px-6 py-6 max-w-[1400px] mx-auto">
        <Routes>
          <Route path="/" element={<MyDashboard />} />
          <Route path="/trade" element={<TradeHub />} />
          <Route path="/draft" element={<DraftCompanion />} />
          <Route path="/redraft" element={<RedraftEval />} />
          <Route path="/lineup" element={<StartSit />} />
          <Route path="/waivers" element={<Waivers />} />
          <Route path="/acquire" element={<Navigate to="/trade" replace />} />
          <Route path="/sell" element={<Navigate to="/trade?mode=sell" replace />} />
          <Route path="/leagues" element={<LeaguePicker />} />
          <Route path="/leagues/:leagueId/trades" element={<TradeHistory />} />
          <Route path="/leagues/:leagueId/managers" element={<ManagerList />} />
          <Route path="/leagues/:leagueId/managers/:userId" element={<ManagerProfile />} />
          <Route path="/trades/:tradeId" element={<TradeDetail />} />
        </Routes>
      </main>
    </div>
  )
}
