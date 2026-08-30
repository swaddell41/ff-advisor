// How much does it cost when the REAL room drafts ADP-ish (QB/TE earlier
// than market value) while the engine predicts the room drafts by OUR
// values? Engine free-play vs forced strategies, all inside the same
// biased environment — the gap to the best forced line measures the
// misprediction cost the engine could not route around.
const fs = require('fs');
const path = require('path');
const dir = path.dirname(__filename);
let SRC = fs.readFileSync(path.join(dir, 'annotate.js'), 'utf8');
SRC = SRC.slice(0, SRC.indexOf('// ── Boot')) +
  '\n__export({ state, recommend, computeReplacement, setCurrentPick });\n})();';
const board = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'board-fixture.json'), 'utf8'));
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

// The room's TRUE preference order: our values, but QB/TE inflated the way
// real redraft ADP inflates them relative to trade-market value.
// Rooms whose true behavior diverges from the engine's room model in every
// direction that matters: QB/TE overdrafted (real redraft ADP), an RB-run
// room, a WR-run room, and a chaotic everything-early room.
const SCENARIOS = {
  'ADP-ish (QB/TE early)': { QB: 1.5, TE: 1.25, RB: 1.0, WR: 1.0 },
  'RB-hungry':             { QB: 1.0, TE: 1.0,  RB: 1.35, WR: 1.0 },
  'WR-hungry':             { QB: 1.0, TE: 1.0,  RB: 1.0, WR: 1.25 },
  'chaos':                 { QB: 1.5, TE: 1.25, RB: 1.2, WR: 1.0 },
};
let ADP_BIAS = null;
let roomOrder = null;
function setBias(bias) {
  ADP_BIAS = bias;
  roomOrder = [...board.players]
    .sort((x,y) => y.value*(ADP_BIAS[y.position]||1) - x.value*(ADP_BIAS[x.position]||1));
}

const L = { teams:10, qb:1, sf:0, rb:2, wr:3, te:1, flex:1, k:1, dst:1, rounds:15 };

function runDraft(mySlot, strategy) {
  state.allPlayers = board.players; state.lineup = L;
  state.format='1qb_ppr'; state.mode='redraft'; state.draftType='snake';
  state.mySlot=mySlot; state.myQBLate=false; state.badges=new Map();
  const gone = new Set(); const rosters = {};
  for (let i=1;i<=L.teams;i++) rosters[i]={};
  const mine = [];
  computeReplacement();
  const oppPick = (slot) => {          // room drafts by BIASED order + need
    const c=rosters[slot]; const cnt=(x)=>c[x]||0;
    const dedic={QB:(L.qb+L.sf)-cnt('QB'),RB:L.rb-cnt('RB'),WR:L.wr-cnt('WR'),TE:L.te-cnt('TE')};
    const flexUsed=Math.max(0,cnt('RB')-L.rb)+Math.max(0,cnt('WR')-L.wr)+Math.max(0,cnt('TE')-L.te);
    const flexOpen=L.flex-flexUsed;
    const can=(pos)=>(dedic[pos]||0)>0||(flexOpen>0&&(pos==='RB'||pos==='WR'||pos==='TE'));
    const pool=roomOrder.filter(p=>!gone.has(String(p.player_id)));
    return pool.find(p=>can(p.position))||pool[0];
  };
  for (let pn=1; pn<=L.teams*9; pn++) {
    const r=Math.ceil(pn/L.teams), idx=(pn-1)%L.teams;
    const slot=(r%2===1)?idx+1:L.teams-idx;
    let p;
    if (slot===mySlot) {
      state.pickedIds=new Set([...gone]); state.myCounts={...rosters[mySlot]};
      state.slotCounts={}; for (const s in rosters) state.slotCounts[s]={...rosters[s]};
      setCurrentPick(pn); recommend();
      const avail=board.players.filter(x=>!gone.has(String(x.player_id)));
      const engineChoice=board.players.find(x=>x.name===state.audit.top[0].name);
      p = (strategy && strategy(r, avail, rosters[mySlot])) || engineChoice;
      mine.push({r, pos:p.position, name:p.name, value:p.value});
    } else p = oppPick(slot);
    gone.add(String(p.player_id));
    rosters[slot][p.position]=(rosters[slot][p.position]||0)+1;
  }
  return mine;
}
function lineupValue(mine) {
  const by={QB:[],RB:[],WR:[],TE:[]};
  for (const m of mine) if (by[m.pos]) by[m.pos].push(m.value);
  for (const k in by) by[k].sort((a,b)=>b-a);
  const st=[...by.QB.slice(0,1),...by.RB.slice(0,2),...by.WR.slice(0,3),...by.TE.slice(0,1)];
  const lo=[...by.RB.slice(2),...by.WR.slice(3),...by.TE.slice(1)].sort((a,b)=>b-a);
  st.push(...lo.slice(0,1));
  return Math.round(st.reduce((a,b)=>a+b,0));
}

const FORCED = {
  'RB rounds 1-2': (r,avail)=>r<=2?avail.find(p=>p.position==='RB'):null,
  'TE round 2': (r,avail)=>r===2?avail.find(p=>p.position==='TE'):null,
  'elite TE round 1': (r,avail)=>r===1?avail.find(p=>p.position==='TE'):null,
  'QB round 3': (r,avail)=>r===3?avail.find(p=>p.position==='QB'):null,
};
let fail = 0;
const ok = (l,pass,detail) => { if(!pass) fail++;
  console.log((pass?'PASS':'FAIL')+'  '+l+(pass?'':' - '+detail)); };
// The engine predicts the room by OUR values in all scenarios; the real
// room drafts by the scenario bias. The engine may not trail the best
// forced strategy by more than 2.5% — re-planning from observed state each
// pick is what keeps model error from compounding, and this bound guards
// that property.
for (const [sname, bias] of Object.entries(SCENARIOS)) {
  setBias(bias);
  for (const slot of [1,5,10]) {
    const free = lineupValue(runDraft(slot, null));
    let best = free, bestName = 'free engine';
    for (const [fname,strat] of Object.entries(FORCED)) {
      const lv = lineupValue(runDraft(slot, strat));
      if (lv > best) { best = lv; bestName = fname; }
    }
    ok(sname+' slot '+slot+': engine within 2.5% of best line',
       free >= best*0.975, 'free '+free+' vs '+bestName+' '+best);
  }
}
console.log(fail ? fail + ' FAILED' : 'all assertions passed');
process.exit(fail ? 1 : 0);
