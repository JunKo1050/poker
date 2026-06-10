// =====================================================================
// Local (CPU-mode) wiring: setup screen, engine instantiation, topbar
// buttons, keyboard shortcuts.
// In online mode this file is replaced by a socket layer that feeds
// handleGameEvent() with server events and sends requestAction() results
// back — the view layer is identical for both modes.
// =====================================================================
let humanCharIdx = 0;
let engineSeq = 0; // bumping this silences events from an abandoned engine

function buildSetupUI() {
  const grid = document.getElementById('character-grid');
  grid.innerHTML = '';
  CPU_CHARS.forEach((c, i) => {
    const tile = document.createElement('div');
    tile.className = 'character-tile';
    if (i === humanCharIdx) tile.classList.add('selected');
    tile.innerHTML = `<img src="${c.img}" alt="${c.name}" draggable="false"><div class="char-name">${c.name}</div>`;
    tile.addEventListener('click', () => {
      humanCharIdx = i;
      grid.querySelectorAll('.character-tile').forEach(el => el.classList.remove('selected'));
      tile.classList.add('selected');
      Sound.init();
    });
    grid.appendChild(tile);
  });
}

function newGame() {
  engineSeq++; // abandon any running engine
  resetView();
  document.getElementById('final-overlay').classList.remove('show');
  document.getElementById('modal-eliminated').classList.remove('show');
  document.getElementById('action-area').style.display = 'none';
  document.getElementById('made-hand-label').style.display = 'none';
  document.getElementById('hand').innerHTML = '';
  document.getElementById('log-panel').innerHTML = '';
  buildSetupUI();
  document.getElementById('modal-setup').classList.add('show');
}

function startGame() {
  const humanName = document.getElementById('set-name').value.trim() || 'あなた';
  const humanChar = CPU_CHARS[humanCharIdx];

  // pick 5 distinct CPU characters
  const cpuChars = [];
  for (let i = 0; i < CPU_CHARS.length && cpuChars.length < 5; i++) {
    if (i !== humanCharIdx) cpuChars.push(CPU_CHARS[i]);
  }
  const pers = shuffle(PERSONALITIES);

  const players = [
    { name: humanName, img: humanChar.img, isHuman: true, personality: null },
    ...cpuChars.map((c, k) => ({
      name: c.name, img: c.img, isHuman: false, personality: pers[k % pers.length],
    })),
  ];

  document.getElementById('modal-setup').classList.remove('show');
  Sound.init();
  Sound.startBGM();

  V.mySeat = 0;
  const myToken = ++engineSeq;
  const engine = createEngine({ players, humanSeat: 0 }, {
    emit: ev => { if (myToken === engineSeq) handleGameEvent(ev); },
    getAction: (seat, options) => myToken === engineSeq ? requestAction(options) : Promise.resolve({ action: 'fold' }),
    wait: ms => delay(ms),
    askSpectate: place => myToken === engineSeq ? askSpectateOrLeave(place) : Promise.resolve('leave'),
  });
  engine.run();
  window._engine = engine; // debug handle (local mode only)
}

// =====================================================================
// UI helpers / Init
// =====================================================================
function showRulesModal() { document.getElementById('modal-rules').classList.add('show'); }

window.addEventListener('load', () => {
  buildSetupUI();
  document.getElementById('modal-setup').classList.add('show');
  document.getElementById('action-area').style.display = 'none';

  document.getElementById('btn-sound').onclick = () => {
    const m = Sound.toggle();
    document.getElementById('btn-sound').textContent = m ? '🔇' : '🔊';
    toast(m ? '音声: OFF' : '音声: ON');
    if (!m) Sound.init();
  };

  document.getElementById('btn-reserve').onclick = () => {
    V.reservedFold = !V.reservedFold;
    updateReserveBtn();
  };

  document.getElementById('btn-speed').onclick = () => {
    const i = SPEEDS.indexOf(GAME_SPEED);
    GAME_SPEED = SPEEDS[(i + 1) % SPEEDS.length];
    document.getElementById('btn-speed').textContent = '⏩ ×' + GAME_SPEED;
    toast(`ゲーム速度: ×${GAME_SPEED}`);
  };

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    if (e.target.tagName === 'TEXTAREA') return;
    if (document.querySelector('.modal-overlay.show')) return;
    if (!V._resolve) return;
    if (e.code === 'KeyF') {
      e.preventDefault();
      const b = document.querySelector('.action-btns .btn-fold');
      if (b) b.click();
    } else if (e.code === 'KeyC') {
      e.preventDefault();
      const b = document.querySelector('.action-btns .btn-call');
      if (b) b.click();
    } else if (e.code === 'KeyR') {
      e.preventDefault();
      const b = document.getElementById('raise-btn');
      if (b) b.click();
    } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
      const s = document.getElementById('raise-slider');
      if (!s) return;
      e.preventDefault();
      const base = parseInt(s.step) || 1;
      const step = (e.code === 'ArrowUp' || e.code === 'ArrowDown') ? base * 10 : base;
      const dir = (e.code === 'ArrowRight' || e.code === 'ArrowUp') ? 1 : -1;
      s.value = Math.max(parseInt(s.min), Math.min(parseInt(s.max), parseInt(s.value) + dir * step));
      updateRaiseAmount();
    }
  });
});
