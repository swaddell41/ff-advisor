// Keeper-draft scenario test: 12 teams, my slot 10, round 1 picks 1-9 made,
// plus five locked keeper picks in future rounds (the Alex Glover's draft).
// Before the fix: currentPick = 15 (14 picks + 1) drifting to 21 as more
// keepers load, "13 players go before you", next pick #34.
// After: currentPick = 10 (I'm on the clock), next = 15, removals = 4.
const fs = require('fs');
const path = require('path');
const dir = path.dirname(__filename);
let SRC = fs.readFileSync(path.join(dir, 'annotate.js'), 'utf8');
SRC = SRC.slice(0, SRC.indexOf('// ── Boot')) +
  '\n__export({ state, nextMyPickInfo, pickMade, interveningSlots });\n})();';

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
const { state, nextMyPickInfo, pickMade, interveningSlots } = exported;

const assert = (cond, msg) => { if (!cond) { console.error('FAIL', msg); process.exit(1); } console.log('PASS', msg); };

state.lineup = { teams: 12, qb: 1, rb: 2, wr: 2, te: 1, flex: 2, sf: 0, k: 1, dst: 1, rounds: 14 };
state.draftType = 'snake';
state.mySlot = 10;

// The poll-loop math, replicated on this draft's picks: 1.1-1.9 live, keepers
// at 4.6=42, 5.3=51, 5.5=53, 6.5=65, 6.12=72.
const pickNos = [1,2,3,4,5,6,7,8,9, 42,51,53,65,72];
const made = new Set(pickNos);
state.madePickNos = made;
let cur = 1; while (made.has(cur)) cur += 1;
state.currentPick = cur;

assert(cur === 10, `current pick is 10 (I'm on the clock at 1.10), got ${cur}`);
const la = nextMyPickInfo();
assert(la && la.next === 15, `my next pick is #15 (2.3), got ${la && la.next}`);
assert(la.removals === 4, `4 players go before me (picks 11-14), got ${la.removals}`);
assert(interveningSlots(la).join(',') === '11,12,12,11', `intervening slots 11,12,12,11, got ${interveningSlots(la)}`);

// A keeper sitting between my turns must not count as a removal.
made.add(12); // suppose 1.12 was also locked
const la2 = nextMyPickInfo();
assert(la2.next === 15 && la2.removals === 3, `keeper at #12 drops removals to 3, got next=${la2.next} removals=${la2.removals}`);
assert(interveningSlots(la2).join(',') === '11,12,11', `keeper slot excluded from room sim, got ${interveningSlots(la2)}`);

// My OWN future pick locked as a keeper -> my next live turn is the round after.
made.add(15); // 2.3 kept
const la3 = nextMyPickInfo();
assert(la3.next === 34, `with my 2.3 kept, next live turn is #34 (3.10), got ${la3.next}`);

// No-keeper draft: behavior identical to the old picks.length+1 math.
state.madePickNos = new Set([1,2,3,4,5,6,7,8,9]);
state.currentPick = 10;
const la4 = nextMyPickInfo();
assert(la4.next === 15 && la4.removals === 4, `plain draft unchanged, got next=${la4.next} removals=${la4.removals}`);

console.log('\nall assertions passed');
