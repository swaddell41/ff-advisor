import { Routes, Route, Link, useLocation } from 'react-router-dom'
import { cn } from '@/lib/utils'
import MyDashboard from '@/pages/MyDashboard'
import AcquireTool from '@/pages/AcquireTool'
import SellTool from '@/pages/SellTool'
import LeaguePicker from '@/pages/LeaguePicker'
import TradeHistory from '@/pages/TradeHistory'
import TradeDetail from '@/pages/TradeDetail'
import ManagerList from '@/pages/ManagerList'
import ManagerProfile from '@/pages/ManagerProfile'

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

export default function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link to="/" className="text-lg font-semibold tracking-tight hover:text-primary transition-colors">
            Dynasty Advisor
          </Link>
          <nav className="flex items-center gap-4">
            <NavLink to="/">My Dashboard</NavLink>
            <NavLink to="/acquire">Acquire</NavLink>
            <NavLink to="/sell">Sell</NavLink>
            <NavLink to="/leagues">Browse Leagues</NavLink>
          </nav>
        </div>
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
      </header>

      <main className="px-6 py-6 max-w-[1400px] mx-auto">
        <Routes>
          <Route path="/" element={<MyDashboard />} />
          <Route path="/acquire" element={<AcquireTool />} />
          <Route path="/sell" element={<SellTool />} />
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
