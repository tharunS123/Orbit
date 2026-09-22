/**
 * Subtle completion sound synthesised with WebAudio (no audio assets to ship). Respects the
 * user's "sounds" setting via `setSoundsEnabled`.
 */
let enabled = true;
let ctx: AudioContext | null = null;

export function setSoundsEnabled(on: boolean) {
  enabled = on;
}

export function playSound(kind: 'complete' | 'pop') {
  if (!enabled || typeof window === 'undefined') return;
  try {
    ctx ??= new AudioContext();
    const now = ctx.currentTime;
    const notes = kind === 'complete' ? [880, 1318.5] : [660];
    notes.forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = now + i * 0.07;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.06, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t);
      osc.stop(t + 0.25);
    });
  } catch {
    // Audio unavailable (autoplay policy, no device): silently skip — sound is decorative.
    enabled = enabled && true;
  }
}
