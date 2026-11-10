import { useEffect, useRef } from 'react';
import { call, client } from '../../api/client';
import { HoldButton } from '../../ui/HoldButton';
import { Icon } from '../../ui/Icon';
import { Overlay } from '../../ui/Overlay';
import { useToast } from '../../ui/Toast';
import { FPS_OPTIONS, QUALITIES, camera, useCamera, type Quality } from './controller';

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The sheet of the phone camera: the preview, the button that starts and stops the transmission, which camera and how sharp, the two ways
 * to reach the PC's apps (the direct virtual camera, or OBS) and what the PC says about the stream. Opening it does not turn the camera on.
 */
export function CameraOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = useCamera();
  const toast = useToast();
  const preview = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    camera.setSheetOpen(open);
    if (!open) return undefined;
    const timer = setInterval(() => { if (!document.hidden) void camera.pollStatus(); }, 2000);
    return () => clearInterval(timer);
  }, [open]);

  // the picture the phone is sending, shown to the person looking
  useEffect(() => {
    const video = preview.current;
    if (!video) return;
    video.muted = true;
    video.srcObject = camera.currentStream;
    if (camera.currentStream) void video.play().catch(() => undefined);
  }, [state.streamVersion]);

  async function directAction(action: 'install' | 'uninstall') {
    toast(action === 'install' ? 'Instalando a câmera virtual…' : 'Removendo a câmera virtual…');
    try {
      await call(client.POST(action === 'install' ? '/api/camera/direct/install' : '/api/camera/direct/uninstall', { body: { confirm: true } }));
      toast(action === 'install' ? 'Câmera virtual instalada' : 'Câmera virtual removida');
    } catch (error) {
      toast(`Erro: ${errorText(error)}`, true);
    }
    void camera.pollStatus();
  }

  async function copyLink() {
    try {
      await call(client.POST('/api/camera/copy-link'));
      toast('Link copiado no PC: cole no OBS (Ctrl+V)');
    } catch (error) {
      toast(`Erro: ${errorText(error)}`, true);
    }
  }

  const { direct } = state;
  return (
    <Overlay open={open} title="Câmera do celular" onClose={onClose}>
      <section className="camera-page">
        <div className="cam-view">
          <video className="cam-video" ref={preview} muted playsInline autoPlay data-live={String(state.streaming)} data-mirror={state.streaming ? String(state.mirror) : undefined} />
          <div className="cam-placeholder" hidden={state.streaming}>
            <span>{state.message}</span>
            <button type="button" className="cam-act" hidden={!state.offerPreview} onClick={() => void camera.startCamera()}>Ver prévia</button>
          </div>
        </div>
        <div className="card cam-side">
          <button type="button" className="bigbtn cam-send" data-on={String(state.sending)} onClick={() => void (state.sending ? camera.stopSending() : camera.startSending())}>
            <Icon name={state.sending ? 'pause' : 'play'} size={24} />
            <span>{state.sending ? 'Parar transmissão' : 'Transmitir ao PC'}</span>
          </button>
          <div className="cam-row">
            <button type="button" className="bigbtn" onClick={() => void camera.flip()}><Icon name="swap" size={24} /><span>Virar câmera</span></button>
            <div className="chips" data-group="quality">
              {(Object.entries(QUALITIES) as Array<[Quality, { label: string }]>).map(([key, value]) => (
                <button key={key} type="button" className="chip big-chip" aria-pressed={key === state.quality} onClick={() => camera.setQuality(key)}>{value.label}</button>
              ))}
            </div>
          </div>
          <div className="cam-row">
            <span className="cam-label">Quadros por segundo</span>
            <div className="chips" data-group="fps">
              {FPS_OPTIONS.map((fps) => (
                <button key={fps} type="button" className="chip big-chip" aria-pressed={fps === state.fps} onClick={() => void camera.setFps(fps)}>{fps} fps</button>
              ))}
            </div>
          </div>
          {/* two ways to reach the PC's apps; both are fed at the same time, use whichever one the app can see */}
          <div className="cam-dest">
            <div className="cam-dest-text">
              <b>Câmera virtual direta</b>
              <small className="muted">
                {direct.installed
                  ? `Instalada como “${direct.name}”: escolha-a no Discord, Zoom, navegador…${direct.inUse ? ' · em uso agora' : ''}`
                  : 'Aparece como webcam em qualquer app, sem OBS. Instala uma vez (administrador).'}
              </small>
            </div>
            {direct.installed
              ? <HoldButton label="Segure p/ remover" className="cam-act" onDone={() => void directAction('uninstall')} />
              : <HoldButton label="Segure p/ instalar" className="cam-act" onDone={() => void directAction('install')} />}
          </div>
          <div className="cam-dest">
            <div className="cam-dest-text"><b>Via OBS</b><small className="muted">Captura de navegador + Iniciar câmera virtual</small></div>
            <button type="button" className="cam-act" onClick={() => void copyLink()}><span>Copiar link</span></button>
          </div>
          <div className="cam-status muted">{state.statusText}</div>
        </div>
      </section>
    </Overlay>
  );
}
