import { useEffect, useRef, useState } from 'react';
import { call, client } from '../../api/client';
import { HoldButton } from '../../ui/HoldButton';
import { Icon } from '../../ui/Icon';
import { useToast } from '../../ui/Toast';
import type { Win } from './geometry';
import { CLOSE_ARM_MS, metaText } from './model';
import type { WindowsController } from './controller';
import { errorText } from '../../lib/errors';

/** A big, labelled touch target (the panel is built for a phone in a stand, not for a fingertip held an inch away). */
function Big({ label, glyph, onTap, className = '', armed }: { label: string; glyph: string; onTap: () => void; className?: string; armed?: boolean }) {
  return (
    <button type="button" className={`bigbtn ${className}`.trim()} aria-label={label} data-armed={armed ? 'true' : undefined} onClick={onTap}>
      <Icon name={glyph} size={24} />
      <span>{armed ? 'Toque de novo' : label}</span>
    </button>
  );
}

function Controls({ win, screenCount, controller }: { win: Win; screenCount: number; controller: WindowsController }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const disarm = () => { clearTimeout(timer.current); setArmed(false); };

  const screenIndex = Math.max(0, win.monitor);
  const maximized = win.state === 2;
  return (
    <>
      <div className="panel-title"><b>{win.title}</b><span className="muted">{metaText(win, screenCount)}</span></div>
      <div className="bigs">
        <Big label="Minimizar" glyph="minimize" onTap={() => void controller.windowAction(win, 'minimize')} />
        <Big label={maximized ? 'Restaurar' : 'Maximizar'} glyph={maximized ? 'restore' : 'maximize'} onTap={() => void controller.windowAction(win, maximized ? 'restore' : 'maximize')} />
        <Big label="Esquerda" glyph="snapLeft" onTap={() => void controller.snap(win, screenIndex, 'left')} />
        <Big label="Direita" glyph="snapRight" onTap={() => void controller.snap(win, screenIndex, 'right')} />
        {screenCount > 1 ? <Big label="Outra tela" glyph="swap" onTap={() => void controller.move(win, (screenIndex + 1) % screenCount)} /> : null}
        <Big
          label="Fechar"
          glyph="close"
          className="danger"
          armed={armed}
          onTap={() => {
            if (armed) { disarm(); void controller.windowAction(win, 'close'); return; }
            setArmed(true);
            timer.current = setTimeout(() => setArmed(false), CLOSE_ARM_MS);
          }}
        />
      </div>
    </>
  );
}

/**
 * The selected window's controls in big labelled buttons, or, without a selection, the screens' controls in the same spot.
 * The buttons are rebuilt only when what they do changes (not when a title does): replacing a button between the finger going
 * down and coming up would lose that tap.
 */
export function WindowPanel({ controller }: { controller: WindowsController }) {
  const toast = useToast();
  const win = controller.windows.find((candidate) => candidate.handle === controller.selected) ?? null;
  const screenCount = controller.screens.length;

  async function project(mode: 'extend' | 'clone' | 'first' | 'second', confirm = false) {
    try {
      await call(client.POST('/api/screens/project', { body: { mode, confirm } }));
      toast('Mudando a projeção…');
      setTimeout(controller.reloadScreens, 3000);
    } catch (error) {
      toast(`Erro: ${errorText(error)}`, true);
    }
  }

  const screensOff = async () => {
    try {
      await call(client.POST('/api/screens/off'));
      toast('Telas desligadas (mexa o mouse para acordar)');
    } catch (error) {
      toast(`Erro: ${errorText(error)}`, true);
    }
  };

  return (
    <>
      <div className="card win-panel" hidden={!win}>
        {win ? <Controls key={`${win.handle}:${win.state}:${win.monitor}:${screenCount}`} win={win} screenCount={screenCount} controller={controller} /> : null}
      </div>
      <div className="card" hidden={Boolean(win)}>
        <h3>Telas</h3>
        <div className="screens-extra">
          <button type="button" className="chip wide" onClick={() => void screensOff()}>Desligar telas</button>
          <button type="button" className="chip wide" onClick={() => void project('extend')}>Estender</button>
          <button type="button" className="chip wide" onClick={() => void project('clone')}>Duplicar</button>
          {/* modes that leave a single screen on: held, so nobody ends up with a black monitor by accident */}
          <HoldButton label="Só tela 1" className="small" onDone={() => void project('first', true)} />
          <HoldButton label="Só tela 2" className="small" onDone={() => void project('second', true)} />
        </div>
      </div>
    </>
  );
}
