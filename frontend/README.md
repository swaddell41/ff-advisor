# ff-advisor frontend

Vite + React + TypeScript SPA for the fantasy advisor (`/` My Leagues, `/live`, `/lineup`, `/waivers`, `/redraft`, `/draft`, plus the dynasty pages).

- `npm run dev` — Vite on :5173, proxying `/api` to the FastAPI backend (`VITE_API_TARGET` overrides the target).
- `npm run build` — production bundle to `dist/` (Vercel builds this).
- `src/lib/draftEngine.ts` bundles `../extension/annotate.js` verbatim so the mobile draft companion shows exactly the extension's numbers.
