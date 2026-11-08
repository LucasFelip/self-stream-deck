import { useState } from 'react';
import { Icon } from '../../ui/Icon';
import { RangeSlider } from '../../ui/RangeSlider';

interface VolumeRowProps {
  /** the app's name in the mixer; the output and input rows have none */
  label?: string;
  /** [icon when sound is on, icon when muted] */
  icons: readonly [string, string];
  level: number | undefined;
  muted: boolean | undefined;
  /** a mixer row of an app that is not making sound right now */
  inactive?: boolean;
  onLevel: (level: number) => Promise<unknown> | void;
  onMute: (muted: boolean) => void;
}

/** One line: [mute] [label] [slider] [value]. The value shows "mudo" while muted and the dragged position while dragging. */
export function VolumeRow({ label, icons, level, muted, inactive = false, onLevel, onMute }: VolumeRowProps) {
  const [dragLevel, setDragLevel] = useState<number | null>(null);
  const isMuted = dragLevel === null && Boolean(muted);
  const known = level !== undefined && Number.isFinite(level);

  let text = '–';
  if (dragLevel !== null) text = `${dragLevel}%`;
  else if (known) text = isMuted ? 'mudo' : `${level}%`;

  return (
    <div className={`vol-row${label ? ' labeled' : ''}${inactive ? ' inactive' : ''}`} data-muted={String(isMuted)}>
      <button type="button" className="icon-btn" aria-pressed={isMuted} aria-label="Silenciar" onClick={() => onMute(!muted)}>
        <Icon name={isMuted ? icons[1] : icons[0]} />
      </button>
      {label ? <span className="label">{label}</span> : null}
      <RangeSlider value={level} disabled={!known} onChange={onLevel} onDrag={setDragLevel} />
      <span className="value">{text}</span>
    </div>
  );
}
