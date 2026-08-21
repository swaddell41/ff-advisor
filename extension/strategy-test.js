// Strategy-quality regression test. Drives the REAL recommend() through a
// simulated 10-team draft against a frozen board snapshot and scores the
// STARTING LINEUP each strategy finishes with. Exists because the greedy
// scorer was one-pick myopic: in a 2RB/3WR/1FLEX PPR lineup it opened
// WR-TE-WR-WR-WR (Sam's "4 WRs and a TE before an RB" report) and finished
// ~700 starter-value behind an RB-early line. The roster-completion plan
// must keep the free-played engine at least even with every forced
// strategy a human would try.
const fs = require('fs');
const path = require('path');
const dir = path.dirname(__filename);
let SRC = fs.readFileSync(path.join(dir, 'annotate.js'), 'utf8');
SRC = SRC.slice(0, SRC.indexOf('// ── Boot')) +
  '\n__export({ state, recommend, computeReplacement, setCurrentPick });\n})();';
const board = JSON.parse(fs.readFileSync(path.join(dir, 'board-fixture.json'), 'utf8'));

const mkEl = () => ({ style:{}, classList:{add(){},remove(){},toggle(){},contains(){return false}},
  dataset:{}, children:[], appendChild(c){return c;}, insertBefore(c){return c;}, remove(){},
  setAttribute(){}, addEventListener(){}, querySelector(){return mkEl();}, querySelectorAll(){return [];},
  closest(){return null;}, getBoundingClientRect(){return {top:0,bottom:0,left:0,right:0,width:0,height:0};},
  get isConnected(){return true;}, set innerHTML(v){}, get innerHTML(){return '';},
  set textContent(v){}, get textContent(){return '';}, get outerHTML(){return '';} });
let exported = null;
const sandbox = { __export:(x)=>{exported=x;},
  document:{documentElement:mkEl(),body:mkEl(),head:mkEl(),createElement:mkEl,
    createTextNode:(t)=>({nodeValue:t}),querySelector:()=>mkEl(),querySelectorAll:()=>[],
    addEventListener(){},createTreeWalker:()=>({nextNode:()=>null})},
  chrome:undefined,
  window:{location:{hostname:'sleeper.com',pathname:'/draft/nfl/1',search:''},localStorage:{getItem:()=>null,setItem(){}}},
  location:{hostname:'sleeper.com',pathname:'/draft/nfl/1',search:''},
  localStorage:{getItem:()=>null,setItem(){}},
  getComputedStyle:()=>({position:'static',textOverflow:'',overflow:'',overflowX:''}),
  MutationObserver:function(){this.observe=()=>{};},
  NodeFilter:{SHOW_TEXT:4,FILTER_ACCEPT:1,FILTER_SKIP:3,FILTER_REJECT:2},
  fetch:()=>Promise.resolve({ok:true,json:()=>Promise.resolve({players:[]})}),
  setInterval:()=>0,setTimeout:()=>0,clearInterval(){},
  URLSearchParams,JSON,Date,Math,Set,Map,WeakSet,Object,Number,String,Array,RegExp,Promise,Error,console };
new Function(...Object.keys(sandbox), SRC)(...Object.values(sandbox));
const { state, recommend, computeReplacement, setCurrentPick } = exported;

function runDraft(L, mySlot, strategy) {
  state.allPlayers = board.players; state.lineup = L;
  state.format='1qb_ppr'; state.mode='redraft'; state.draftType='snake';
  state.mySlot=mySlot; state.myQBLate=false; state.badges=new Map();
  const gone = new Set(); const rosters = {};
  for (let i=1;i<=L.teams;i++) rosters[i]={};
  const mine = [];
  computeReplacement();
  const avail = () => board.players.filter(p=>!gone.has(String(p.player_id)));
  const oppPick = (slot) => {
    const c=rosters[slot]; const cnt=(x)=>c[x]||0;
    const dedic={QB:(L.qb+L.sf)-cnt('QB'),RB:L.rb-cnt('RB'),WR:L.wr-cnt('WR'),TE:L.te-cnt('TE')};
    const flexUsed=Math.max(0,cnt('RB')-L.rb)+Math.max(0,cnt('WR')-L.wr)+Math.max(0,cnt('TE')-L.te);
    const flexOpen=L.flex-flexUsed;
    const can=(pos)=>(dedic[pos]||0)>0||(flexOpen>0&&(pos==='RB'||pos==='WR'||pos==='TE'));
    const pool=avail(); return pool.find(p=>can(p.position))||pool[0];
  };
  for (let pn=1; pn<=L.teams*9; pn++) {
    const r=Math.ceil(pn/L.teams), idx=(pn-1)%L.teams;
    const slot=(r%2===1)?idx+1:L.teams-idx;
    let p;
    if (slot===mySlot) {
      state.pickedIds=new Set([...gone]); state.myCounts={...rosters[mySlot]};
      state.slotCounts={}; for (const s in rosters) state.slotCounts[s]={...rosters[s]};
      setCurrentPick(pn); recommend();
      const engineChoice=board.players.find(x=>x.name===state.audit.top[0].name);
      p = (strategy && strategy(r, avail(), rosters[mySlot])) || engineChoice;
      mine.push({r, pos:p.position, value:p.value});
    } else p = oppPick(slot);
    gone.add(String(p.player_id));
    rosters[slot][p.position]=(rosters[slot][p.position]||0)+1;
  }
  return mine;
}
function lineupValue(L, mine) {
  const by={QB:[],RB:[],WR:[],TE:[]};
  for (const m of mine) if (by[m.pos]) by[m.pos].push(m.value);
  for (const k in by) by[k].sort((a,b)=>b-a);
  const starters=[...by.QB.slice(0,L.qb), ...by.RB.slice(0,L.rb),
                  ...by.WR.slice(0,L.wr), ...by.TE.slice(0,L.te)];
  const leftovers=[...by.RB.slice(L.rb), ...by.WR.slice(L.wr), ...by.TE.slice(L.te)]
    .sort((a,b)=>b-a);
  starters.push(...leftovers.slice(0,L.flex));
  return Math.round(starters.reduce((a,b)=>a+b,0));
}

let fail = 0;
const ok = (l,pass,detail) => { if(!pass) fail++;
  console.log(`${pass?'PASS':'FAIL'}  ${l}${pass?'':' — '+detail}`); };

const FORCED = {
  'RB round 1': (r,avail) => r===1 ? avail.find(p=>p.position==='RB') : null,
  'RB rounds 1-2': (r,avail) => r<=2 ? avail.find(p=>p.position==='RB') : null,
  'WR rounds 1-2': (r,avail) => r<=2 ? avail.find(p=>p.position==='WR') : null,
  'TE round 1': (r,avail) => r===1 ? avail.find(p=>p.position==='TE') : null,
};
const LINEUPS = [
  ['2RB/3WR/1FLEX', { teams:10, qb:1, sf:0, rb:2, wr:3, te:1, flex:1, k:1, dst:1, rounds:15 }],
  ['2RB/2WR/2FLEX', { teams:10, qb:1, sf:0, rb:2, wr:2, te:1, flex:2, k:1, dst:1, rounds:15 }],
];
for (const [lname, L] of LINEUPS) {
  for (const mySlot of [1, 5, 10]) {
    const free = lineupValue(L, runDraft(L, mySlot, null));
    for (const [fname, strat] of Object.entries(FORCED)) {
      const forced = lineupValue(L, runDraft(L, mySlot, strat));
      // 0.5% tolerance: forcing can luck into a marginally better line, but
      // a real myopia regression shows up as a 2%+ deficit.
      ok(`${lname} slot ${mySlot}: free engine >= forced ${fname}`,
         free >= forced * 0.995, `free ${free} vs forced ${forced}`);
    }
    const naive = lineupValue(L, runDraft(L, mySlot, (r,avail)=>avail[0]));
    ok(`${lname} slot ${mySlot}: free engine beats pure value order`,
       free > naive, `free ${free} vs naive ${naive}`);
  }
}
console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed');
process.exit(fail ? 1 : 0);
