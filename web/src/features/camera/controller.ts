import { useSyncExternalStore } from 'react';
import { call, client } from '../../api/client';
import type { components } from '../../api/schema';

type CameraStatus = components['schemas']['CameraStatus'];
type VirtualCamera = components['schemas']['VirtualCamera'];
export type Facing = 'user' | 'environment';
export type Quality = 'leve' | 'hd';

export const QUALITIES: Record<Quality, { label: string; width: number }> = { leve: { label: '480p', width: 854 }, hd: { label: '720p', width: 1280 } };

const FRAME_MS = 40; // 25 frames a second at best; slower when the link or the phone cannot keep up
const JPEG_QUALITY = 0.72;
// When nobody uses the picture (no OBS source watching, no app with the virtual camera open) one frame a second is enough: the PC says so
// in every answer, and the phone goes back to full speed on the first answer that says someone does.
const IDLE_FRAME_MS = 1000;
const IDLE_AFTER = 3; // consecutive "nobody" answers before slowing down, so a short gap does not make it flap

export const WAITING = 'A câmera só liga quando você pedir: veja a prévia ou transmita ao PC.';

export interface CameraState {
  sending: boolean;
  /** the phone's camera is on (a preview or a transmission) */
  streaming: boolean;
  /** changes every time the stream is replaced, so the preview video can attach to the new one */
  streamVersion: number;
  /** what the picture area says while there is no picture */
  message: string;
  /** the picture area offers "Ver prévia" */
  offerPreview: boolean;
  mirror: boolean;
  quality: Quality;
  statusText: string;
  direct: VirtualCamera;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * "Câmera do celular": the phone's camera as a webcam for the PC. It asks the phone for its camera, draws frames into a canvas and posts
 * them as JPEGs to the PC (POST /api/camera/frame), which republishes them as an MJPEG stream that OBS shows in a Browser Source and
 * offers to other apps as its virtual camera. It outlives the sheet: closing the sheet must not stop the picture that is being sent, and
 * the camera key on Apps turns the transmission on or off.
 */
class CameraController {
  private stream: MediaStream | null = null;
  private facing: Facing = 'user'; // 'user' = the front camera, 'environment' = the back one
  private sending = false;
  private loopId = 0; // a running loop stops when this changes
  private nobody = 0;
  private idle = false;
  private sheetOpen = false;
  private status: CameraStatus | null = null;
  private listeners = new Set<() => void>();
  private capture: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private state: CameraState = {
    sending: false, streaming: false, streamVersion: 0, message: WAITING, offerPreview: true, mirror: true, quality: 'leve',
    statusText: 'Câmera desligada: toque em Ver prévia ou Transmitir ao PC.', direct: { name: 'Stream Deck Camera', installed: false, inUse: false, busy: false },
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getState = (): CameraState => this.state;

  get isSending(): boolean { return this.sending; }
  get currentStream(): MediaStream | null { return this.stream; }

  private set(patch: Partial<CameraState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  // the capture video lives outside the sheet: closing the sheet must not stop the picture that is being sent
  private ensureCapture(): HTMLVideoElement {
    if (!this.capture) {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.setAttribute('aria-hidden', 'true');
      video.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
      document.body.append(video);
      this.capture = video;
      this.canvas = document.createElement('canvas');
    }
    return this.capture;
  }

  private say(message: string, offerPreview = false): void { this.set({ message, offerPreview }); }

  async startCamera(): Promise<boolean> {
    if (this.stream) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.say('Este navegador não libera a câmera aqui. Use o app do Stream Deck.');
      return false;
    }
    this.say('Ligando a câmera…');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: this.facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'erro';
      this.say(name === 'NotAllowedError' ? 'A câmera está bloqueada. Permita o acesso à câmera para o app do Stream Deck.' : `Não foi possível abrir a câmera (${name}).`, true);
      return false;
    }
    this.stream.getVideoTracks().forEach((track) => track.addEventListener('ended', this.onEnded));
    const capture = this.ensureCapture();
    capture.srcObject = this.stream;
    // a mirror for the person looking; the PC gets the unmirrored picture
    this.set({ streaming: true, streamVersion: this.state.streamVersion + 1, mirror: this.facing === 'user', message: '', offerPreview: false });
    await capture.play().catch(() => undefined);
    return true;
  }

  stopCamera(): void {
    if (!this.stream) return;
    this.stream.getTracks().forEach((track) => { track.removeEventListener('ended', this.onEnded); track.stop(); });
    this.stream = null;
    if (this.capture) this.capture.srcObject = null;
    this.set({ streaming: false, streamVersion: this.state.streamVersion + 1 });
    this.say(WAITING, true);
  }

  // the system took the camera away (screen off, another app): get it back if we were transmitting
  private onEnded = (): void => {
    this.stream = null;
    this.set({ streaming: false, streamVersion: this.state.streamVersion + 1 });
    if (this.sending) setTimeout(() => void this.startCamera(), 800);
  };

  async flip(): Promise<void> {
    this.facing = this.facing === 'user' ? 'environment' : 'user';
    if (!this.stream) return; // the camera is off: the choice is kept for when it turns on
    this.stopCamera();
    this.say('Trocando de câmera…');
    await this.startCamera();
  }

  setQuality(quality: Quality): void { this.set({ quality }); }

  private async loop(id: number): Promise<void> {
    this.nobody = 0;
    this.idle = false;
    const capture = this.ensureCapture();
    const canvas = this.canvas as HTMLCanvasElement;
    while (this.sending && id === this.loopId) {
      const started = performance.now();
      if (capture.readyState >= 2 && capture.videoWidth > 0 && !document.hidden) {
        const width = Math.min(QUALITIES[this.state.quality].width, capture.videoWidth);
        const height = Math.round((width * capture.videoHeight) / capture.videoWidth);
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        canvas.getContext('2d')?.drawImage(capture, 0, 0, width, height);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
        if (!blob) continue;
        try {
          const response = await fetch('/api/camera/frame', { method: 'POST', body: blob, headers: { 'Content-Type': 'image/jpeg' } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (response.headers.get('X-Camera-Wanted') === '0') {
            this.nobody += 1;
            if (this.nobody >= IDLE_AFTER) this.idle = true;
          } else {
            this.nobody = 0;
            this.idle = false;
          }
        } catch {
          await sleep(600); // the PC is unreachable for a moment: do not spin
        }
      } else {
        await sleep(200);
      }
      await sleep(Math.max(0, (this.idle ? IDLE_FRAME_MS : FRAME_MS) - (performance.now() - started)));
    }
  }

  async startSending(): Promise<void> {
    if (!(await this.startCamera())) return;
    this.sending = true;
    this.loopId += 1;
    this.set({ sending: true });
    this.paintStatus();
    void this.pollStatus();
    void this.loop(this.loopId);
  }

  stopSending(): void {
    this.sending = false;
    this.loopId += 1;
    this.set({ sending: false });
    if (!this.sheetOpen) this.stopCamera();
    this.status = null;
    this.paintStatus();
  }

  /** for the camera key on Apps: one tap turns the transmission on or off. Returns what the notice should say. */
  async toggle(): Promise<string> {
    if (this.sending) {
      this.stopSending();
      return 'Câmera desligada';
    }
    await this.startSending();
    return this.sending ? 'Câmera ligada: transmitindo ao PC' : '';
  }

  /** used by macros: switch to the wanted state, whatever the current one is */
  async setSending(wanted: boolean): Promise<void> {
    if (wanted !== this.sending) await this.toggle();
  }

  setSheetOpen(open: boolean): void {
    this.sheetOpen = open;
    if (open) {
      if (!this.stream) this.say(WAITING, true); // opening the sheet does not turn the camera on: "Ver prévia" or "Transmitir ao PC" does
      this.paintStatus();
      void this.pollStatus();
    } else if (!this.sending) {
      this.stopCamera(); // transmitting keeps the camera on; a mere preview does not
    }
  }

  private paintStatus(): void {
    const status = this.status;
    let statusText: string;
    if (!status || !this.sending) {
      statusText = this.sending ? 'Transmitindo…' : 'Câmera desligada: toque em Ver prévia ou Transmitir ao PC.';
    } else {
      const direct = this.state.direct;
      const watching = status.viewers > 0 ? 'OBS conectado' : direct.inUse ? 'câmera direta em uso' : 'nenhum app usando ainda';
      if (status.live && !status.wanted) statusText = 'Transmitindo em espera: nenhum app usa a câmera (1 quadro/s, economiza bateria)';
      else statusText = status.live ? `Transmitindo · ${status.fps} fps · ${status.kbps} KB/s · ${watching}` : 'Aguardando o PC receber…';
    }
    this.set({ statusText });
  }

  async pollStatus(): Promise<void> {
    try {
      const status = await call(client.GET('/api/camera/status'));
      this.status = status;
      this.set({ direct: status.direct });
      this.paintStatus();
    } catch {
      this.set({ statusText: 'Sem conexão com o PC' });
    }
  }
}

export const camera = new CameraController();

export const useCamera = (): CameraState => useSyncExternalStore(camera.subscribe, camera.getState);
