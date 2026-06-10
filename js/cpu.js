// =====================================================================
// CPU strategy (DOM-free, shared with the server).
// All functions that need game state take it as the first argument `S`,
// so multiple games can run in one process (one state object per room).
// =====================================================================
function lerp(a, b, t) { return a + (b - a) * t; }

function chenScore(hole) {
  const [c1, c2] = [...hole].sort((a, b) => b.rank - a.rank);
  const hi = c1.rank, lo = c2.rank;
  const hv = r => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2);
  let s;
  if (hi === lo) { s = Math.max(5, hv(hi) * 2); }
  else {
    s = hv(hi);
    if (c1.suit === c2.suit) s += 2;
    const gap = hi - lo - 1;
    if (gap === 1) s -= 1; else if (gap === 2) s -= 2; else if (gap === 3) s -= 4; else if (gap >= 4) s -= 5;
    if (gap <= 1 && hi < 12) s += 1;
  }
  return s;
}
function drawBonus(cards, communityLen) {
  if (communityLen >= 5) return 0;
  let bonus = 0;
  const suitCount = {};
  cards.forEach(c => suitCount[c.suit] = (suitCount[c.suit] || 0) + 1);
  if (Object.values(suitCount).some(v => v === 4)) bonus += 0.15;
  const rset = [...new Set(cards.map(c => c.rank))];
  if (rset.includes(14)) rset.push(1);
  rset.sort((a, b) => a - b);
  let run = 1, maxrun = 1;
  for (let i = 1; i < rset.length; i++) { if (rset[i] === rset[i - 1] + 1) { run++; maxrun = Math.max(maxrun, run); } else run = 1; }
  if (maxrun >= 4) bonus += 0.12;
  return Math.min(bonus, 0.22);
}
function handStrength(S, idx) {
  const p = S.players[idx];
  if (S.community.length === 0) {
    return Math.max(0.02, Math.min(0.97, chenScore(p.holeCards) / 21));
  }
  const all = [...p.holeCards, ...S.community];
  const sc = bestHand(all);
  const base = [0.14, 0.33, 0.47, 0.59, 0.70, 0.80, 0.90, 0.96, 0.99][sc[0]];
  return Math.min(0.99, base + drawBonus(all, S.community.length));
}
function clampRaise(S, p, target) {
  const maxTotal = p.bet + p.stack;
  // enforce min raise unless all-in
  let minTo = S.currentBet + S.minRaise;
  if (S.currentBet === 0) minTo = S.bb;
  if (target < minTo) target = minTo;
  target = Math.min(target, maxTotal);
  return target;
}

// =====================================================================
// GTO-lite engine: range estimation + Monte Carlo equity + balanced decisions
// =====================================================================
// Precompute the 169 canonical starting hands, their specific combos, and a
// strength ordering (via Chen score) so we can talk about "the top X% of hands".
const ALL_KEYS = [];
const KEY_COMBOS = {};       // key -> array of [cardA, cardB]
const KEY_COMBO_COUNT = {};  // key -> int (6 pair / 4 suited / 12 offsuit)
let CANON_SORTED = [];       // [{key, strength, combos}] sorted strong -> weak
(function initCanon() {
  function register(key, combos, strength) {
    ALL_KEYS.push(key);
    KEY_COMBOS[key] = combos;
    KEY_COMBO_COUNT[key] = combos.length;
    CANON_SORTED.push({ key, strength, combos: combos.length });
  }
  for (let hi = 14; hi >= 2; hi--) {
    for (let lo = hi; lo >= 2; lo--) {
      if (hi === lo) {
        const key = rl(hi) + rl(hi), combos = [];
        for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) combos.push([mkCard(SUITS[a], hi), mkCard(SUITS[b], hi)]);
        register(key, combos, chenScore([mkCard('S', hi), mkCard('H', hi)]));
      } else {
        const cs = []; // suited
        for (let a = 0; a < 4; a++) cs.push([mkCard(SUITS[a], hi), mkCard(SUITS[a], lo)]);
        register(rl(hi) + rl(lo) + 's', cs, chenScore([mkCard('S', hi), mkCard('S', lo)]));
        const co = []; // offsuit
        for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) if (a !== b) co.push([mkCard(SUITS[a], hi), mkCard(SUITS[b], lo)]);
        register(rl(hi) + rl(lo) + 'o', co, chenScore([mkCard('S', hi), mkCard('H', lo)]));
      }
    }
  }
  CANON_SORTED.sort((a, b) => b.strength - a.strength);
})();
const TOTAL_COMBOS = 1326;

// cumulative "top X% of all starting hands" fraction per canonical key (0 = strongest)
const KEY_TOP_FRAC = {};
(function initTopFrac() {
  let acc = 0;
  for (const h of CANON_SORTED) { acc += h.combos; KEY_TOP_FRAC[h.key] = acc / TOTAL_COMBOS; }
})();
function holeKey(hole) {
  const [a, b] = [...hole].sort((x, y) => y.rank - x.rank);
  if (a.rank === b.rank) return rl(a.rank) + rl(b.rank);
  return rl(a.rank) + rl(b.rank) + (a.suit === b.suit ? 's' : 'o');
}
function holeTopFrac(hole) { const f = KEY_TOP_FRAC[holeKey(hole)]; return f == null ? 1 : f; }

function rangeTopFraction(frac) {
  const target = frac * TOTAL_COMBOS;
  let acc = 0; const set = new Set();
  for (const h of CANON_SORTED) { set.add(h.key); acc += h.combos; if (acc >= target) break; }
  return set;
}
function intersectRange(A, B) { const out = new Set(); A.forEach(k => { if (B.has(k)) out.add(k); }); return out; }

// strength (0..1) of a canonical hand on the current board (representative combo)
function canonStrengthOnBoard(key, board) {
  const combos = KEY_COMBOS[key];
  let rep = null;
  for (const c of combos) { if (!board.some(b => b.id === c[0].id || b.id === c[1].id)) { rep = c; break; } }
  if (!rep) return 0;
  if (board.length < 3) return Math.min(0.97, chenScore([rep[0], rep[1]]) / 21);
  const sc = bestHand([rep[0], rep[1], ...board]);
  return [0.14, 0.33, 0.47, 0.59, 0.70, 0.80, 0.90, 0.96, 0.99][sc[0]];
}
function filterRangeByStrength(R, board, pred) {
  const out = new Set();
  R.forEach(k => { if (pred(canonStrengthOnBoard(k, board))) out.add(k); });
  return out;
}

function initRanges(S) {
  S.ranges = {};
  S.players.forEach((p, i) => { if (p.inHand) S.ranges[i] = new Set(ALL_KEYS); });
}

// Narrow a player's estimated range based on the action they just took.
function updateRangeOnAction(S, idx, action, sizeFrac, street, aggrCount) {
  let R = S.ranges[idx];
  if (!R) return;
  const per = S.players[idx].personality || { tight: 0.5, aggression: 0.5, bluff: 0.12 };

  if (street === 'preflop') {
    if (action === 'ベット' || action === 'レイズ' || action === 'オールイン') {
      // open raise vs 3-bet+: looser personalities use wider ranges
      const frac = aggrCount <= 1 ? lerp(0.20, 0.10, per.tight) : lerp(0.09, 0.04, per.tight);
      S.ranges[idx] = intersectRange(R, rangeTopFraction(frac));
    } else if (action === 'コール') {
      S.ranges[idx] = intersectRange(R, rangeTopFraction(lerp(0.48, 0.22, per.tight)));
    }
    // チェック (BB option) / SB / BB: no information -> no narrowing
  } else {
    const board = S.community;
    if (action === 'ベット' || action === 'レイズ' || action === 'オールイン') {
      // polarized: value hands + a balanced slice of bluffs/draws
      const valueThr = sizeFrac > 0.8 ? 0.55 : 0.47;
      S.ranges[idx] = filterRangeByStrength(R, board, h => h >= valueThr || (h >= 0.22 && Math.random() < 0.45));
    } else if (action === 'コール') {
      S.ranges[idx] = filterRangeByStrength(R, board, h => h >= 0.27 && h <= 0.93);
    } else if (action === 'チェック') {
      S.ranges[idx] = filterRangeByStrength(R, board, h => h <= 0.82);
    }
  }
  if (!S.ranges[idx] || S.ranges[idx].size === 0) S.ranges[idx] = rangeTopFraction(lerp(0.6, 0.3, per.tight));
}

function buildWeightedKeys(R) {
  const arr = [];
  const src = (R && R.size > 0) ? R : new Set(ALL_KEYS);
  src.forEach(k => { const n = KEY_COMBO_COUNT[k]; for (let i = 0; i < n; i++) arr.push(k); });
  return arr;
}
function sampleHand(weightedKeys, used) {
  if (weightedKeys.length === 0) return null;
  for (let t = 0; t < 14; t++) {
    const key = weightedKeys[(Math.random() * weightedKeys.length) | 0];
    const combos = KEY_COMBOS[key];
    const c = combos[(Math.random() * combos.length) | 0];
    if (!used.has(c[0].id) && !used.has(c[1].id)) return c;
  }
  return null;
}

// Monte Carlo equity of heroHole vs a set of opponent ranges on the given board.
function equityVsRanges(heroHole, board, opps, samples) {
  const fullDeck = createDeck();
  const baseDead = new Set([...heroHole, ...board].map(c => c.id));
  let win = 0, total = 0;
  for (let s = 0; s < samples; s++) {
    const used = new Set(baseDead);
    const oppHands = []; let ok = true;
    for (const o of opps) {
      const h = sampleHand(o.weightedKeys, used);
      if (!h) { ok = false; break; }
      used.add(h[0].id); used.add(h[1].id); oppHands.push(h);
    }
    if (!ok) continue;
    const rem = fullDeck.filter(c => !used.has(c.id));
    const need = 5 - board.length;
    for (let k = 0; k < need; k++) { const j = (Math.random() * (rem.length - k)) | 0; const last = rem.length - 1 - k; const tmp = rem[j]; rem[j] = rem[last]; rem[last] = tmp; }
    const draw = rem.slice(rem.length - need);
    const fullBoard = board.concat(draw);
    const heroSc = bestHand(heroHole.concat(fullBoard));
    let heroWins = true, ties = 1;
    for (const oh of oppHands) {
      const c = cmpScore(bestHand(oh.concat(fullBoard)), heroSc);
      if (c > 0) { heroWins = false; break; }
      else if (c === 0) ties++;
    }
    if (heroWins) win += 1 / ties;
    total++;
  }
  return total > 0 ? win / total : 0.5;
}

// Equity with fully-known hole cards (all-in runout display).
// Exact enumeration when at most 2 board cards remain, Monte Carlo otherwise.
function equityKnown(holes, board) {
  const used = new Set(board.map(c => c.id));
  holes.forEach(h => h.forEach(c => used.add(c.id)));
  const rem = createDeck().filter(c => !used.has(c.id));
  const need = 5 - board.length;
  const wins = new Array(holes.length).fill(0);
  let total = 0;

  function scoreRunout(extra) {
    const full = board.concat(extra);
    let best = null, ws = [];
    holes.forEach((h, i) => {
      const sc = bestHand(h.concat(full));
      if (!best || cmpScore(sc, best) > 0) { best = sc; ws = [i]; }
      else if (cmpScore(sc, best) === 0) ws.push(i);
    });
    ws.forEach(i => wins[i] += 1 / ws.length);
    total++;
  }

  if (need <= 0) scoreRunout([]);
  else if (need === 1) rem.forEach(c => scoreRunout([c]));
  else if (need === 2) {
    for (let i = 0; i < rem.length; i++)
      for (let j = i + 1; j < rem.length; j++) scoreRunout([rem[i], rem[j]]);
  } else {
    for (let s = 0; s < 800; s++) {
      const idxs = new Set();
      while (idxs.size < need) idxs.add((Math.random() * rem.length) | 0);
      scoreRunout([...idxs].map(i => rem[i]));
    }
  }
  return wins.map(w => total > 0 ? w / total : 0);
}

function betGTO(S, p, pot, sizeFrac) {
  const target = clampRaise(S, p, S.currentBet + Math.max(S.bb, Math.round(pot * sizeFrac)));
  if (target <= S.currentBet) return { action: S.currentBet - p.bet > 0 ? 'call' : 'check' };
  return { action: 'raise', amount: target };
}
function raiseGTO(S, p, pot, callAmt, value) {
  const frac = value ? (0.6 + Math.random() * 0.4) : (0.55 + Math.random() * 0.3);
  const target = clampRaise(S, p, S.currentBet + Math.round((pot + callAmt) * frac));
  if (target <= S.currentBet) return { action: 'call' };
  return { action: 'raise', amount: target };
}

// =====================================================================
// Preflop: position-aware opening ranges + 3-bets + short-stack push/fold.
// (Equity vs full ranges is the wrong tool preflop — it ignores fold equity,
//  so thresholds like E>0.70 are unreachable multiway and nobody ever raises.)
// =====================================================================
const OPEN_FRAC = { UTG: 0.13, HJ: 0.17, CO: 0.24, BTN: 0.40, SB: 0.34, BB: 0.45 };
const JAM_FRAC  = { UTG: 0.10, HJ: 0.13, CO: 0.17, BTN: 0.25, SB: 0.32, BB: 0.38 };

function preflopOpenRaise(S, p, limpers) {
  let target = Math.round((2.3 + 0.4 * limpers) * S.bb);
  if (target > (p.stack + p.bet) * 0.4) target = p.stack + p.bet; // committed → jam
  return { action: 'raise', amount: clampRaise(S, p, target) };
}
function preflopThreeBet(S, p) {
  let target = Math.round(S.currentBet * 2.8);
  if (target > (p.stack + p.bet) * 0.4) target = p.stack + p.bet;
  return { action: 'raise', amount: clampRaise(S, p, target) };
}

function cpuPreflopGTO(S, idx) {
  const p = S.players[idx];
  const per = p.personality || { tight: 0.5, aggression: 0.5, bluff: 0.15 };
  const callAmt = S.currentBet - p.bet;
  const pot = getPot(S);
  const r = Math.random();
  const top = holeTopFrac(p.holeCards);            // 0 = nuts ... 1 = trash
  const pos = S.positions[idx] || 'CO';
  const stackBB = (p.stack + p.bet) / S.bb;
  const styleMul = lerp(1.35, 0.7, per.tight);     // loose personalities play more hands
  const raised = S.aggrCount >= 1;

  // ---- short stack: push/fold ----
  if (stackBB <= 12) {
    let jam = (JAM_FRAC[pos] || 0.2) * styleMul * (1 + Math.max(0, 12 - stackBB) * 0.08);
    if (raised) jam *= 0.55;                       // calling/iso vs a raise needs a tighter range
    if (top <= jam && p.stack > 0) return { action: 'raise', amount: p.bet + p.stack };
    if (callAmt === 0) return { action: 'check' };
    if (callAmt <= S.bb && top <= 0.5) return { action: 'call' }; // priced in from the blinds
    return { action: 'fold' };
  }

  // ---- unopened pot (no raise yet; limps may exist) ----
  if (!raised) {
    if (callAmt === 0) {                           // BB option
      const raiseFrac = 0.12 * (0.5 + per.aggression) * styleMul;
      if (top <= raiseFrac) return preflopOpenRaise(S, p, 0);
      return { action: 'check' };
    }
    const limpers = Math.max(0, S.players.filter(q =>
      q !== p && q.inHand && !q.folded && q.bet >= S.bb).length - 1); // beyond the BB
    const openFrac = (OPEN_FRAC[pos] || 0.2) * styleMul;
    if (top <= openFrac) {
      if (r < (1 - per.aggression) * 0.3) return { action: 'call' }; // passive types limp some
      return preflopOpenRaise(S, p, limpers);
    }
    if (pos === 'SB' && top <= 0.5 && r < 0.7) return { action: 'call' }; // cheap complete
    const limpFrac = openFrac + lerp(0.22, 0.04, per.tight);
    if (top <= limpFrac && r < (1 - per.aggression) * 0.6) return { action: 'call' };
    return { action: 'fold' };
  }

  // ---- facing a raise / 3-bet ----
  if (callAmt === 0) return { action: 'check' };
  const firstRaise = S.aggrCount === 1;
  let threeBetFrac = (firstRaise ? lerp(0.07, 0.035, per.tight) : lerp(0.03, 0.012, per.tight))
    * (0.6 + per.aggression * 0.8);
  if (pos === 'SB') threeBetFrac *= 1.3;           // SB plays 3bet-or-fold (OOP all hand)
  if (top <= threeBetFrac) return preflopThreeBet(S, p);
  if (top > 0.5 && r < per.bluff * 0.10) return preflopThreeBet(S, p); // rare bluff 3-bet
  let callFrac = firstRaise ? lerp(0.30, 0.13, per.tight) : lerp(0.12, 0.05, per.tight);
  if (pos === 'BB' && firstRaise) callFrac *= 1.8; // closing action + discounted price → defend wide
  if (pos === 'SB') callFrac *= 0.8;               // OOP with dead money → flat less
  const potOdds = callAmt / (pot + callAmt);
  if (potOdds < 0.25) callFrac *= 1.25;            // good price → defend wider
  if (callAmt >= p.stack * 0.5) callFrac *= 0.5;   // huge bet → tighten up
  if (top <= callFrac) return { action: 'call' };
  return { action: 'fold' };
}

// Does this seat act last among the players still in the hand postflop?
// (Walk the seats once from the first-to-act; the last live seat encountered
//  closes the action — that player is "in position".)
function actsLastPostflop(S, idx) {
  const n = S.players.length;
  let i = (typeof S.postflopFirst === 'number') ? S.postflopFirst : 0;
  let last = idx;
  for (let k = 0; k < n; k++) {
    const p = S.players[i];
    if (p && p.inHand && !p.folded) last = i;
    i = (i + 1) % n;
  }
  return last === idx;
}

// Main CPU decision. Preflop uses range/position logic; postflop uses
// equity vs estimated ranges + pot odds + MDF + balanced bluffs.
function cpuActionGTO(S, idx) {
  if (S.street === 'preflop') return cpuPreflopGTO(S, idx);

  const p = S.players[idx];
  const per = p.personality || { tight: 0.5, aggression: 0.5, bluff: 0.15 };
  const callAmt = S.currentBet - p.bet;
  const pot = getPot(S);
  const r = Math.random();

  // opponents still live in the hand
  const opps = S.players.map((q, i) => ({ q, i }))
    .filter(x => x.i !== idx && x.q.inHand && !x.q.folded)
    .map(x => ({ idx: x.i, weightedKeys: buildWeightedKeys(S.ranges[x.i]) }));

  const E = opps.length === 0 ? handStrength(S, idx)
    : equityVsRanges(p.holeCards, S.community, opps, MC_SAMPLES);

  // a bluff has to get through every live opponent → discount it sharply multiway
  const mwDisc = Math.pow(0.45, Math.max(0, opps.length - 1));
  // in position = can realize equity better → bet more; OOP → check more
  const posMul = actsLastPostflop(S, idx) ? 1.2 : 0.85;

  // ---------- facing a bet ----------
  if (callAmt > 0) {
    const potOdds = callAmt / (pot + callAmt);
    // value raise with strong equity (threshold scales down multiway —
    // 70% equity 3-way is far stronger than 70% heads-up)
    const vrThr = Math.max(0.55, 0.70 - 0.06 * (opps.length - 1));
    if (E > vrThr && p.stack > callAmt && r < per.aggression) return raiseGTO(S, p, pot, callAmt, true);
    // balanced semi-bluff raise (needs fold equity); frequency scaled by bet/pot
    const sbFreq = callAmt / (pot + 2 * callAmt);
    if (E < 0.45 && p.stack > callAmt && S.community.length >= 3 && r < sbFreq * (0.5 + per.bluff) * mwDisc) return raiseGTO(S, p, pot, callAmt, false);
    // pot-odds defense, tilted by personality (tight needs more equity, loose calls lighter)
    const threshold = potOdds + (per.tight - 0.5) * 0.10;
    if (E >= threshold) return { action: 'call' };
    // calling stations peel small bets a bit below the line
    if (callAmt <= pot * 0.35 && E > potOdds * 0.75 && r < (1 - per.tight) * 0.5) return { action: 'call' };
    return { action: 'fold' };
  }

  // ---------- can check or bet ----------
  const sizeFrac = E > 0.82 ? 0.75 : 0.55;             // bigger with the nuts
  const valueThr = 0.55 + 0.03 * (opps.length - 1);    // need more value multiway
  if (E >= valueThr && r < (0.5 + per.aggression * 0.5) * posMul) return betGTO(S, p, pot, sizeFrac);
  // balanced bluff: bluff fraction of betting range = B/(P+2B) (opponent indifference)
  const B = pot * sizeFrac;
  const gtoBluff = B / (pot + 2 * B);
  if (E < 0.35 && r < gtoBluff * (0.6 + per.bluff) * posMul * mwDisc) return betGTO(S, p, pot, sizeFrac);
  return { action: 'check' };
}
