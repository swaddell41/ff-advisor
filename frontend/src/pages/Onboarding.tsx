import { useState } from 'react'
import { api } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface LoginLeague {
  league_id: string
  name: string
  season: string
  total_rosters: number
  imported: boolean
  selected: boolean
}

type Step =
  | { step: 'username' }
  | { step: 'leagues'; displayName: string | null; leagues: LoginLeague[] }
  | { step: 'importing'; leagueIds: string[] }

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<Step>({ step: 'username' })
  const [username, setUsername] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [statuses, setStatuses] = useState<Record<string, { status: string; detail: string | null }>>({})

  const handleLogin = async () => {
    if (!username.trim()) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.login(username.trim())
      const already = r.leagues.filter(l => l.selected).map(l => l.league_id)
      // Returning user with imported leagues → straight in.
      if (already.length > 0 && r.leagues.filter(l => l.selected).every(l => l.imported)) {
        onDone()
        return
      }
      setPicked(new Set(already))
      setState({ step: 'leagues', displayName: r.display_name ?? r.username, leagues: r.leagues })
    } catch (e) {
      setError(e instanceof Error && e.message.includes('404')
        ? `No Sleeper user named "${username.trim()}" — check the spelling.`
        : 'Sign-in failed — is the backend running?')
    } finally {
      setBusy(false)
    }
  }

  const handleImport = async () => {
    const ids = [...picked]
    if (ids.length === 0) return
    setBusy(true)
    setError(null)
    try {
      await api.onboardLeagues(ids)
    } catch {
      setError('Could not save your selections — try again.')
      setBusy(false)
      return
    }
    setState({ step: 'importing', leagueIds: ids })
    // Imports run synchronously server-side (~30-60s per league) — drive
    // them one at a time so progress is honest and the server stays calm.
    let failed = false
    for (const id of ids) {
      setStatuses(prev => ({ ...prev, [id]: { status: 'running', detail: 'importing…' } }))
      try {
        const r = await api.onboardImport(id)
        setStatuses(prev => ({ ...prev, [id]: r }))
      } catch (e) {
        failed = true
        setStatuses(prev => ({
          ...prev,
          [id]: { status: 'error', detail: e instanceof Error ? e.message : 'failed' },
        }))
      }
    }
    setBusy(false)
    if (!failed) onDone()
  }

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-lg">Dynasty Advisor</CardTitle>
          <p className="text-sm text-muted-foreground">
            Trade intelligence for your Sleeper dynasty leagues — who needs what,
            who overpays, and what to ask for.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {state.step === 'username' && (
            <>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Your Sleeper username</label>
                <input
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleLogin()}
                  placeholder="e.g. waddes"
                  autoFocus
                  className="w-full text-sm px-3 py-2 rounded-lg border border-border bg-background outline-none focus:border-ring"
                />
                <p className="text-xs text-muted-foreground">
                  No password — league data on Sleeper is public. We just need to know whose teams to analyze.
                </p>
              </div>
              <Button className="w-full" onClick={handleLogin} disabled={busy || !username.trim()}>
                {busy ? 'Looking you up…' : 'Continue'}
              </Button>
            </>
          )}

          {state.step === 'leagues' && (
            <>
              <p className="text-sm">
                Welcome{state.displayName ? `, ${state.displayName}` : ''} — which dynasty leagues
                should we import?
              </p>
              <div className="space-y-1.5">
                {state.leagues.length === 0 && (
                  <p className="text-xs text-muted-foreground italic">
                    No leagues found on your Sleeper account for this season.
                  </p>
                )}
                {state.leagues.map(l => (
                  <label
                    key={l.league_id}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors',
                      picked.has(l.league_id) ? 'border-primary bg-primary/5' : 'border-border hover:border-ring'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={picked.has(l.league_id)}
                      onChange={e => {
                        const next = new Set(picked)
                        if (e.target.checked) next.add(l.league_id)
                        else next.delete(l.league_id)
                        setPicked(next)
                      }}
                    />
                    <span className="text-sm flex-1">{l.name}</span>
                    <span className="text-xs text-muted-foreground font-mono">
                      {l.season} · {l.total_rosters} tm{l.imported ? ' · already imported' : ''}
                    </span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Importing pulls every past season of each league (trades, rosters, drafts) —
                takes about a minute per league the first time.
              </p>
              <Button className="w-full" onClick={handleImport} disabled={busy || picked.size === 0}>
                {busy ? 'Starting…' : `Import ${picked.size} league${picked.size === 1 ? '' : 's'}`}
              </Button>
            </>
          )}

          {state.step === 'importing' && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Importing your leagues…</p>
              {state.leagueIds.map(id => {
                const s = statuses[id]
                return (
                  <div key={id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                    <span className="text-xs font-mono truncate">{id}</span>
                    <span className={cn('text-xs',
                      s?.status === 'done' ? 'text-green-500'
                        : s?.status === 'error' ? 'text-red-400'
                          : 'text-muted-foreground animate-pulse')}>
                      {s?.status === 'done' ? '✓ done' : s?.status === 'error' ? `failed: ${s.detail}` : (s?.detail ?? 'queued…')}
                    </span>
                  </div>
                )
              })}
              <p className="text-xs text-muted-foreground">
                Pulling every season of history from Sleeper — grading trades as we go.
              </p>
            </div>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}
        </CardContent>
      </Card>
    </div>
  )
}
