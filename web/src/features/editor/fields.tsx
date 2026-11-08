import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '../../ui/Icon';
import { MEDIA, MODS, MUTE, WAITS, ZONES, STEP_TYPES, composeKeys, parseKeys, type EditorData, type MacroStep } from './model';

type Option<T> = readonly [T, string];

export function Field({ text, children }: { text: string; children: ReactNode }) {
  return <label className="ed-field"><span>{text}</span>{children}</label>;
}

/** A native select whose options keep their real values (booleans, numbers): the DOM only ever sees strings. */
export function Select<T extends string | number | boolean>({ options, value, onChange }: { options: readonly Option<T>[]; value: T; onChange: (value: T) => void }) {
  return (
    <select
      className="ed-select"
      value={String(value)}
      onChange={(event) => {
        const chosen = options.find(([option]) => String(option) === event.target.value);
        if (chosen) onChange(chosen[0]);
      }}
    >
      {options.map(([option, text]) => <option key={String(option)} value={String(option)}>{text}</option>)}
    </select>
  );
}

export function TextInput({ value, placeholder, onChange, maxLength = 40 }: { value: string; placeholder: string; onChange: (value: string) => void; maxLength?: number }) {
  return (
    <input
      type="text"
      className="ed-input"
      value={value}
      placeholder={placeholder}
      maxLength={maxLength}
      autoComplete="off"
      autoCapitalize="off"
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** Modifier chips + one key: reads and writes a spec like "ctrl+shift+m". */
export function KeyPicker({ value, onChange }: { value: string; onChange: (spec: string) => void }) {
  const { mods, key } = parseKeys(value);
  return (
    <div className="ed-keys">
      <div className="chips">
        {MODS.map(([mod, text]) => (
          <button
            key={mod}
            type="button"
            className="chip big-chip"
            aria-pressed={mods.includes(mod)}
            onClick={() => onChange(composeKeys(mods.includes(mod) ? mods.filter((item) => item !== mod) : [...mods, mod], key))}
          >
            {text}
          </button>
        ))}
      </div>
      <TextInput value={key} placeholder="tecla: a, f5, esc, enter, left…" maxLength={30} onChange={(next) => onChange(composeKeys(mods, next.trim().toLowerCase()))} />
    </div>
  );
}

const iconButton = (name: string, text: string, onClick: () => void, disabled = false) => (
  <button type="button" className="ed-ico" aria-label={text} disabled={disabled} onClick={onClick}>
    <Icon name={name} size={18} />
  </button>
);

function StepControls({ step, data, onChange }: { step: MacroStep; data: EditorData; onChange: (step: MacroStep) => void }) {
  const apps = data.apps.map((app): Option<string> => [app.id, app.name]);
  const screens = Array.from({ length: data.screens }, (_, i): Option<number> => [i, `Tela ${i + 1}`]);
  switch (step.type) {
    case 'launch':
      return <Select options={apps} value={step.app} onChange={(app) => onChange({ ...step, app })} />;
    case 'place':
      return (
        <>
          <Select options={data.apps.filter((app) => app.canPlace).map((app): Option<string> => [app.id, app.name])} value={step.app} onChange={(app) => onChange({ ...step, app })} />
          <Select options={screens} value={step.monitor} onChange={(monitor) => onChange({ ...step, monitor })} />
          <Select options={ZONES} value={step.zone} onChange={(zone) => onChange({ ...step, zone })} />
        </>
      );
    case 'keys':
      return <KeyPicker value={step.keys} onChange={(keys) => onChange({ ...step, keys })} />;
    case 'media':
      return <Select options={MEDIA} value={step.key} onChange={(key) => onChange({ ...step, key })} />;
    case 'volume':
      return (
        <div className="ed-slider">
          <input type="range" min={0} max={100} value={step.level} className="range" style={{ '--fill': `${step.level}%` } as CSSProperties} onChange={(event) => onChange({ ...step, level: Number(event.target.value) })} />
          <span className="value">{`${step.level}%`}</span>
        </div>
      );
    case 'mute':
    case 'mic':
      return <Select options={MUTE} value={step.muted} onChange={(muted) => onChange({ ...step, muted })} />;
    case 'output': {
      const options: Option<string>[] = [...data.devices.playback.map((d): Option<string> => [d.id, `Saída: ${d.name}`]), ...data.devices.capture.map((d): Option<string> => [d.id, `Entrada: ${d.name}`])];
      if (step.device && !options.some(([id]) => id === step.device)) options.unshift([step.device, `${step.name || 'Dispositivo'} (não encontrado agora)`]);
      return (
        <Select
          options={options}
          value={step.device}
          onChange={(device) => {
            const found = [...data.devices.playback, ...data.devices.capture].find((d) => d.id === device);
            onChange({ ...step, device, name: found ? found.name : step.name });
          }}
        />
      );
    }
    case 'wait':
      return <Select options={WAITS} value={step.ms} onChange={(ms) => onChange({ ...step, ms })} />;
    case 'camera':
      return <Select options={[[true, 'Ligar a câmera'], [false, 'Desligar a câmera']] as const} value={step.on} onChange={(on) => onChange({ ...step, on })} />;
    default:
      return null;
  }
}

interface StepRowProps {
  step: MacroStep;
  index: number;
  count: number;
  data: EditorData;
  onChange: (step: MacroStep) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}

/** One step of a macro: its kind, the controls of that kind, and up / down / remove. */
export function StepRow({ step, index, count, data, onChange, onMove, onRemove }: StepRowProps) {
  const meta = STEP_TYPES.find(([type]) => type === step.type);
  return (
    <div className="ed-step">
      <div className="ed-step-head">
        <b>{`${index + 1}. ${meta ? meta[1] : step.type}`}</b>
        <div className="ed-step-tools">
          {iconButton('up', 'Subir', () => onMove(-1), index === 0)}
          {iconButton('down', 'Descer', () => onMove(1), index === count - 1)}
          {iconButton('close', 'Remover passo', onRemove)}
        </div>
      </div>
      <div className="ed-step-body"><StepControls step={step} data={data} onChange={onChange} /></div>
    </div>
  );
}

/** "Excluir" asks twice: the second tap, within 3 s, deletes. */
export function DeleteButton({ onDelete, armMs }: { onDelete: () => void; armMs: number }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="ed-delete"
      data-armed={String(armed)}
      onClick={() => {
        clearTimeout(timer.current);
        if (armed) { setArmed(false); onDelete(); return; }
        setArmed(true);
        timer.current = setTimeout(() => setArmed(false), armMs);
      }}
    >
      {armed ? 'Toque de novo' : 'Excluir'}
    </button>
  );
}
