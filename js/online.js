// =====================================================================
// Online-mode wiring: connects the (mode-agnostic) view layer to the
// game server over Socket.IO. Mirrors main.js but instead of a local
// engine, events arrive via `game:event` and actions return via
// `game:action`.
// =====================================================================

// --- server address -------------------------------------------------
// Production URL is filled in after the Render deploy.
// Override anytime with ?server=https://...
const ONLINE_DEFAULT_SERVER = 'https://poker-server.onrender.com'; // ← Renderデプロイ後に実URLへ更新
const SERVER_URL = (() => {
  const p = new URLSearchParams(location.search).get('server');
  if (p) return p;
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return 'http://localhost:3001';
  return ONLINE_DEFAULT_SERVER;
})();

let socket = null;
let myCharIdx = 0;
let lobby = null;       // latest room summary (+ youAreHost)
let started = false;

function setStatus(msg) {
  const el = document.getElementById('conn-status');
  if (el) el.textContent = msg;
}
function enableEntryButtons(on) {
  document.getElementById('btn-create').disabled = !on;
  document.getElementById('btn-join').disabled = !on;
}

function buildCharGrid() {
  const grid = document.getElementById('character-grid');
  grid.innerHTML = '';
  CPU_CHARS.forEach((c, i) => {
    const tile = document.createElement('div');
    tile.className = 'character-tile';
    if (i === myCharIdx) tile.classList.add('selected');
    tile.innerHTML = `<img src="${c.img}" alt="${c.name}" draggable="false"><div class="char-name">${c.name}</div>`;
    tile.addEventListener('click', () => {
      myCharIdx = i;
      grid.querySelectorAll('.character-tile').forEach(el => el.classList.remove('selected'));
      tile.classList.add('selected');
      Sound.init();
    });
    grid.appendChild(tile);
  });
}

function entryData() {
  return {
    name: document.getElementById('set-name').value.trim() || 'プレイヤー',
    img: CPU_CHARS[myCharIdx].img,
  };
}

function showLobby() {
  document.getElementById('modal-entry').classList.remove('show');
  document.getElementById('modal-lobby').classList.add('show');
  renderLobby();
}

function renderLobby() {
  if (!lobby) return;
  document.getElementById('room-code').textContent = lobby.code;
  const list = document.getElementById('lobby-list');
  list.innerHTML = '';
  lobby.members.forEach(m => {
    const row = document.createElement('div');
    row.className = 'lobby-member' + (m.connected ? '' : ' off');
    row.innerHTML = `<img src="${m.img}" alt=""><span class="lm-name">${m.name}</span>` +
      (m.isHost ? '<span class="lm-host">ホスト</span>' : '');
    list.appendChild(row);
  });
  for (let i = lobby.members.length; i < 6; i++) {
    const row = document.createElement('div');
    row.className = 'lobby-member empty';
    row.innerHTML = `<span class="lm-cpu">🤖</span><span class="lm-name">空席（CPUが入ります）</span>`;
    list.appendChild(row);
  }
  const startBtn = document.getElementById('btn-start-room');
  const status = document.getElementById('lobby-status');
  if (lobby.youAreHost) {
    startBtn.style.display = '';
    status.textContent = `現在 ${lobby.members.length} 人。いつでも開始できます。`;
  } else {
    startBtn.style.display = 'none';
    status.textContent = 'ホストがゲームを開始するのを待っています…';
  }
}

// 当面の切断対応: ゲーム中に接続が落ちたらトップへ（再入室は今後対応）
function onDropped() {
  if (started) {
    alert('サーバーとの接続が切れました。トップに戻ります。');
    location.href = 'index.html';
  } else {
    setStatus('⚠️ 接続が切れました。再接続中…');
    enableEntryButtons(false);
  }
}

window.addEventListener('load', () => {
  buildCharGrid();
  document.getElementById('modal-entry').classList.add('show');
  document.getElementById('action-area').style.display = 'none';
  setStatus('サーバーに接続中…（無料サーバーは起動に1分ほどかかることがあります）');

  // wake the Render free instance early
  fetch(SERVER_URL + '/health').catch(() => {});

  socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    setStatus('✅ サーバー接続OK');
    enableEntryButtons(true);
  });
  socket.on('connect_error', () => setStatus('接続待ち…（サーバーを起動しています）'));
  socket.on('disconnect', onDropped);

  socket.on('room:update', r => { lobby = r; renderLobby(); });

  socket.on('room:started', d => {
    started = true;
    resetView();
    V.mySeat = d.youSeat;
    document.getElementById('modal-lobby').classList.remove('show');
    Sound.init();
    Sound.startBGM();
  });

  socket.on('game:event', ev => handleGameEvent(ev));

  socket.on('game:action_request', async d => {
    const act = await requestAction(d.options);
    socket.emit('game:action', act);
  });

  // ----- buttons -----
  document.getElementById('btn-create').onclick = () => {
    Sound.init();
    socket.emit('room:create', entryData(), res => {
      if (!res || !res.ok) { toast((res && res.error) || '部屋を作成できませんでした'); return; }
      lobby = res;
      showLobby();
    });
  };
  document.getElementById('btn-join').onclick = () => {
    Sound.init();
    const code = document.getElementById('join-code').value.trim();
    if (!/^\d{6}$/.test(code)) { toast('6桁のコードを入力してね'); return; }
    socket.emit('room:join', { ...entryData(), code }, res => {
      if (!res || !res.ok) { toast((res && res.error) || '入室できませんでした'); return; }
      lobby = res;
      showLobby();
    });
  };
  document.getElementById('btn-start-room').onclick = () => socket.emit('room:start');

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

  // keyboard shortcuts (same as CPU mode)
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

function showRulesModal() { document.getElementById('modal-rules').classList.add('show'); }
