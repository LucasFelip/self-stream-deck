import type { components } from '../../api/schema';

export type AudioDevice = components['schemas']['AudioDevice'];

interface DeviceListProps {
  devices: readonly AudioDevice[];
  emptyText: string;
  onPick: (device: AudioDevice) => void;
}

/** Radio-style chips of devices, the default one lit. A tap on the default one does nothing. */
export function DeviceList({ devices, emptyText, onPick }: DeviceListProps) {
  return (
    <div className="device-list" role="radiogroup">
      {devices.length === 0 ? <div className="audio-empty">{emptyText}</div> : null}
      {devices.map((device) => (
        <button
          key={device.id}
          type="button"
          className="device"
          role="radio"
          aria-checked={device.default}
          onClick={() => { if (!device.default) onPick(device); }}
        >
          <span className="mark" />
          <span className="name">
            {device.name}
            {device.adapter ? <small>{device.adapter}</small> : null}
          </span>
        </button>
      ))}
    </div>
  );
}
