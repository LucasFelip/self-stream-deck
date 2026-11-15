import { useState } from 'react';
import { Overlay } from '../../ui/Overlay';
import { Segmented } from '../../ui/Segmented';
import { ACCENTS, SIZES, applyLook, readLook, saveLook, type AccentId, type Look, type SizeId } from './appearance';

interface AppearanceSheetProps {
  open: boolean;
  onClose: () => void;
}

/** Menu > Aparência…: the accent color and the size of the text, for this phone. The choice shows at once and is kept. */
export function AppearanceSheet({ open, onClose }: AppearanceSheetProps) {
  const [look, setLook] = useState<Look>(readLook);
  const choose = (next: Look) => {
    setLook(next);
    applyLook(next);
    saveLook(next);
  };
  return (
    <Overlay open={open} title="Aparência" onClose={onClose}>
      <section className="look-page">
        <h4>Cor de destaque</h4>
        <div className="swatches" role="radiogroup" aria-label="Cor de destaque">
          {ACCENTS.map((accent) => (
            <button
              key={accent.id}
              type="button"
              role="radio"
              className="swatch"
              data-accent={accent.id}
              aria-checked={accent.id === look.accent}
              aria-label={accent.label}
              style={{ '--swatch': accent.hex } as React.CSSProperties}
              onClick={() => choose({ ...look, accent: accent.id as AccentId })}
            />
          ))}
        </div>
        <h4>Tamanho do texto</h4>
        <Segmented items={SIZES} value={look.size} onChange={(size: SizeId) => choose({ ...look, size })} label="Tamanho do texto" />
        <p className="muted">Vale só para este aparelho.</p>
      </section>
    </Overlay>
  );
}
