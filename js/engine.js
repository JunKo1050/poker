// =====================================================================
// Game engine (DOM-free, shared with the server).
//
// createEngine(config, hooks) returns { run, getState }.
//   config.players: [{ name, img, isHuman, personality|null }]
//   config.humanSeat: seat index of the local human (default 0)
//   hooks.emit(ev): receive game events. Every event carries:
//     ev.type    — event name
//     ev.pub     — full public state snapshot (no hidden hole cards)
//     ev.private — {seatIdx: [card,card]} hole cards, ONLY on 'deal'.
//                  A server must split this per socket; the local client
//                  just picks its own seat.
//   hooks.getAction(seat, options) -> Promise<{action, amount}> for human seats
//   hooks.wait(ms) -> Promise (pacing; client scales by game speed)
//   hooks.askSpectate() -> Promise<'spectate'|'leave'> when the human busts
//
// The engine never touches the DOM. All rendering / animation / sound
// happens in the view layer, driven purely by these events.
// =====================================================================
function createEngine(config, hooks) {
  const S = {
    players: config.players.map(p => ({
      name: p.name, img: p.img, isHuman: !!p.isHuman, personality: p.personality || null,
      stack: STARTING_STACK, holeCards: [], folded: false, allIn: false,
      inHand: false, alive: true, bet: 0, totalBet: 0, hasActed: false,
      lastAction: '', revealed: false, isWinner: false,
    })),
    humanIdx: config.humanSeat ?? 0,
    deck: [], community: [],
    handNum: 0, sb: BASE_SB, bb: BASE_BB, blindLevel: 0,
    dealerIdx: Math.floor(Math.random() * config.players.length),
    sbIdx: 0, bbIdx: 0, preflopFirst: 0, postflopFirst: 0,
    currentBet: 0, minRaise: BASE_BB, currentTurn: -1,
    street: 'idle',
    eliminationOrder: [], spectating: false, quit: false,
    ranges: {}, aggrCount: 0, positions: {}, equity: null,
  };

  // ----- event plumbing -----
  function pubState() {
    return {
      handNum: S.handNum, sb: S.sb, bb: S.bb, dealerIdx: S.dealerIdx,
      positions: { ...S.positions }, street: S.street, currentTurn: S.currentTurn,
      pot: getPot(S), currentBet: S.currentBet, minRaise: S.minRaise,
      community: S.community.slice(),
      equity: S.equity ? { ...S.equity } : null,
      players: S.players.map(p => ({
        name: p.name, img: p.img, isHuman: p.isHuman,
        stack: p.stack, bet: p.bet, folded: p.folded, allIn: p.allIn,
        inHand: p.inHand, alive: p.alive, lastAction: p.lastAction, isWinner: p.isWinner,
        personality: p.personality ? { label: p.personality.label, emoji: p.personality.emoji } : null,
        revealed: p.revealed,
        cards: p.revealed ? p.holeCards.slice() : null, // public only once revealed
      })),
    };
  }
  function emit(type, extra = {}) {
    hooks.emit({ type, ...extra, pub: pubState() });
  }
  const wait = ms => hooks.wait(ms);

  // ----- tournament loop -----
  async function run() {
    while (true) {
      await playHand();
      if (S.quit) { emitEnd(); return; }
      const alive = S.players.filter(p => p.alive);
      if (alive.length <= 1) { emitEnd(); return; }
      S.dealerIdx = nextAliveSeat(S, S.dealerIdx);
      await wait(500);
    }
  }

  function updateBlinds() {
    S.blindLevel = Math.floor((S.handNum - 1) / BLIND_UP_EVERY);
    const mult = Math.pow(2, S.blindLevel);
    const prevSb = S.sb;
    S.sb = BASE_SB * mult;
    S.bb = BASE_BB * mult;
    if (S.handNum > 1 && S.sb !== prevSb) emit('blind_up', { sb: S.sb, bb: S.bb });
  }

  // ----- one hand -----
  async function playHand() {
    S.handNum++;
    updateBlinds();

    S.community = [];
    S.deck = shuffle(createDeck());
    S.street = 'preflop';
    S.equity = null;
    S.players.forEach(p => {
      p.inHand = p.alive;
      p.holeCards = [];
      p.folded = false;
      p.allIn = false;
      p.bet = 0;
      p.totalBet = 0;
      p.hasActed = false;
      p.lastAction = '';
      p.revealed = false;
      p.isWinner = false;
    });

    setupPositions();
    assignPositionLabels();
    postBlinds();

    // deal hole cards, round-robin from SB — exactly 2 per in-hand player
    const inHandCount = S.players.filter(p => p.inHand).length;
    const dealOrder = [];
    for (let r = 0; r < 2; r++) {
      let idx = S.sbIdx;
      for (let c = 0; c < inHandCount; c++) {
        S.players[idx].holeCards.push(S.deck.pop());
        dealOrder.push(idx);
        idx = nextSeat(S, idx);
      }
    }
    initRanges(S);
    S.aggrCount = 0;

    const priv = {};
    S.players.forEach((p, i) => { if (p.inHand) priv[i] = p.holeCards.slice(); });
    emit('deal', { dealOrder, dealerName: S.players[S.dealerIdx].name, private: priv });
    await wait(dealOrder.length * 80 + 600); // matches the client deal animation

    await bettingRound(S.preflopFirst);
    await collectBets();
    await maybeStartRunout();

    const streets = [{ name: 'flop', n: 3 }, { name: 'turn', n: 1 }, { name: 'river', n: 1 }];
    for (const st of streets) {
      if (contenders(S).length <= 1) break;
      S.street = st.name;
      for (let i = 0; i < st.n; i++) S.community.push(S.deck.pop());
      S.players.forEach(p => { p.bet = 0; });
      S.currentBet = 0;
      S.minRaise = S.bb;
      S.aggrCount = 0;
      emit('street', { name: st.name, added: st.n });
      await wait(550 + st.n * 110);

      if (S.equity) {
        // all-in runout: just update each player's win% as cards come
        updateEquity();
        emit('equity_update', {});
        await wait(1100);
      } else if (canStillBet(S)) {
        await bettingRound(S.postflopFirst);
        await collectBets();
        await maybeStartRunout();
      } else {
        await wait(700);
      }
    }

    await resolveShowdown();
    await handleEliminations();
  }

  function setupPositions() {
    const alive = S.players.filter(p => p.alive).length;
    if (alive === 2) {
      S.sbIdx = S.dealerIdx;
      S.bbIdx = nextSeat(S, S.dealerIdx);
      S.preflopFirst = S.dealerIdx;   // dealer/SB acts first preflop
      S.postflopFirst = S.bbIdx;      // BB acts first postflop
    } else {
      S.sbIdx = nextSeat(S, S.dealerIdx);
      S.bbIdx = nextSeat(S, S.sbIdx);
      S.preflopFirst = nextSeat(S, S.bbIdx);
      S.postflopFirst = S.sbIdx;
    }
  }

  function commit(p, amount) {
    const a = Math.min(amount, p.stack);
    p.stack -= a;
    p.bet += a;
    p.totalBet += a;
    if (p.stack === 0) p.allIn = true;
    return a;
  }

  function postBlinds() {
    S.currentBet = 0;
    const sbP = S.players[S.sbIdx], bbP = S.players[S.bbIdx];
    commit(sbP, S.sb); sbP.lastAction = 'SB';
    commit(bbP, S.bb); bbP.lastAction = 'BB';
    S.currentBet = S.bb;
    S.minRaise = S.bb;
  }

  // Assign poker position labels (BTN/SB/BB/UTG/HJ/CO) walking from the button.
  function assignPositionLabels() {
    const n = S.players.filter(p => p.inHand).length;
    const labelsByN = {
      2: ['BTN', 'BB'],
      3: ['BTN', 'SB', 'BB'],
      4: ['BTN', 'SB', 'BB', 'UTG'],
      5: ['BTN', 'SB', 'BB', 'UTG', 'CO'],
      6: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'],
    };
    const labels = labelsByN[n] || labelsByN[6];
    S.positions = {};
    let idx = S.dealerIdx;
    for (let k = 0; k < n; k++) { S.positions[idx] = labels[k]; idx = nextSeat(S, idx); }
  }

  // When everyone is all-in (or only one player can still act), reveal hands
  // and show live win percentages like a TV broadcast.
  async function maybeStartRunout() {
    if (contenders(S).length >= 2 && !canStillBet(S) && S.community.length < 5 && !S.equity) {
      updateEquity();
      emit('runout', {});
      await wait(3300); // covers the client's centre-screen reveal overlay
    }
  }

  function updateEquity() {
    const cont = contenders(S);
    if (cont.length < 2) { S.equity = null; return; }
    cont.forEach(p => p.revealed = true);
    const eq = equityKnown(cont.map(p => p.holeCards), S.community);
    S.equity = {};
    cont.forEach((p, k) => { S.equity[S.players.indexOf(p)] = Math.round(eq[k] * 100); });
  }

  // ----- betting -----
  async function bettingRound(startIdx) {
    S.players.forEach(p => { if (p.inHand) p.hasActed = false; });
    let idx = startIdx;
    let guard = 0;

    while (true) {
      const cont = contenders(S);
      if (cont.length <= 1) break;
      const canAct = cont.filter(p => !p.allIn);
      if (canAct.length === 0) break;
      if (canAct.every(p => p.hasActed && p.bet === S.currentBet)) break;

      // find next actor needing action
      let find = 0;
      while (true) {
        const p = S.players[idx];
        if (p.inHand && !p.folded && !p.allIn && !(p.hasActed && p.bet === S.currentBet)) break;
        idx = nextSeat(S, idx);
        if (++find > 30) break;
      }

      S.currentTurn = idx;
      const p = S.players[idx];
      emit('turn', { seat: idx });

      const potBefore = getPot(S);
      const betBefore = S.currentBet;
      const pBetBefore = p.bet;
      let act;
      if (p.isHuman && !S.spectating && p.alive) {
        act = await hooks.getAction(idx, actionOptions(idx));
      } else {
        await wait(700 + Math.random() * 600);
        act = cpuActionGTO(S, idx);
      }
      applyAction(idx, act);
      if (S.currentBet > betBefore) S.aggrCount++;
      const sizeFrac = potBefore > 0 ? (S.currentBet - betBefore) / potBefore : 1;
      updateRangeOnAction(S, idx, p.lastAction, sizeFrac, S.street, S.aggrCount);
      emit('action_done', { seat: idx, label: p.lastAction, amount: p.bet, fly: p.bet > pBetBefore });
      await wait(450);

      idx = nextSeat(S, idx);
      if (++guard > 200) break;
    }
    S.currentTurn = -1;
  }

  // legal-action summary sent to the acting (human) client
  function actionOptions(idx) {
    const p = S.players[idx];
    const callAmt = S.currentBet - p.bet;
    const maxTotal = p.bet + p.stack;
    let minRaiseTo = S.currentBet + S.minRaise;
    if (S.currentBet === 0) minRaiseTo = S.bb;
    minRaiseTo = Math.min(minRaiseTo, maxTotal);
    return {
      callAmt, canCheck: callAmt === 0, canRaise: p.stack > callAmt,
      minRaiseTo, maxTotal, pot: getPot(S),
      currentBet: S.currentBet, bb: S.bb, stack: p.stack,
    };
  }

  function applyAction(idx, act) {
    const p = S.players[idx];
    act = act || { action: 'fold' };
    if (act.action === 'check' && S.currentBet - p.bet > 0) act = { action: 'fold' }; // illegal check → fold
    if (act.action === 'fold') {
      p.folded = true; p.hasActed = true; p.lastAction = 'フォールド';
    } else if (act.action === 'check') {
      p.hasActed = true; p.lastAction = 'チェック';
    } else if (act.action === 'call') {
      commit(p, S.currentBet - p.bet);
      p.hasActed = true; p.lastAction = p.allIn ? 'オールイン' : 'コール';
    } else if (act.action === 'raise') {
      const before = S.currentBet;
      const target = clampRaise(S, p, Math.max(0, Math.floor(act.amount || 0)));
      commit(p, target - p.bet);
      if (p.bet > before) {
        const raiseSize = p.bet - before;
        S.currentBet = p.bet;
        if (raiseSize >= S.minRaise) S.minRaise = raiseSize;
        S.players.forEach(q => { if (q !== p && q.inHand && !q.folded && !q.allIn) q.hasActed = false; });
      }
      p.hasActed = true;
      p.lastAction = p.allIn ? 'オールイン' : (before === 0 ? 'ベット' : 'レイズ');
    }
  }

  // Street end: everyone's bet pile slides into the pot.
  async function collectBets() {
    const bets = {};
    S.players.forEach((p, i) => { if (p.bet > 0) bets[i] = p.bet; });
    if (Object.keys(bets).length === 0) return;
    S.players.forEach(p => { p.bet = 0; });
    emit('collect', { bets });
    await wait(520);
  }

  // ----- showdown & pots -----
  function refundUncalled() {
    const ps = S.players.filter(p => p.totalBet > 0);
    if (ps.length < 2) {
      if (ps.length === 1) { ps[0].stack += ps[0].totalBet; ps[0].totalBet = 0; ps[0].allIn = false; }
      return;
    }
    const sorted = [...ps].sort((a, b) => b.totalBet - a.totalBet);
    const top = sorted[0], second = sorted[1];
    const excess = top.totalBet - second.totalBet;
    if (excess > 0) {
      top.stack += excess;
      top.totalBet -= excess;
      if (top.stack > 0) top.allIn = false;
      emit('note', { msg: `未コール分 ${excess} を ${top.name} に返却` });
    }
  }

  function buildPots() {
    const ps = S.players.filter(p => p.totalBet > 0).map(p => ({ idx: S.players.indexOf(p), contrib: p.totalBet, folded: p.folded }));
    const pots = [];
    while (true) {
      const positive = ps.filter(x => x.contrib > 0);
      if (positive.length === 0) break;
      const min = Math.min(...positive.map(x => x.contrib));
      let amount = 0, eligible = [];
      positive.forEach(x => { x.contrib -= min; amount += min; if (!x.folded) eligible.push(x.idx); });
      pots.push({ amount, eligible });
    }
    const merged = [];
    pots.forEach(pot => {
      const last = merged[merged.length - 1];
      if (last && last.eligible.length === pot.eligible.length && last.eligible.every(e => pot.eligible.includes(e))) last.amount += pot.amount;
      else merged.push(pot);
    });
    return merged;
  }

  async function resolveShowdown() {
    S.currentTurn = -1;
    refundUncalled();
    const cont = contenders(S);

    if (cont.length === 0) { S.street = 'idle'; emit('state', {}); return; }

    if (cont.length === 1) {
      // uncontested
      const w = cont[0];
      const wIdx = S.players.indexOf(w);
      const pots = buildPots();
      let total = 0;
      pots.forEach(pot => { if (pot.eligible.includes(wIdx)) { w.stack += pot.amount; total += pot.amount; } });
      w.isWinner = true;
      emit('award', {
        uncontested: true, winners: [wIdx], amount: total,
        text: `${w.name} がポット獲得 +${total.toLocaleString()}`,
        winningIds: [], summary: [],
      });
      await wait(1900);
      w.isWinner = false;
      S.street = 'idle';
      emit('state', {});
      return;
    }

    // Showdown: reveal & evaluate (pause so every revealed hand can be read)
    S.street = 'showdown';
    const firstReveal = cont.some(p => !p.revealed); // not already shown by an all-in runout
    cont.forEach(p => p.revealed = true);
    S.equity = null;
    emit('showdown', { firstReveal });
    await wait(1500);

    const pots = buildPots();
    const winSummary = [];
    pots.forEach((pot) => {
      const eligible = pot.eligible.filter(i => !S.players[i].folded);
      if (eligible.length === 0) return;
      let best = null, winners = [];
      eligible.forEach(i => {
        const sc = bestHand([...S.players[i].holeCards, ...S.community]);
        if (!best || cmpScore(sc, best) > 0) { best = sc; winners = [i]; }
        else if (cmpScore(sc, best) === 0) winners.push(i);
      });
      const share = Math.floor(pot.amount / winners.length);
      const rem = pot.amount - share * winners.length;
      winners.forEach((i, k) => { S.players[i].stack += share + (k < rem ? 1 : 0); S.players[i].isWinner = true; });
      winSummary.push({ winners, desc: handDescription(best), amount: pot.amount });
    });

    // the winning 5 cards (for highlighting)
    const main = winSummary[0];
    const hlIds = new Set();
    if (main) {
      main.winners.forEach(i => {
        const bh = bestHandWithCards([...S.players[i].holeCards, ...S.community]);
        if (bh) bh.hand.forEach(c => hlIds.add(c.id));
      });
    }
    if (main) {
      const names = main.winners.map(i => S.players[i].name).join(' / ');
      emit('award', {
        uncontested: false, winners: main.winners, amount: main.amount,
        text: `${names} の勝ち！ ${main.desc}`,
        winningIds: [...hlIds],
        summary: winSummary.map(ws => ({
          names: ws.winners.map(i => S.players[i].name).join('/'),
          desc: ws.desc, amount: ws.amount,
        })),
      });
    }
    await wait(2600);
    S.players.forEach(p => p.isWinner = false);
    S.street = 'idle';
    emit('state', {});
  }

  // ----- eliminations / tournament end -----
  async function handleEliminations() {
    const busted = S.players.filter(p => p.alive && p.stack <= 0);
    if (busted.length === 0) return;
    busted.sort((a, b) => a.totalBet - b.totalBet); // smaller committed total = worse place

    const seats = [];
    for (const p of busted) {
      p.alive = false;
      p.inHand = false;
      const i = S.players.indexOf(p);
      S.eliminationOrder.push(i);
      seats.push(i);
    }
    emit('elimination', { seats });
    await wait(1600);

    const human = S.players[S.humanIdx];
    const aliveCount = S.players.filter(p => p.alive).length;
    if (!human.alive && !S.spectating && aliveCount > 1 && hooks.askSpectate) {
      const place = aliveCount + 1;
      const choice = await hooks.askSpectate(place);
      if (choice === 'leave') S.quit = true;
      else S.spectating = true;
    }
  }

  function emitEnd() {
    const alive = S.players.map((p, i) => ({ p, i })).filter(x => x.p.alive).sort((a, b) => b.p.stack - a.p.stack);
    const order = alive.map(x => x.i);
    for (let k = S.eliminationOrder.length - 1; k >= 0; k--) order.push(S.eliminationOrder[k]);
    const standings = order.map((seat, pos) => {
      const p = S.players[seat];
      return { seat, place: pos + 1, name: p.name, img: p.img, stack: p.stack, alive: p.alive };
    });
    emit('tournament_end', { standings, quit: S.quit });
  }

  return { run, getState: () => S };
}
