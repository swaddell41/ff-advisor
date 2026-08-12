/**
 * Typed API client for the FastAPI backend.
 * All requests go to /api/* which the Vite proxy forwards to localhost:8000.
 */

export interface LeagueSeason {
  league_id: string
  season: number
  trade_count: number
}

export interface League {
  name: string
  format_key: string
  seasons: LeagueSeason[]
}

export interface GradeResult {
  grade_type: string
  total_value_received: number
  total_value_given: number
  differential: number
  letter_grade: string
  used_value_fallback: number
}

export interface AssetItem {
  type: 'player' | 'pick' | 'faab'
  // player
  player_id?: string
  name?: string
  position?: string
  // pick
  pick_season?: number
  pick_round?: number
  label?: string
  // faab
  amount?: number
}

export interface TradeSide {
  roster_id: number
  user_id: string
  manager_name: string
  assets_received: AssetItem[]
  assets_given?: AssetItem[]
  decision_grade: GradeResult | null
  outcome_grade: GradeResult | null
}

export interface Trade {
  trade_id: string
  season: number
  week: number
  executed_at: string | null
  sides: TradeSide[]
}

export interface TradesResponse {
  league_id: string
  league_name: string
  format_key: string
  total: number
  page: number
  page_size: number
  trades: Trade[]
}

// ── Phase 4: Me / Dashboard types ───────────────────────────────────────────

export interface BiasHighlight {
  type: string
  label: string
  avg_differential: number
  count: number
  wins: number
  losses: number
  severity: number
  direction: string
}

export interface RecentTrade {
  trade_id: string
  league_id: string
  league_name: string
  season: number
  week: number
  executed_at: string | null
  decision_grade: string | null
  outcome_grade: string | null
  decision_differential: number
  assets_received: string[]
  assets_given: string[]
}

export interface LeagueSummaryForDashboard {
  league_id: string
  name: string
  format_key: string
  my_posture: string
}

export interface DashboardData {
  user_id: string
  overall_stats: DifferentialStats | null
  bias_highlights: BiasHighlight[]
  recent_trades: RecentTrade[]
  leagues: LeagueSummaryForDashboard[]
}

export interface PositionalNeed {
  my_value: number
  league_avg: number
  need_score: number   // positive = need, negative = surplus
  label: string        // 'need' | 'slight need' | 'average' | 'slight surplus' | 'surplus'
  // picks-only fields
  net_pick_value?: number
  net_future_picks?: number
}

export interface PositionalNeeds {
  format_key: string
  snapshot_date: string | null
  my_values: Record<string, number>
  league_avg: Record<string, number>
  needs: Record<string, PositionalNeed>
}

export interface TradeTarget {
  user_id: string
  manager_name: string
  their_posture: string
  posture_is_override: boolean
  overpay_score: number
  mismatch_score: number
  pos_fit_score: number
  opportunity_score: number
  fills_my_need: string[]
  wants_my_surplus: string[]
  pick_capital_score: number
  avg_decision_differential: number | null
  win_rate: number | null
  total_trades: number
  actionable_summary: string
}

export interface TradeTargetsResponse {
  league_id: string
  league_name: string
  my_posture: string
  positional_needs: PositionalNeeds
  targets: TradeTarget[]
}

// ── Acquisition tool types ──────────────────────────────────────────────────

export interface AcquirePlayer {
  player_id: string
  name: string
  team: string | null
  age: number | null
  value: number
  rank: number
  position?: string
  likely_available?: boolean
  availability_reason?: string | null
}

export interface PickInventoryItem {
  season: number
  round: number
  label: string
  value: number
  via: 'own' | 'acquired'
}

export interface AssetRef {
  type: 'player' | 'pick'
  player_id?: string
  season?: number
  round?: number
}

export interface DealPackageItem {
  label: string
  value: number
  ref?: AssetRef
}

// ── Deal builder types ──────────────────────────────────────────────────────

export interface DealSideAsset {
  type: 'player' | 'pick'
  label: string
  position: string | null
  age: number | null
  value: number
  ref: AssetRef
  perceived_value?: number
  adjusted_value?: number
  market_value?: number | null
  contested?: boolean
  note: string | null
}

export interface DealEvaluation {
  league_id: string
  counterparty: { user_id: string; name: string; posture: string }
  my_side: DealSideAsset[]
  their_side: DealSideAsset[]
  totals: {
    my_raw: number; my_perceived: number
    their_raw: number; their_adjusted: number
    my_market?: number; their_market?: number
  }
  ratio: number | null
  verdict: { label: string; text: string } | null
  market_ratio?: number | null
  market_verdict?: { label: string; text: string } | null
  beliefs?: string[]
  notes: string[]
  receptivity: {
    appetite_share: number | null
    appetite_pick_trades: number
    appetite_total_trades: number
    draft_skill: DraftSkill
    draft_skill_note: string | null
  }
}

export interface DealPackage {
  kind: 'picks_only' | 'player_plus_pick' | 'player_swap'
  items: DealPackageItem[]
  package_value: number
  sticker_value: number
  adjusted_target_value: number
  rationale: string
}

export interface AcquireSuggestion {
  player: AcquirePlayer
  packages: DealPackage[]
}

export interface PickConversionSide {
  count: number
  resolved: number
  pending: number
  avg_return_ratio: number | null
  median_return_ratio: number | null
  hit_rate: number | null
  bust_rate: number | null
  best: { player_name: string; pick_label: string; cost_at_trade: number; value_now: number; ratio: number } | null
  worst: { player_name: string; pick_label: string; cost_at_trade: number; value_now: number; ratio: number } | null
}

export interface PickConversion {
  acquired: PickConversionSide
  shed: PickConversionSide
  tendency: string | null
}

export interface DraftSkill {
  n: number
  median_ratio: number | null
  label: 'sharp' | 'cold' | 'average' | null
  seasons: number[]
  best: { player: string; pick: string; ratio: number } | null
  worst: { player: string; pick: string; ratio: number } | null
}

export interface PickReceptivity {
  appetite_share: number | null
  appetite_pick_trades: number
  appetite_total_trades: number
  needs_picks: boolean
  preferred_horizon_years: number | null
  concentrated_years: number[]
  draft_skill: DraftSkill
  draft_skill_note: string | null
}

export interface AcquireTarget {
  user_id: string
  manager_name: string
  their_posture: string
  acquisition_score: number
  scores: { surplus: number; seller: number; willingness: number; payment: number }
  position_value: number
  surplus_pct: number
  shed_bias: number | null
  shed_count: number
  avg_decision_differential: number | null
  total_trades: number
  pick_receptivity: PickReceptivity
  pick_capital_score: number
  players: AcquirePlayer[]
  suggestions: AcquireSuggestion[]
  summary: string
}

export interface AcquireResponse {
  league_id: string
  league_name: string
  position: string
  format_key: string
  snapshot_date: string | null
  my_context: {
    my_value: number
    league_avg: number
    surplus_positions: string[]
    pick_inventory: PickInventoryItem[]
    offerable_players: AcquirePlayer[]
  }
  targets: AcquireTarget[]
}

// ── Sell tool types ─────────────────────────────────────────────────────────

export interface MyAssetsResponse {
  league_id: string
  current_league_id: string
  format_key: string
  snapshot_date: string | null
  players: AcquirePlayer[]
  picks: PickInventoryItem[]
}

export interface SellAsset {
  type: 'player' | 'pick'
  player_id?: string
  season?: number
  round?: number
  name: string
  position: string | null
  team?: string | null
  age: number | null
  value: number
}

export interface AskPackage {
  kind: 'picks_only' | 'player' | 'player_plus_pick'
  items: DealPackageItem[]
  ask_total: number
}

export interface SellBuyer {
  user_id: string
  manager_name: string
  their_posture: string
  buyer_score: number
  scores: { need: number; overpay: number; posture: number; payment: number }
  acq_pos_bias: number | null
  acq_pos_count: number
  avg_decision_differential: number | null
  total_trades: number
  pick_capital_score: number
  their_picks: PickInventoryItem[]
  premium_pct: number
  premium_reasons: string[]
  ask_value: number
  asks: AskPackage[]
  summary: string
}

export interface SellResponse {
  league_id: string
  league_name: string
  format_key: string
  snapshot_date: string | null
  asset: SellAsset
  my_need_positions: string[]
  buyers: SellBuyer[]
}

// ── Phase 3: Manager profile types ──────────────────────────────────────────

export interface ManagerSummary {
  user_id: string
  manager_name: string
  total_trades: number
  graded_trades: number
  avg_decision_differential: number | null
  wins: number
  losses: number
  neutrals: number
  win_rate: number | null
  best_grade: string | null
  worst_grade: string | null
}

export interface BiasStat {
  count: number
  avg_differential: number | null
  wins: number
  losses: number
  neutrals: number
}

export interface PositionBias {
  acquiring: BiasStat
  shedding: BiasStat
}

export interface AgeBias {
  label: string
  acquiring: BiasStat
  shedding: BiasStat
}

export interface PosturePatterns {
  rebuild: BiasStat
  contend: BiasStat
  neutral: BiasStat
  stuck_signal: boolean
  note: string
}

export interface DifferentialStats {
  total_trades: number
  graded_trades: number
  avg_decision_differential: number | null
  avg_outcome_differential: number | null
  best_decision_trade: { trade_id: string; differential: number; letter_grade: string; executed_at: string } | null
  worst_decision_trade: { trade_id: string; differential: number; letter_grade: string; executed_at: string } | null
  wins: number
  losses: number
  neutrals: number
  win_rate: number | null
}

export interface ManagerProfile {
  user_id: string
  manager_name: string
  anchor_league_id: string
  scope: string
  scope_label: string
  leagues_included: string[]
  seasons_included: number[]
  differential_stats: DifferentialStats
  position_biases: Record<string, PositionBias>
  age_biases: Record<string, AgeBias>
  posture_patterns: PosturePatterns
  pick_conversion?: PickConversion
  scouting_report: string | null
  profile_hash: string
  anthropic_configured: boolean
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, options)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API error ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  getMe: () => apiFetch<{ user_id: string; username: string; display_name: string }>('/api/me'),

  getDashboard: () => apiFetch<DashboardData>('/api/me/dashboard'),

  getTradeTargets: (leagueId: string) =>
    apiFetch<TradeTargetsResponse>(`/api/leagues/${leagueId}/trade-targets`),

  getAcquire: (leagueId: string, position: string) =>
    apiFetch<AcquireResponse>(`/api/leagues/${leagueId}/acquire/${position}`),

  getRosterNeeds: (leagueId: string) =>
    apiFetch<PositionalNeeds & { league_id: string }>(`/api/me/roster-needs/${leagueId}`),

  getMyAssets: (leagueId: string) =>
    apiFetch<MyAssetsResponse>(`/api/leagues/${leagueId}/my-assets`),

  getSellPlayer: (leagueId: string, playerId: string) =>
    apiFetch<SellResponse>(`/api/leagues/${leagueId}/sell/player/${playerId}`),

  getSellPick: (leagueId: string, season: number, round: number) =>
    apiFetch<SellResponse>(`/api/leagues/${leagueId}/sell/pick/${season}/${round}`),

  getManagerAssets: (leagueId: string, userId: string) =>
    apiFetch<MyAssetsResponse>(`/api/leagues/${leagueId}/managers/${userId}/assets`),

  getFreshness: () =>
    apiFetch<{ rosters_fetched_at: string | null; values_snapshot_date: string | null; market_snapshot_date: string | null }>('/api/freshness'),

  refreshData: () =>
    apiFetch<{ refreshed_leagues: number; new_trades: number; newly_graded: number; rosters_fetched_at: string | null }>('/api/refresh', { method: 'POST' }),

  evaluateDeal: (leagueId: string, body: { counterparty_user_id: string; my_assets: AssetRef[]; their_assets: AssetRef[] }) =>
    apiFetch<DealEvaluation>(`/api/leagues/${leagueId}/deals/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  getMyPosture: (leagueId: string) =>
    apiFetch<{ league_id: string; posture: string; is_override: boolean }>(
      `/api/leagues/${leagueId}/my-posture`
    ),

  setMyPosture: (leagueId: string, posture: string) =>
    apiFetch<{ league_id: string; posture: string; is_override: boolean }>(
      `/api/leagues/${leagueId}/my-posture`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ posture }),
      }
    ),

  setManagerPosture: (leagueId: string, targetUserId: string, posture: string) =>
    apiFetch<{ user_id: string; league_id: string; posture: string }>(
      `/api/leagues/${leagueId}/managers/${targetUserId}/posture`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ posture }),
      }
    ),

  getLeagues: () =>
    apiFetch<{ leagues: League[] }>('/api/leagues'),

  getTrades: (leagueId: string, page = 1, season?: number) => {
    const params = new URLSearchParams({ page: String(page), page_size: '50' })
    if (season) params.set('season', String(season))
    return apiFetch<TradesResponse>(`/api/leagues/${leagueId}/trades?${params}`)
  },

  getTrade: (tradeId: string) =>
    apiFetch<Trade>(`/api/trades/${tradeId}`),

  recomputeGrades: (body: { league_id?: string; trade_id?: string }) =>
    apiFetch<{ status: string }>('/api/grading/recompute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  getManagers: (leagueId: string, scope = 'family') =>
    apiFetch<{ league_id: string; league_name: string; scope: string; managers: ManagerSummary[] }>(
      `/api/leagues/${leagueId}/managers?scope=${scope}`
    ),

  getManagerProfile: (leagueId: string, userId: string, scope = 'family') =>
    apiFetch<ManagerProfile>(`/api/leagues/${leagueId}/managers/${userId}?scope=${scope}`),

  generateScoutingReport: (userId: string, leagueId: string, scope = 'family') =>
    apiFetch<{ report: string; cached: boolean }>('/api/managers/' + userId + '/scouting_report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ league_id: leagueId, scope }),
    }),
}
