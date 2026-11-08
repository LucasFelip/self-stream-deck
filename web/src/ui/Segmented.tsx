interface SegmentedProps<T extends string> {
  items: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
  label: string;
}

/** A segmented selector ("Lista | Mapa", "Desempenho | Processos | Sistema"): one 48 px button per item, exactly one selected. */
export function Segmented<T extends string>({ items, value, onChange, label }: SegmentedProps<T>) {
  return (
    <div className="seg" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button key={item.id} type="button" className="seg-btn" role="tab" data-seg={item.id} aria-selected={item.id === value} onClick={() => onChange(item.id)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}
