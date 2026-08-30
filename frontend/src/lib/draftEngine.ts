// Runs the Chrome extension's draft engine (extension/annotate.js) inside the
// web app, so the mobile companion page shows EXACTLY the numbers the desktop
// side panel shows. The source is bundled verbatim via Vite's ?raw import —
// one file of truth, no fork to drift. Same sandbox harness the extension's
// offline tests (strategy-test.js, keeper-test.js) use: slice the IIFE off
// before its Boot section (which is coupled to the sleeper.com DOM), evaluate
// it with inert stand-ins for the browser globals it touches, and export the
// pure state + scoring machinery.
import annotateSrc from '../../../extension/annotate.js?raw'

export interface DraftEngine {
  state: Record<string, any>
  recommend: () => void
  computeReplacement: () => void
}

const mkEl = (): any => ({
  style: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  dataset: {},
  children: [],
  appendChild: (c: any) => c,
  insertBefore: (c: any) => c,
  remove() {},
  setAttribute() {},
  addEventListener() {},
  querySelector: () => mkEl(),
  querySelectorAll: () => [],
  closest: () => null,
  getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
  get isConnected() { return true },
  set innerHTML(_v: any) {},
  get innerHTML() { return '' },
  set textContent(_v: any) {},
  get textContent() { return '' },
  get outerHTML() { return '' },
})

export function createDraftEngine(): DraftEngine {
  let src = annotateSrc as string
  const bootAt = src.indexOf('// ── Boot')
  if (bootAt < 0) throw new Error('annotate.js Boot marker missing — engine harness needs updating')
  src = src.slice(0, bootAt) + '\n__export({ state, recommend, computeReplacement });\n})();'

  let exported: DraftEngine | null = null
  const sandbox: Record<string, any> = {
    __export: (x: DraftEngine) => { exported = x },
    document: {
      documentElement: mkEl(), body: mkEl(), head: mkEl(), createElement: mkEl,
      createTextNode: (t: string) => ({ nodeValue: t }),
      querySelector: () => mkEl(), querySelectorAll: () => [],
      addEventListener() {}, createTreeWalker: () => ({ nextNode: () => null }),
    },
    chrome: undefined,
    window: { location: { hostname: 'sleeper.com', pathname: '/draft/nfl/1', search: '' }, localStorage: { getItem: () => null, setItem() {} } },
    location: { hostname: 'sleeper.com', pathname: '/draft/nfl/1', search: '' },
    localStorage: { getItem: () => null, setItem() {} },
    getComputedStyle: () => ({ position: 'static', textOverflow: '', overflow: '', overflowX: '' }),
    MutationObserver: function (this: any) { this.observe = () => {} },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_SKIP: 3, FILTER_REJECT: 2 },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ players: [] }) }),
    setInterval: () => 0, setTimeout: () => 0, clearInterval() {},
    URLSearchParams, JSON, Date, Math, Set, Map, WeakSet, Object, Number, String, Array, RegExp, Promise, Error, console,
  }
  // eslint-disable-next-line no-new-func
  new Function(...Object.keys(sandbox), src)(...Object.values(sandbox))
  if (!exported) throw new Error('draft engine failed to initialize')
  return exported
}

// Snake-draft slot for an overall pick number — mirrors pickSlot() inside the
// engine (not exported), used by the page for on-the-clock display.
export function pickSlot(pn: number, teams: number, snake: boolean): number {
  const rnd = Math.floor((pn - 1) / teams)
  const idx = (pn - 1) % teams
  return snake && rnd % 2 === 1 ? teams - idx : idx + 1
}
