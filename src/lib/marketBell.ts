// Market Opening Bell – Web Audio API synthesis
// Plays a bright NYSE-style opening bell (3 strikes) with no external assets.

let audioCtx: AudioContext | null = null;

function ensureCtx(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === "suspended") {
    void audioCtx.resume();
  }
  return audioCtx;
}

function playBellStrike(freq: number, time: number, duration = 1.5) {
  const ctx = ensureCtx();
  const t0 = ctx.currentTime + time;
  const t1 = t0 + duration;

  // Fundamental + harmonics for metallic bell timbre
  const freqs = [freq, freq * 2.0, freq * 3.0, freq * 4.2, freq * 5.4];
  const gains = [1.0, 0.35, 0.2, 0.12, 0.08];

  const master = ctx.createGain();
  master.gain.setValueAtTime(0.6, t0);
  master.gain.exponentialRampToValueAtTime(0.001, t1);
  master.connect(ctx.destination);

  freqs.forEach((f, i) => {
    const osc = ctx.createOscillator();
    osc.type = i === 0 ? "sine" : "triangle";
    osc.frequency.setValueAtTime(f, t0);

    const g = ctx.createGain();
    g.gain.setValueAtTime(gains[i], t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + duration * (1 - i * 0.12));

    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t1);
  });

  // Bright strike transient (noise burst)
  const bufferSize = ctx.sampleRate * 0.05;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.01));
  }
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.25, t0);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.06);
  noise.connect(noiseGain);
  noiseGain.connect(ctx.destination);
  noise.start(t0);
}

export function playMarketBell() {
  // Three strikes: ting … ting … ting
  playBellStrike(880, 0.00, 1.8);   // A5
  playBellStrike(880, 0.50, 1.8);   // A5
  playBellStrike(880, 1.00, 2.0);   // A5 — slightly longer final ring
}

export function canPlayAudio(): boolean {
  // Audio usually needs a user gesture first; we return whether context exists & is running
  if (!audioCtx) return false;
  return audioCtx.state === "running";
}

export function resumeAudioContext() {
  return ensureCtx().resume();
}
