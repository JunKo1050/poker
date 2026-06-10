// =====================================================================
// Deck & Cards
// =====================================================================
function mkCard(suit, rank) { return { suit, rank, id: suit + rank }; }

function createDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (let rank = 2; rank <= 14; rank++)
      deck.push({ suit, rank, id: `${suit}${rank}` });
  return deck;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// =====================================================================
// Hand Evaluation (best 5 of up to 7)
// =====================================================================
function kcombos(n, k) {
  const res = [], combo = [];
  (function rec(start) {
    if (combo.length === k) { res.push(combo.slice()); return; }
    for (let i = start; i < n; i++) { combo.push(i); rec(i + 1); combo.pop(); }
  })(0);
  return res;
}
const COMBO_CACHE = {};
function combosFor(n) { return COMBO_CACHE[n] || (COMBO_CACHE[n] = kcombos(n, 5)); }

// returns score array [category, tiebreak...]; bigger = better
function evaluate5(cards) {
  const ranks = cards.map(c => c.rank).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  const distinct = [...new Set(ranks)].sort((a, b) => b - a);

  let straightHigh = 0;
  if (distinct.length >= 5) {
    for (let i = 0; i <= distinct.length - 5; i++) {
      if (distinct[i] - distinct[i + 4] === 4) { straightHigh = distinct[i]; break; }
    }
  }
  if (!straightHigh && distinct.includes(14) && distinct.includes(5) &&
      distinct.includes(4) && distinct.includes(3) && distinct.includes(2)) straightHigh = 5;

  const counts = {};
  ranks.forEach(r => counts[r] = (counts[r] || 0) + 1);
  const grouped = Object.entries(counts).map(([r, c]) => [parseInt(r), c])
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const counted = grouped.map(g => g[1]);
  const byRank = grouped.map(g => g[0]);

  if (isFlush && straightHigh) return [8, straightHigh];
  if (counted[0] === 4) return [7, byRank[0], byRank[1]];
  if (counted[0] === 3 && counted[1] >= 2) return [6, byRank[0], byRank[1]];
  if (isFlush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (counted[0] === 3) return [3, byRank[0], byRank[1], byRank[2]];
  if (counted[0] === 2 && counted[1] === 2) return [2, byRank[0], byRank[1], byRank[2]];
  if (counted[0] === 2) return [1, byRank[0], byRank[1], byRank[2], byRank[3]];
  return [0, ...ranks];
}
function cmpScore(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x - y; }
  return 0;
}
// best 5-card hand + which cards form it (for showdown highlighting)
function bestHandWithCards(cards) {
  if (cards.length < 5) return null;
  if (cards.length === 5) return { score: evaluate5(cards), hand: cards.slice() };
  let best = null, bestCards = null;
  for (const cb of combosFor(cards.length)) {
    const five = cb.map(i => cards[i]);
    const sc = evaluate5(five);
    if (!best || cmpScore(sc, best) > 0) { best = sc; bestCards = five; }
  }
  return { score: best, hand: bestCards };
}
function bestHand(cards) {
  const r = bestHandWithCards(cards);
  return r ? r.score : null;
}
function handDescription(sc) {
  if (!sc) return '';
  const cat = sc[0];
  if (cat === 8) return sc[1] === 14 ? 'ロイヤルフラッシュ' : `ストレートフラッシュ(${rl(sc[1])})`;
  if (cat === 7) return `フォーカード(${rl(sc[1])})`;
  if (cat === 6) return `フルハウス(${rl(sc[1])}/${rl(sc[2])})`;
  if (cat === 5) return `フラッシュ(${rl(sc[1])})`;
  if (cat === 4) return `ストレート(${rl(sc[1])})`;
  if (cat === 3) return `スリーカード(${rl(sc[1])})`;
  if (cat === 2) return `ツーペア(${rl(sc[1])}/${rl(sc[2])})`;
  if (cat === 1) return `ワンペア(${rl(sc[1])})`;
  return `ハイカード(${rl(sc[1])})`;
}
