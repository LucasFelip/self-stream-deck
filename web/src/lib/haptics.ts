import { android } from './android';

// Haptics: the Android shell exposes a native vibrator (the WebView's own navigator.vibrate is unreliable); a normal browser
// falls back to the Vibration API where it exists. Safari on iPhone has no Vibration API, but (iOS 18+) flipping an
// <input type="checkbox" switch> from a tap gives a light haptic tick: a hidden one is flipped for a short buzz, twice for a long one.
const isIOS = (): boolean => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let tickSwitch: HTMLInputElement | null = null;

function iosTick(times: number): void {
  if (!tickSwitch) {
    const label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    Object.assign(label.style, { position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none', overflow: 'hidden' });
    tickSwitch = document.createElement('input');
    tickSwitch.type = 'checkbox';
    tickSwitch.setAttribute('switch', '');
    tickSwitch.tabIndex = -1;
    label.append(tickSwitch);
    document.body.append(label);
  }
  const target = tickSwitch;
  target.click();
  if (times > 1) setTimeout(() => target.click(), 70);
}

export function vibrate(ms = 10): void {
  try {
    const bridge = android();
    if (bridge && typeof bridge.vibrate === 'function') bridge.vibrate(ms);
    else if (navigator.vibrate) navigator.vibrate(ms);
    else if (isIOS()) iosTick(ms >= 50 ? 2 : 1);
  } catch {
    // haptics are optional
  }
}
