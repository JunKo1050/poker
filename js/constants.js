// =====================================================================
// Shared constants & state helpers
// (DOM-free: this file is shared between the browser client and the
//  Node.js game server. Game state is always passed in as `S`.)
// =====================================================================
const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_COLOR = { S: 'black', H: 'red', D: 'red', C: 'black' };
const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
function rl(r) { return RANK_LABEL[r] || String(r); }

const CPU_CHARS = [
  { name: 'さわっち',  img: 'sawachi.png' },
  { name: 'むらっち',  img: 'murachi.png' },
  { name: 'おのけん',  img: 'onoken.png' },
  { name: 'こば',      img: 'koba.png' },
  { name: 'ちなたつ',  img: 'chinatatu.png' },
  { name: 'まいっち',  img: 'maichi.png' },
  { name: 'のみちゃん', img: 'nomichan.png' },
  { name: 'ながちゃん', img: 'nagachan.png' },
  { name: 'ゆうり',    img: 'yuri.png?v=2' }, // ?v=2: 0バイト時代の壊れたキャッシュを回避
];

// CPU personalities
const PERSONALITIES = [
  { key: 'tag',  label: '堅実×攻', emoji: '🎯', tight: 0.64, aggression: 0.72, bluff: 0.12 },
  { key: 'lag',  label: '奔放×攻', emoji: '🔥', tight: 0.36, aggression: 0.82, bluff: 0.26 },
  { key: 'rock', label: '岩石',     emoji: '🪨', tight: 0.74, aggression: 0.24, bluff: 0.05 },
  { key: 'call', label: '追従',     emoji: '🐟', tight: 0.30, aggression: 0.18, bluff: 0.04 },
  { key: 'bal',  label: '均衡',     emoji: '⚖️', tight: 0.50, aggression: 0.50, bluff: 0.15 },
];

const STARTING_STACK = 30000;
const BASE_SB = 50;
const BASE_BB = 100;
const BLIND_UP_EVERY = 20;     // hands
const HAND_NAMES = ['ハイカード','ワンペア','ツーペア','スリーカード','ストレート','フラッシュ','フルハウス','フォーカード','ストレートフラッシュ'];

// Monte Carlo sample count for equity-vs-range (lower = faster, noisier)
let MC_SAMPLES = 180;

// =====================================================================
// Seat helpers (operate on a game-state object S)
// =====================================================================
function nextSeat(S, idx) { // next player still in this hand
  const n = S.players.length;
  let i = (idx + 1) % n, g = 0;
  while (!(S.players[i] && S.players[i].inHand)) { i = (i + 1) % n; if (++g > 2 * n) break; }
  return i;
}
function nextAliveSeat(S, idx) { // next player alive in tournament
  const n = S.players.length;
  let i = (idx + 1) % n, g = 0;
  while (!(S.players[i] && S.players[i].alive)) { i = (i + 1) % n; if (++g > 2 * n) break; }
  return i;
}
function getPot(S) { return S.players.reduce((s, p) => s + p.totalBet, 0); }
function contenders(S) { return S.players.filter(p => p.inHand && !p.folded); }
function canStillBet(S) { return contenders(S).filter(p => !p.allIn).length >= 2; }
