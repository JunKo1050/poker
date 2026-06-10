// =====================================================================
// Sound System (Web Audio API + BGM) — 大富豪版から流用
// =====================================================================
const Sound = (() => {
  let ctx = null, muted = false, masterGain = null, bgmAudio = null, bgmDesired = false;
  const BGM_URL = 'ClockworkCards.mp3';
  const BGM_VOLUME = 0.12;

  function getBGM() {
    if (bgmAudio) return bgmAudio;
    bgmAudio = document.getElementById('bgm-audio');
    if (!bgmAudio) { bgmAudio = new Audio(BGM_URL); bgmAudio.loop = true; bgmAudio.preload = 'auto'; }
    bgmAudio.volume = BGM_VOLUME;
    return bgmAudio;
  }
  function startBGM() {
    bgmDesired = true;
    if (muted) return;
    const a = getBGM(); a.volume = BGM_VOLUME;
    try {
      const p = a.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          const retry = () => { a.play().then(() => document.removeEventListener('click', retry)).catch(() => {}); };
          document.addEventListener('click', retry, { once: true });
        });
      }
    } catch (e) {}
  }
  function pauseBGM() { if (bgmAudio) bgmAudio.pause(); }
  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC(); masterGain = ctx.createGain(); masterGain.gain.value = 0.95; masterGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(opts) {
    if (muted) return;
    const c = ensure(); if (!c) return;
    const osc = c.createOscillator(), g = c.createGain();
    osc.connect(g); g.connect(masterGain);
    osc.type = opts.type || 'sine';
    const t0 = c.currentTime + (opts.delay || 0);
    if (opts.freqEnd != null) { osc.frequency.setValueAtTime(opts.freq, t0); osc.frequency.exponentialRampToValueAtTime(opts.freqEnd, t0 + opts.dur); }
    else { osc.frequency.value = opts.freq; }
    const vol = opts.vol != null ? opts.vol : 0.2;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    osc.start(t0); osc.stop(t0 + opts.dur + 0.05);
  }
  function noiseBurst(dur = 0.07, hp = 2000, vol = 0.25) {
    if (muted) return;
    const c = ensure(); if (!c) return;
    const bufferSize = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize) * vol;
    const src = c.createBufferSource(); src.buffer = buf;
    const filter = c.createBiquadFilter(); filter.type = 'highpass'; filter.frequency.value = hp;
    src.connect(filter); filter.connect(masterGain); src.start();
  }
  return {
    cardPlay: () => noiseBurst(0.08, 2500, 0.3),
    deal: () => { for (let i = 0; i < 4; i++) setTimeout(() => noiseBurst(0.04, 3000, 0.22), i * 90); },
    chip: () => { tone({ type: 'square', freq: 660, dur: 0.06, vol: 0.12 }); tone({ type: 'square', freq: 880, dur: 0.06, vol: 0.1, delay: 0.05 }); },
    check: () => tone({ type: 'sine', freq: 440, dur: 0.12, vol: 0.12 }),
    myTurn: () => { tone({ type: 'sine', freq: 880, dur: 0.09, vol: 0.1 }); tone({ type: 'sine', freq: 1320, dur: 0.12, vol: 0.08, delay: 0.09 }); },
    fold: () => tone({ type: 'sine', freq: 330, freqEnd: 200, dur: 0.25, vol: 0.13 }),
    allin: () => { const n=[523,659,784]; n.forEach((f,i)=>tone({type:'square',freq:f,dur:0.12,vol:0.16,delay:i*0.08})); },
    win: () => { const notes = [523, 659, 784, 1047]; notes.forEach((f, i) => tone({ type: 'triangle', freq: f, dur: 0.25, vol: 0.2, delay: i * 0.10 })); },
    lose: () => { const notes = [440, 392, 349, 294]; notes.forEach((f, i) => tone({ type: 'sawtooth', freq: f, dur: 0.32, vol: 0.16, delay: i * 0.14 })); },
    fanfare: () => {
      const notes = [
        {freq: 392.0, dur: 0.18, delay: 0.00}, {freq: 523.3, dur: 0.18, delay: 0.18},
        {freq: 659.3, dur: 0.18, delay: 0.36}, {freq: 784.0, dur: 0.35, delay: 0.54},
        {freq: 1046.5, dur: 1.20, delay: 0.95},
      ];
      notes.forEach(n => {
        tone({ type: 'square', freq: n.freq, dur: n.dur, vol: 0.20, delay: n.delay });
        tone({ type: 'triangle', freq: n.freq * 0.5, dur: n.dur, vol: 0.12, delay: n.delay });
      });
    },
    toggle: () => { muted = !muted; if (muted) pauseBGM(); else if (bgmDesired) startBGM(); return muted; },
    init: () => ensure(),
    startBGM, pauseBGM,
  };
})();
