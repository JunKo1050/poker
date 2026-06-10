// =====================================================================
// View layer (client only).
// Holds a local view-state `V` built purely from engine/server events,
// renders it, plays animations & sounds, and collects the player's input.
// It never reads engine internals — everything arrives through events,
// exactly as it will over Socket.IO in online mode.
// =====================================================================

// Game speed (all engine waits and client animations divide by this)
let GAME_SPEED = 1;
const SPEEDS = [1, 1.5, 2];
function delay(ms) { return new Promise(r => setTimeout(r, ms / GAME_SPEED)); }

const V = {
  mySeat: 0,
  myCards: [],
  players: [],          // public per-seat snapshots from `pub`
  community: [],
  pot: 0,
  street: 'idle',
  currentTurn: -1,
  handNum: 0,
  sb: BASE_SB, bb: BASE_BB,
  dealerIdx: 0,
  positions: {},
  equity: null,
  winningIds: null,     // Set of card ids (showdown highlight)
  dealing: false,
  reservedFold: false,
  _resolve: null,       // pending action resolver
  _opts: null,          // current action options (for the raise slider)
  _spectateResolve: null,
};

function applyPub(pub) {
  V.players = pub.players;
  V.community = pub.community;
  V.pot = pub.pot;
  V.street = pub.street;
  V.currentTurn = pub.currentTurn;
  V.handNum = pub.handNum;
  V.sb = pub.sb; V.bb = pub.bb;
  V.dealerIdx = pub.dealerIdx;
  V.positions = pub.positions;
  V.equity = pub.equity;
  if (pub.street === 'idle') V.winningIds = null;
}

function resetView() {
  V.myCards = []; V.players = []; V.community = []; V.pot = 0;
  V.street = 'idle'; V.currentTurn = -1; V.handNum = 0;
  V.sb = BASE_SB; V.bb = BASE_BB; V.equity = null; V.winningIds = null;
  V.dealing = false; V.reservedFold = false; V._resolve = null; V._opts = null;
}

// =====================================================================
// Event dispatcher — the single entry point for engine/server events
// =====================================================================
function handleGameEvent(ev) {
  // animations that need the OLD layout run before the state is applied
  if (ev.type === 'collect' && ev.bets) {
    Sound.chip();
    Object.entries(ev.bets).forEach(([seat, amt]) => flyBetToPot(+seat, amt));
  }

  if (ev.pub) applyPub(ev.pub);
  if (ev.private && ev.private[V.mySeat]) V.myCards = ev.private[V.mySeat];

  switch (ev.type) {
    case 'deal': {
      V.winningIds = null;
      V.reservedFold = false;
      V.dealing = true;
      renderAll();
      log(`ハンド#${V.handNum}開始 (${ev.dealerName}がディーラー)`);
      animateDeal(ev.dealOrder).then(() => { V.dealing = false; renderAll(); });
      break;
    }
    case 'turn':
      renderAll();
      break;
    case 'action_done': {
      const label = ev.label;
      if (label === 'フォールド') Sound.fold();
      else if (label === 'チェック') Sound.check();
      else if (label === 'オールイン') Sound.allin();
      else Sound.chip();
      renderAll();
      showActionBannerFor(ev.seat, label, ev.amount);
      if (ev.fly) flyChipsToBet(ev.seat);
      break;
    }
    case 'collect':
      renderAll();
      break;
    case 'street': {
      Sound.cardPlay();
      renderAll();
      animateStreetReveal(ev.added);
      break;
    }
    case 'runout':
      renderAll();
      flipRevealedHoleCards();
      showAllInReveal();
      break;
    case 'equity_update':
      renderAll();
      break;
    case 'showdown':
      renderAll();
      if (ev.firstReveal) flipRevealedHoleCards();
      break;
    case 'award': {
      V.winningIds = new Set(ev.winningIds || []);
      renderAll();
      ev.winners.forEach(i => { flyPotToWinner(i, ev.amount); sparkleAt(i); });
      showWinnerPot(ev.text);
      Sound.win();
      if (ev.uncontested) log(ev.text.replace('！', ''));
      (ev.summary || []).forEach(ws => log(`${ws.names} 勝ち (${ws.desc}) +${ws.amount}`));
      break;
    }
    case 'elimination':
      renderAll();
      ev.seats.forEach(seat => {
        log(`💀 ${V.players[seat].name} が脱落`);
        showEliminationStamp(seat);
      });
      break;
    case 'blind_up': {
      toast(`⬆️ ブラインド上昇！ SB${ev.sb} / BB${ev.bb}`, 2600);
      log(`ブラインド上昇: SB${ev.sb} / BB${ev.bb}`);
      const badge = document.getElementById('blind-badge');
      badge.className = 'state-badge up';
      setTimeout(() => { badge.className = 'state-badge blind'; }, 3000);
      renderAll();
      break;
    }
    case 'note':
      log(ev.msg);
      renderAll();
      break;
    case 'tournament_end':
      showFinalResult(ev);
      break;
    default:
      renderAll();
  }
}

// =====================================================================
// Player input
// =====================================================================
// Called when it's our turn (locally by the engine hook; online by the
// socket layer on `action_request`). Resolves to {action, amount}.
async function requestAction(options) {
  if (V.reservedFold) {
    V.reservedFold = false;
    updateReserveBtn();
    await delay(350);
    return options.canCheck ? { action: 'check' } : { action: 'fold' };
  }
  return new Promise(resolve => {
    V._resolve = resolve;
    V._opts = options;
    showBetControls(options);
  });
}

function finishHumanAction(action, amount) {
  if (!V._resolve) return;
  const res = V._resolve;
  V._resolve = null;
  V._opts = null;
  document.getElementById('action-area').style.display = 'none';
  res({ action, amount });
}

function showBetControls(o) {
  const area = document.getElementById('action-area');
  area.style.display = 'flex';
  area.innerHTML = '';
  area.classList.remove('appear'); void area.offsetWidth; area.classList.add('appear');
  Sound.myTurn();

  // pot odds readout when facing a bet
  if (!o.canCheck) {
    const oi = document.createElement('div');
    oi.className = 'odds-info';
    const oddsPct = Math.round(o.callAmt / (o.pot + o.callAmt) * 100);
    const ratio = (o.pot / o.callAmt).toFixed(1);
    oi.innerHTML = `コール <b>${Math.min(o.callAmt, o.stack).toLocaleString()}</b>・ポットオッズ <b>${oddsPct}%</b>（${ratio} : 1）・ポット ${o.pot.toLocaleString()}`;
    area.appendChild(oi);
  }

  // Quick bet buttons + slider
  if (o.canRaise) {
    const qb = document.createElement('div');
    qb.className = 'quick-bets';
    const presets = [];
    presets.push({ label: 'ミニ', to: o.minRaiseTo });
    const halfPot = o.currentBet + Math.round((o.pot + o.callAmt) * 0.5);
    const fullPot = o.currentBet + (o.pot + o.callAmt);
    if (halfPot > o.minRaiseTo && halfPot < o.maxTotal) presets.push({ label: '½ポット', to: halfPot });
    if (fullPot > o.minRaiseTo && fullPot < o.maxTotal) presets.push({ label: 'ポット', to: fullPot });
    presets.push({ label: 'オールイン', to: o.maxTotal });
    presets.forEach(pr => {
      const b = document.createElement('button');
      b.textContent = pr.label;
      b.onclick = () => { const s = document.getElementById('raise-slider'); s.value = Math.min(Math.max(pr.to, o.minRaiseTo), o.maxTotal); updateRaiseAmount(); };
      qb.appendChild(b);
    });
    area.appendChild(qb);

    const row = document.createElement('div');
    row.className = 'raise-row';
    row.innerHTML = `
      <input type="range" id="raise-slider" min="${o.minRaiseTo}" max="${o.maxTotal}" step="${Math.max(1, Math.round(o.bb / 2))}" value="${o.minRaiseTo}">
      <span class="raise-amount-wrap">
        <span class="raise-amount" id="raise-amount"></span>
        <span class="raise-sub" id="raise-sub"></span>
      </span>`;
    area.appendChild(row);
    row.querySelector('#raise-slider').addEventListener('input', updateRaiseAmount);
    updateRaiseAmount();
  }

  // action buttons
  const btns = document.createElement('div');
  btns.className = 'action-btns';

  const foldBtn = document.createElement('button');
  foldBtn.className = 'btn-fold';
  const foldLabel = `フォールド<span class="btn-hint">F</span>`;
  foldBtn.innerHTML = foldLabel;
  foldBtn.onclick = () => {
    // guard: don't throw away a free check on a misclick
    if (o.canCheck && foldBtn.dataset.confirm !== '1') {
      foldBtn.dataset.confirm = '1';
      foldBtn.classList.add('confirm');
      foldBtn.innerHTML = `本当に？<span class="btn-hint">F</span>`;
      toast('チェックできます（もう一度押すとフォールド）', 1800);
      setTimeout(() => {
        if (!foldBtn.isConnected) return;
        foldBtn.dataset.confirm = '';
        foldBtn.classList.remove('confirm');
        foldBtn.innerHTML = foldLabel;
      }, 2500);
      return;
    }
    finishHumanAction('fold');
  };
  btns.appendChild(foldBtn);

  const callBtn = document.createElement('button');
  callBtn.className = 'btn-call';
  if (o.canCheck) { callBtn.innerHTML = `チェック<span class="btn-hint">C</span>`; callBtn.onclick = () => finishHumanAction('check'); }
  else {
    const allInCall = o.callAmt >= o.stack;
    callBtn.innerHTML = `${allInCall ? 'オールインでコール' : 'コール'} <span style="color:var(--highlight)">${Math.min(o.callAmt, o.stack).toLocaleString()}</span><span class="btn-hint">C</span>`;
    callBtn.onclick = () => finishHumanAction('call');
  }
  btns.appendChild(callBtn);

  if (o.canRaise) {
    const raiseBtn = document.createElement('button');
    raiseBtn.className = 'btn-raise';
    raiseBtn.id = 'raise-btn';
    raiseBtn.innerHTML = `${o.currentBet === 0 ? 'ベット' : 'レイズ'}<span class="btn-hint">R</span>`;
    raiseBtn.onclick = () => {
      const v = parseInt(document.getElementById('raise-slider').value);
      finishHumanAction('raise', v);
    };
    btns.appendChild(raiseBtn);
  }
  area.appendChild(btns);
}

function updateRaiseAmount() {
  const s = document.getElementById('raise-slider');
  const lbl = document.getElementById('raise-amount');
  const sub = document.getElementById('raise-sub');
  const o = V._opts;
  if (!s || !lbl || !o) return;
  const v = parseInt(s.value);
  const max = parseInt(s.max);
  lbl.textContent = (v >= max ? 'オールイン ' : '') + v.toLocaleString();
  if (sub) {
    const bbCount = (v / o.bb).toFixed(1);
    const pct = o.pot > 0 ? Math.round((v - o.currentBet) / o.pot * 100) : 0;
    sub.textContent = `= ${bbCount}BB・ポットの約${pct}%`;
  }
}

// Reserve check/fold toggle — visible only while waiting for other players.
function updateReserveBtn() {
  const btn = document.getElementById('btn-reserve');
  if (!btn) return;
  const me = V.players[V.mySeat];
  const betting = ['preflop', 'flop', 'turn', 'river'].includes(V.street);
  const waiting = betting && me && me.alive && me.inHand && !me.folded && !me.allIn &&
    !V.dealing && V.currentTurn !== V.mySeat && !V._resolve;
  btn.style.display = waiting ? '' : 'none';
  btn.classList.toggle('active', V.reservedFold);
  btn.textContent = V.reservedFold ? '✓ 予約中：チェック/フォールド' : '予約：チェック/フォールド';
}

// Spectate-or-leave modal when the local player busts.
function askSpectateOrLeave(place) {
  return new Promise(resolve => {
    Sound.lose();
    document.getElementById('eliminated-desc').innerHTML =
      `チップが尽きました。<b>${place}位</b>で脱落です。<br>残りの対戦を観戦しますか？`;
    document.getElementById('modal-eliminated').classList.add('show');
    V._spectateResolve = resolve;
  });
}
function chooseSpectate() {
  document.getElementById('modal-eliminated').classList.remove('show');
  toast('観戦モード：最後の1人まで自動で進行します', 2800);
  if (V._spectateResolve) { V._spectateResolve('spectate'); V._spectateResolve = null; }
}
function chooseLeave() {
  document.getElementById('modal-eliminated').classList.remove('show');
  if (V._spectateResolve) { V._spectateResolve('leave'); V._spectateResolve = null; }
}

// =====================================================================
// Rendering (reads only V)
// =====================================================================
function renderCard(card, opts = {}) {
  const div = document.createElement('div');
  const cls = ['card', SUIT_COLOR[card.suit]];
  if (opts.field) cls.push('field-card');
  if (opts.mini) cls.push('hole-mini');
  if (opts.dim) cls.push('dim');
  div.className = cls.join(' ');
  const sym = SUIT_SYM[card.suit], lbl = rl(card.rank);
  if (opts.mini) div.innerHTML = `<div class="corner">${lbl}<br>${sym}</div><div class="suit-center">${sym}</div>`;
  else div.innerHTML = `<div class="corner">${lbl}<br>${sym}</div><div class="suit-center">${sym}</div><div class="corner br">${lbl}<br>${sym}</div>`;
  return div;
}
// showdown highlight: glow the winning 5 cards.
// Only community cards get dimmed (dimOthers) — losers' hole cards stay readable.
function applyShowdownHighlight(el, cardId, dimOthers = false) {
  if (!V.winningIds) return;
  if (V.winningIds.has(cardId)) el.classList.add('win-glow');
  else if (dimOthers) el.classList.add('dim-out');
}

function getSeatPositions() {
  return ['pos-bottom', 'pos-bottom-left', 'pos-top-left', 'pos-top', 'pos-top-right', 'pos-bottom-right'];
}
// Map an absolute seat index to a screen position so that *my* seat is
// always bottom-centre (online seats rotate; CPU mode mySeat=0 is identity).
function seatToScreen(i) {
  const n = V.players.length || 6;
  return (i - V.mySeat + n) % n;
}

function renderPlayers() {
  const table = document.getElementById('table');
  table.querySelectorAll('.player').forEach(el => el.remove());
  const positions = getSeatPositions();

  V.players.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = `player ${positions[seatToScreen(i)]}`;
    div.id = `player-${i}`;
    if (i === V.currentTurn && p.inHand && !p.folded && p.alive) div.classList.add('is-turn');
    if (!p.alive) div.classList.add('is-out');
    else if (p.folded) div.classList.add('is-folded');
    if (p.isWinner) div.classList.add('is-winner');

    const dealerBadge = (p.alive && i === V.dealerIdx) ? `<div class="dealer-btn">D</div>` : '';
    const betChip = (p.bet > 0) ? `<div class="bet-chip">${chipStackHtml(p.bet, 3)}<span class="chip-amt">${p.bet}</span></div>` : '';
    const handChips = (p.alive && p.stack > 0) ? `<div class="hand-chips">${chipStackHtml(p.stack, 5)}</div>` : '';
    const posName = (p.alive && p.inHand) ? V.positions[i] : '';
    const posCls = posName === 'BTN' ? 'btn' : posName === 'SB' ? 'sb' : posName === 'BB' ? 'bb' : '';
    const posBadge = posName ? `<div class="pos-label ${posCls}">${posName}</div>` : '';
    const eqBadge = (V.equity && V.equity[i] != null && p.inHand && !p.folded)
      ? `<div class="equity-badge">${V.equity[i]}%</div>` : '';
    const thinkDots = (i === V.currentTurn && i !== V.mySeat && p.inHand && !p.folded && p.alive)
      ? `<div class="think-dots"><span></span><span></span><span></span></div>` : '';

    // status label
    let status = '';
    if (!p.alive) status = `<div class="status-label fold">脱落</div>`;
    else if (p.folded) status = `<div class="status-label fold">フォールド</div>`;
    else if (p.isWinner) status = `<div class="status-label win">WIN</div>`;
    else if (p.allIn) status = `<div class="status-label allin">オールイン</div>`;
    else if (p.lastAction) status = `<div class="status-label act">${p.lastAction}</div>`;

    // hole cards (other players)
    let holeHtml = '';
    if (i !== V.mySeat) {
      if (p.alive && p.inHand && !p.folded && !V.dealing) {
        if (p.revealed && p.cards && p.cards.length === 2) {
          holeHtml = `<div class="hole-row" id="hole-${i}"></div>`;
        } else {
          holeHtml = `<div class="hole-row"><div class="card-back-mini"></div><div class="card-back-mini"></div></div>`;
        }
      } else {
        holeHtml = `<div class="hole-row"></div>`;
      }
    }

    const styleTag = (i !== V.mySeat && p.personality)
      ? `<div class="style-tag">${p.personality.emoji} ${p.personality.label}</div>` : '';

    div.innerHTML = `
      ${posBadge}
      ${dealerBadge}
      ${betChip}
      ${handChips}
      ${eqBadge}
      ${thinkDots}
      <img class="player-avatar" src="${p.img}" alt="${p.name}">
      <div class="name">${p.name}</div>
      <div class="stack">${p.alive ? p.stack.toLocaleString() : '—'}</div>
      ${styleTag}
      ${status}
      ${holeHtml}
    `;
    table.appendChild(div);

    if (i !== V.mySeat && p.revealed && p.cards && p.cards.length === 2 && p.alive && !p.folded) {
      const row = div.querySelector(`#hole-${i}`);
      if (row) p.cards.forEach(c => {
        const el = renderCard(c, { mini: true });
        applyShowdownHighlight(el, c.id);
        row.appendChild(el);
      });
    }
  });
}

function renderHumanHand() {
  const handEl = document.getElementById('hand');
  const labelEl = document.getElementById('made-hand-label');
  handEl.innerHTML = '';
  const me = V.players[V.mySeat];
  if (!me || !me.alive || V.myCards.length === 0 || V.dealing) {
    labelEl.style.display = 'none';
    return;
  }
  const folded = me.folded;
  V.myCards.forEach(c => {
    const el = renderCard(c, { dim: folded });
    if (!folded) applyShowdownHighlight(el, c.id);
    handEl.appendChild(el);
  });

  if (V.community.length >= 3 && !folded) {
    const sc = bestHand([...V.myCards, ...V.community]);
    labelEl.textContent = '現在の役: ' + handDescription(sc);
    labelEl.style.display = '';
  } else if (folded) {
    labelEl.textContent = 'フォールド';
    labelEl.style.display = '';
  } else {
    labelEl.style.display = 'none';
  }
}

function renderCommunity() {
  const fieldEl = document.getElementById('field-area');
  fieldEl.innerHTML = '';
  if (V.community.length === 0) {
    fieldEl.classList.add('empty-field');
    fieldEl.innerHTML = '<div style="color:rgba(255,255,255,0.3);font-size:13px;font-family:var(--cute-font)">コミュニティカード</div>';
    return;
  }
  fieldEl.classList.remove('empty-field');
  V.community.forEach(c => {
    const el = renderCard(c, { field: true });
    applyShowdownHighlight(el, c.id, true);
    fieldEl.appendChild(el);
  });
}

// spread/flip animation for the newest `added` community cards
function animateStreetReveal(added) {
  const fieldEl = document.getElementById('field-area');
  if (!fieldEl || !added) return;
  const cards = fieldEl.querySelectorAll('.field-card');
  const start = V.community.length - added;
  const center = (added - 1) / 2;
  for (let k = 0; k < added; k++) {
    const el = cards[start + k];
    if (!el) continue;
    el.style.setProperty('--tx', ((center - k) * 70) + 'px');
    el.style.animationDelay = (k * 110) + 'ms';
    el.classList.add('revealing');
  }
}

function renderPotInfo() {
  const el = document.getElementById('pot-info');
  const streetEl = document.getElementById('street-info');
  streetEl.style.display = 'none'; // street name lives inside the pot pill
  const streetNames = { preflop: 'プリフロップ', flop: 'フロップ', turn: 'ターン', river: 'リバー', showdown: 'ショーダウン' };
  if (V.street === 'idle') { el.style.display = 'none'; return; }
  const sn = streetNames[V.street];
  el.innerHTML = `<span class="pot-label">${sn ? sn + '・' : ''}ポット</span><span class="pot-value">${V.pot.toLocaleString()}</span>`;
  el.style.display = 'block';
  const prev = +el.dataset.pot || 0;
  if (V.pot > prev) { el.classList.remove('pot-pop'); void el.offsetWidth; el.classList.add('pot-pop'); }
  el.dataset.pot = V.pot;
}

function renderTopbar() {
  document.getElementById('hand-display').textContent = V.handNum;
  const badge = document.getElementById('blind-badge');
  const handsLeft = V.handNum === 0 ? BLIND_UP_EVERY : BLIND_UP_EVERY - ((V.handNum - 1) % BLIND_UP_EVERY);
  badge.innerHTML = `SB ${V.sb} / BB ${V.bb}<span class="bc">UPまで${handsLeft}</span>`;
  badge.classList.toggle('soon', handsLeft <= 3 && V.handNum > 0);
}

function renderScoreboard() {
  const el = document.getElementById('scoreboard');
  el.innerHTML = '<h3>スタック</h3>';
  const sorted = V.players.map((p, i) => ({ p, i }))
    .sort((a, b) => (b.p.alive - a.p.alive) || (b.p.stack - a.p.stack));
  sorted.forEach(({ p, i }) => {
    const row = document.createElement('div');
    row.className = 'sc-row' + (i === V.mySeat ? ' human-row' : '') + (!p.alive ? ' out-row' : '');
    row.innerHTML = `<span>${p.name}</span><span><b>${p.alive ? p.stack.toLocaleString() : '脱落'}</b></span>`;
    el.appendChild(row);
  });
}

function renderAll() {
  renderTopbar();
  renderPlayers();
  renderCommunity();
  renderHumanHand();
  renderScoreboard();
  renderPotInfo();
  updateReserveBtn();
}

// =====================================================================
// Log / Toast / Banner
// =====================================================================
const MAX_LOGS = 6;
function log(msg, who = null, isHuman = false) {
  const panel = document.getElementById('log-panel');
  const div = document.createElement('div');
  div.className = 'log-line';
  if (who) div.innerHTML = `<span class="lname ${isHuman ? 'you' : 'cpu'}">${who}</span>: ${msg}`;
  else div.textContent = msg;
  panel.appendChild(div);
  while (panel.children.length > MAX_LOGS) panel.removeChild(panel.firstChild);
}
function toast(msg, duration = 2000) {
  const area = document.getElementById('toast-area');
  const div = document.createElement('div');
  div.className = 'toast'; div.textContent = msg;
  area.appendChild(div);
  setTimeout(() => div.remove(), duration);
}

function showActionBannerFor(seat, label, amount) {
  let html = '';
  if (label === 'フォールド') html = `<span class="fold-label">フォールド</span>`;
  else if (label === 'チェック') html = `チェック`;
  else if (label === 'コール') html = `コール <span class="amt">${amount}</span>`;
  else if (label === 'ベット') html = `ベット <span class="amt">${amount}</span>`;
  else if (label === 'レイズ') html = `レイズ <span class="amt">${amount}</span>`;
  else if (label === 'オールイン') html = `🔥 オールイン <span class="amt">${amount}</span>`;
  else return;
  showActionBanner(seat, html, Math.round(1800 / GAME_SPEED));
  const p = V.players[seat];
  log(label + (amount > 0 && label !== 'フォールド' && label !== 'チェック' ? ` ${amount}` : ''), p.name, seat === V.mySeat);
}

function showActionBanner(playerIdx, actionHtml, duration = 1800) {
  document.querySelectorAll('.speech-bubble').forEach(el => { if (el._t) clearTimeout(el._t); el.remove(); });
  const p = V.players[playerIdx];
  const bubble = document.createElement('div');
  bubble.className = 'speech-bubble';
  bubble.innerHTML = `
    <div class="sb-tail"></div>
    <img class="sb-avatar" src="${p.img}" alt="${p.name}">
    <div class="sb-text">
      <div class="sb-name">${p.name}</div>
      <div class="sb-action">${actionHtml}</div>
    </div>`;
  document.body.appendChild(bubble);

  const seat = document.getElementById('player-' + playerIdx);
  const anchorEl = seat ? (seat.querySelector('.player-avatar') || seat) : null;
  const vw = window.innerWidth, vh = window.innerHeight;
  const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
  let cx = vw / 2, anchorTop = vh / 2, anchorBottom = vh / 2;
  if (anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    cx = r.left + r.width / 2;
    anchorTop = r.top; anchorBottom = r.bottom;
  }
  const below = anchorTop < vh * 0.5;
  bubble.classList.add(below ? 'below' : 'above');
  const gap = 14, margin = 8;
  let top = below ? anchorBottom + gap : anchorTop - gap - bh;
  let left = cx - bw / 2;
  // centre-column seats: shift the bubble sideways so it doesn't cover the pot / community cards
  if (Math.abs(cx - vw / 2) < 130) {
    if (below) {
      left = cx - bw - 40;             // top-centre seat → to the left of the pot
    } else {
      left = cx + 150;                 // bottom-centre seat → beside the avatar,
      top = anchorTop - bh + 36;       //   kept below the community cards
    }
  }
  left = Math.max(margin, Math.min(left, vw - bw - margin));
  top = Math.max(margin, Math.min(top, vh - bh - margin));
  bubble.style.left = left + 'px';
  bubble.style.top = top + 'px';
  const tail = bubble.querySelector('.sb-tail');
  const tailX = Math.max(14, Math.min(cx - left, bw - 14));
  tail.style.left = (tailX - 7) + 'px';

  bubble._t = setTimeout(() => { if (!bubble.parentNode) return; bubble.classList.add('exit'); setTimeout(() => bubble.remove(), 300); }, duration);
}

// ----- Poker chip illustrations -----
function chipTier(amount) {
  if (amount >= 10000) return 'tier-gold';
  if (amount >= 2000)  return 'tier-black';
  if (amount >= 500)   return 'tier-purple';
  if (amount >= 200)   return 'tier-blue';
  if (amount >= 100)   return 'tier-green';
  return 'tier-red';
}
function chipGrad(tier) {
  return {
    'tier-red': 'radial-gradient(circle at 50% 34%, #ff8a8a, #d62828)',
    'tier-green': 'radial-gradient(circle at 50% 34%, #74e6a6, #1b9e54)',
    'tier-blue': 'radial-gradient(circle at 50% 34%, #79bbff, #1565c0)',
    'tier-purple': 'radial-gradient(circle at 50% 34%, #cf9bff, #7b1fa2)',
    'tier-black': 'radial-gradient(circle at 50% 34%, #5a5a5a, #111)',
    'tier-gold': 'radial-gradient(circle at 50% 34%, #ffe9a8, #b8860b)',
  }[tier];
}
function chipStackHtml(amount, max = 3) {
  const tier = chipTier(amount);
  const mag = amount >= 10000 ? 5 : amount >= 2000 ? 4 : amount >= 500 ? 3 : 2;
  const n = Math.max(1, Math.min(max, mag));
  const step = 4;
  let chips = '';
  for (let i = 0; i < n; i++) {
    chips += `<span class="chip-ico ${tier}" style="bottom:${i * step}px"></span>`;
  }
  return `<span class="chip-stack" style="width:16px;height:${16 + (n - 1) * step}px">${chips}</span>`;
}

// ----- Flying chips -----
function flyChipBurst(fromX, fromY, toX, toY, tier, n = 4, dur = 480) {
  const grad = chipGrad(tier);
  for (let i = 0; i < n; i++) {
    const chip = document.createElement('div');
    chip.className = 'fly-chip';
    chip.style.background = grad;
    chip.style.left = fromX + 'px';
    chip.style.top = fromY + 'px';
    document.body.appendChild(chip);
    const jx = (Math.random() - 0.5) * 18, jy = (Math.random() - 0.5) * 12;
    const arc = -18 - Math.random() * 14;
    const dx = toX - fromX + jx, dy = toY - fromY + jy;
    chip.animate([
      { transform: 'translate(0,0) scale(0.6)', opacity: 0 },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 + arc}px) scale(1)`, opacity: 1, offset: 0.5 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.9)`, opacity: 1 },
    ], { duration: dur, delay: i * 55, easing: 'cubic-bezier(0.4,0,0.25,1)', fill: 'forwards' });
    setTimeout(() => chip.remove(), dur + i * 55 + 60);
  }
}

function flyChipsToBet(idx) {
  const seat = document.getElementById('player-' + idx);
  if (!seat) return;
  const avatar = seat.querySelector('.player-avatar');
  const betEl = seat.querySelector('.bet-chip');
  if (!avatar || !betEl) return;
  const a = avatar.getBoundingClientRect();
  const b = betEl.getBoundingClientRect();
  flyChipBurst(
    a.left + a.width * 0.5, a.top + a.height * 0.66,
    b.left + b.width * 0.5, b.top + b.height * 0.5,
    chipTier(V.players[idx].bet || 100), 4, 480);
}

function potAnchorEl() {
  const pot = document.getElementById('pot-info');
  if (pot && pot.style.display !== 'none') return pot;
  return document.getElementById('field-area');
}
function flyBetToPot(idx, amount) {
  const seat = document.getElementById('player-' + idx);
  const betEl = seat ? seat.querySelector('.bet-chip') : null;
  const tEl = potAnchorEl();
  if (!betEl || !tEl) return;
  const b = betEl.getBoundingClientRect(), t = tEl.getBoundingClientRect();
  flyChipBurst(
    b.left + b.width / 2, b.top + b.height / 2,
    t.left + t.width / 2, t.top + t.height / 2,
    chipTier(amount), 3, 430);
}
function flyPotToWinner(idx, amount) {
  const src = potAnchorEl();
  const seat = document.getElementById('player-' + idx);
  const av = seat ? seat.querySelector('.player-avatar') : null;
  if (!src || !av) return;
  const s = src.getBoundingClientRect(), a = av.getBoundingClientRect();
  flyChipBurst(
    s.left + s.width / 2, s.top + s.height / 2,
    a.left + a.width / 2, a.top + a.height * 0.6,
    chipTier(amount), 6, 560);
}

// ----- Celebration / stamps / flips -----
function sparkleAt(idx, n = 10) {
  const seat = document.getElementById('player-' + idx);
  const av = seat ? seat.querySelector('.player-avatar') : null;
  if (!av) return;
  const r = av.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  for (let i = 0; i < n; i++) {
    const s = document.createElement('div');
    s.className = 'sparkle';
    s.textContent = '✦';
    s.style.left = cx + 'px'; s.style.top = cy + 'px';
    document.body.appendChild(s);
    const ang = (Math.PI * 2 * i) / n + Math.random() * 0.5;
    const dist = 40 + Math.random() * 50;
    s.animate([
      { transform: 'translate(0,0) scale(0.4)', opacity: 1 },
      { transform: `translate(${Math.cos(ang) * dist}px, ${Math.sin(ang) * dist}px) scale(1.1)`, opacity: 1, offset: 0.6 },
      { transform: `translate(${Math.cos(ang) * dist * 1.4}px, ${Math.sin(ang) * dist * 1.4}px) scale(0.2)`, opacity: 0 },
    ], { duration: 800 + Math.random() * 300, easing: 'ease-out', fill: 'forwards' });
    setTimeout(() => s.remove(), 1300);
  }
}

function showEliminationStamp(idx) {
  const seat = document.getElementById('player-' + idx);
  if (!seat) return;
  const r = seat.getBoundingClientRect();
  const div = document.createElement('div');
  div.className = 'elim-stamp';
  div.textContent = '💀 脱落';
  div.style.left = (r.left + r.width / 2) + 'px';
  div.style.top = (r.top + r.height * 0.4) + 'px';
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 2100);
}

function flipRevealedHoleCards() {
  document.querySelectorAll('.hole-row .card').forEach((el, k) => {
    el.classList.add('flip-in');
    el.style.animationDelay = (k * 70) + 'ms';
  });
}

// ----- Deal animation -----
function animateDeal(order) {
  return new Promise(resolve => {
    const fieldEl = document.getElementById('field-area');
    if (!fieldEl || !order || order.length === 0) { resolve(); return; }
    const src = fieldEl.getBoundingClientRect();
    const srcX = src.left + src.width / 2, srcY = src.top + src.height / 2;
    const W = 40, H = 56;
    const n = order.length;

    const flyMs = Math.round(360 / GAME_SPEED);
    const staggerMs = Math.round(80 / GAME_SPEED);
    const seen = {};
    let settled = 0;
    order.forEach((seat, i) => {
      const which = (seen[seat] = (seen[seat] || 0) + 1) - 1;
      let destX, destY;
      if (seat === V.mySeat) {
        // aim at where the cards will actually render inside the hand area
        const ha = document.getElementById('hand-area').getBoundingClientRect();
        destX = ha.left + ha.width / 2 + (which === 0 ? -38 : 38);
        destY = ha.bottom - 72;
      } else {
        const el = document.getElementById('player-' + seat);
        const r = el ? el.getBoundingClientRect() : src;
        destX = r.left + r.width / 2 + (which === 0 ? -10 : 10);
        destY = r.top + r.height * 0.78;
      }
      const w = document.createElement('div');
      w.className = 'flying-card-wrapper flying-card-back';
      w.style.cssText = `width:${W}px;height:${H}px;left:${srcX - W / 2}px;top:${srcY - H / 2}px;`;
      document.body.appendChild(w);

      const stagger = i * staggerMs;
      setTimeout(() => {
        Sound.cardPlay();
        w.style.transition = `left ${flyMs}ms cubic-bezier(0.22,1,0.36,1), top ${flyMs}ms cubic-bezier(0.22,1,0.36,1), transform ${flyMs}ms`;
        w.style.left = (destX - W / 2) + 'px';
        w.style.top = (destY - H / 2) + 'px';
        w.style.transform = 'scale(1.04) rotate(' + (which === 0 ? -3 : 3) + 'deg)';
        setTimeout(() => { w.remove(); if (++settled === n) resolve(); }, flyMs + 20);
      }, stagger + 10);
    });
  });
}

// ----- All-in reveal overlay -----
function showAllInReveal() {
  return new Promise(resolve => {
    const cont = V.players.map((p, i) => ({ p, i })).filter(x => x.p.inHand && !x.p.folded);
    if (cont.length < 2) { resolve(); return; }
    Sound.allin();
    const ov = document.createElement('div');
    ov.className = 'allin-overlay';
    ov.innerHTML = `<div class="allin-title">🔥 ALL IN !</div>`;
    const row = document.createElement('div');
    row.className = 'allin-row';
    cont.forEach(({ p, i }, k) => {
      const panel = document.createElement('div');
      panel.className = 'allin-player';
      panel.style.animationDelay = (k * 130) + 'ms';
      panel.innerHTML = `<img src="${p.img}" alt="${p.name}"><div class="ap-name">${p.name}</div>`;
      const cardsEl = document.createElement('div');
      cardsEl.className = 'allin-cards';
      const cards = (i === V.mySeat) ? V.myCards : (p.cards || []);
      cards.forEach(c => cardsEl.appendChild(renderCard(c)));
      panel.appendChild(cardsEl);
      const eq = document.createElement('div');
      eq.className = 'allin-eq';
      eq.textContent = (V.equity && V.equity[i] != null) ? V.equity[i] + '%' : '';
      panel.appendChild(eq);
      row.appendChild(panel);
    });
    ov.appendChild(row);
    document.body.appendChild(ov);
    setTimeout(() => {
      ov.classList.add('exit');
      setTimeout(() => { ov.remove(); resolve(); }, 350);
    }, 2600 / GAME_SPEED);
  });
}

// ----- Final result -----
function showWinnerPot(text) {
  const div = document.createElement('div');
  div.className = 'winner-pot';
  div.textContent = '🏆 ' + text;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 2400);
}

function showFinalResult(ev) {
  Sound.fanfare();
  const overlay = document.getElementById('final-overlay');
  overlay.classList.add('show');
  const list = document.getElementById('final-list');
  list.innerHTML = '';

  const title = document.getElementById('final-title');
  const mine = ev.standings.find(s => s.seat === V.mySeat);
  const myPlace = mine ? mine.place : 0;
  if (ev.quit) title.textContent = 'トーナメント終了';
  else title.textContent = (myPlace === 1 ? '🏆 優勝！' : `${myPlace}位`);

  const rankNums = ['🥇 1位', '🥈 2位', '🥉 3位', '4位', '5位', '6位'];
  ev.standings.forEach((st, pos) => {
    const entry = document.createElement('div');
    entry.className = 'final-entry' + (st.seat === V.mySeat ? ' is-human' : '');
    entry.innerHTML = `
      <div class="fe-rank">${rankNums[pos] || (pos + 1) + '位'}</div>
      <img src="${st.img}" alt="${st.name}">
      <div class="fe-name">${st.name}</div>
      <div class="fe-score">${st.alive ? st.stack.toLocaleString() + '点' : '脱落'}</div>`;
    list.appendChild(entry);
    setTimeout(() => entry.classList.add('show'), 300 + pos * 350);
  });
  spawnConfetti();
}

function spawnConfetti() {
  const colors = ['#d4af37', '#ff6b6b', '#4fc3f7', '#81c784', '#ce93d8', '#ffd54f'];
  for (let i = 0; i < 50; i++) {
    setTimeout(() => {
      const div = document.createElement('div');
      div.className = 'confetti-piece';
      div.style.left = Math.random() * 100 + 'vw';
      div.style.background = colors[Math.floor(Math.random() * colors.length)];
      div.style.animationDuration = (1.5 + Math.random() * 2) + 's';
      div.style.animationDelay = (Math.random() * 0.5) + 's';
      document.body.appendChild(div);
      setTimeout(() => div.remove(), 4000);
    }, i * 60);
  }
}
