import { useQueryClient } from '@tanstack/react-query';
import { call, client } from '../../api/client';
import type { components } from '../../api/schema';
import { useToast } from '../../ui/Toast';
import { DeviceList, type AudioDevice } from './DeviceList';
import { VolumeRow } from './VolumeRow';

type Audio = components['schemas']['Audio'];

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The three cards of the audio half of the Som page: Saída, Entrada and the per-app mixer (Windows' Sound settings, from the phone). */
export function AudioCards({ audio }: { audio: Audio | undefined }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const reload = () => queryClient.invalidateQueries({ queryKey: ['audio'] });

  const playback = audio?.playback ?? [];
  const capture = audio?.capture ?? [];
  const sessions = audio?.sessions ?? [];
  const playbackDefault = playback.find((device) => device.default);
  const captureDefault = capture.find((device) => device.default);

  async function pick(device: AudioDevice, announce: string) {
    try {
      await call(client.POST('/api/audio/default', { body: { id: device.id } }));
      toast(`${announce}: ${device.name}`);
    } catch (error) {
      toast(`Erro: ${errorText(error)}`, true);
    }
    void reload();
  }

  const setDevice = (device: AudioDevice | undefined, body: { level?: number; muted?: boolean }) => (
    device ? call(client.POST('/api/audio/device', { body: { id: device.id, ...body } })) : undefined
  );
  const muteDevice = (device: AudioDevice | undefined) => (muted: boolean) => {
    setDevice(device, { muted })?.then(reload, (error) => toast(`Erro: ${errorText(error)}`, true));
  };

  return (
    <section className="audio-page">
      <div className="card audio-out">
        <h3>Saída</h3>
        <VolumeRow
          icons={['speaker', 'muted']}
          level={playbackDefault?.level}
          muted={playbackDefault?.muted}
          onLevel={(level) => setDevice(playbackDefault, { level })}
          onMute={muteDevice(playbackDefault)}
        />
        <div className="scroll">
          <DeviceList devices={playback} emptyText="Nenhuma saída de áudio ativa." onPick={(device) => void pick(device, 'Saída')} />
        </div>
      </div>

      <div className="card audio-in">
        <h3>Entrada</h3>
        <VolumeRow
          icons={['mic', 'micOff']}
          level={captureDefault?.level}
          muted={captureDefault?.muted}
          onLevel={(level) => setDevice(captureDefault, { level })}
          onMute={muteDevice(captureDefault)}
        />
        <div className="scroll">
          <DeviceList devices={capture} emptyText="Nenhum microfone ativo." onPick={(device) => void pick(device, 'Microfone')} />
        </div>
      </div>

      <div className="card audio-mixer">
        <h3>Aplicativos</h3>
        <div className="scroll">
          <div className="mixer">
            {sessions.map((session) => {
              // the system sounds have no process; an app is named by its pid
              const target = session.system ? { system: true } : { pid: session.pid };
              return (
                <VolumeRow
                  key={session.system ? 'system' : session.pid}
                  label={session.label}
                  icons={['speaker', 'muted']}
                  level={session.level}
                  muted={session.muted}
                  inactive={!session.active}
                  onLevel={(level) => call(client.POST('/api/audio/session', { body: { ...target, level } }))}
                  onMute={(muted) => {
                    call(client.POST('/api/audio/session', { body: { ...target, muted } })).then(reload, (error) => toast(`Erro: ${errorText(error)}`, true));
                  }}
                />
              );
            })}
            {audio && sessions.length === 0 ? <div className="audio-empty">Nenhum aplicativo com áudio aberto.</div> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
