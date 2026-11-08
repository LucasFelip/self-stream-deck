import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { call, client } from '../../api/client';
import { Icon } from '../../ui/Icon';
import { RangeSlider } from '../../ui/RangeSlider';
import type { Screen, Win, Zone } from './geometry';
import type { WindowsController } from './controller';
import { BRIGHT_H, DRAG_THRESHOLD, computeLayout, monitorAt, onMap, toMap, zoneAt, type Layout } from './model';
import { WindowIcon } from './WindowIcon';

interface DragState {
  handle: number;
  dx: number;
  dy: number;
  hint: { index: number; zone: Zone | null } | null;
}

interface DragRef {
  win: Win;
  x: number;
  y: number;
  pointerId: number;
  moved: boolean;
  finishing: boolean;
}

const px = (value: number): string => `${value}px`;

function Brightness({ screen, left, top, width }: { screen: Screen; left: number; top: number; width: number }) {
  const [dragging, setDragging] = useState<number | null>(null);
  const known = screen.brightness !== null && screen.brightness !== undefined;
  return (
    <div className="mon-bright" style={{ left: px(left), top: px(top), width: px(width) }}>
      <Icon name="sun" size={15} />
      {known ? (
        <RangeSlider value={screen.brightness ?? undefined} onChange={(level) => call(client.POST('/api/screens/brightness', { body: { device: screen.device, level } }))} onDrag={setDragging} />
      ) : (
        <span className="muted small" title="Este monitor não aceita controle de brilho (DDC/CI)">sem controle de brilho</span>
      )}
      <span className="value">{known ? `${dragging ?? screen.brightness}%` : ''}</span>
    </div>
  );
}

interface WindowMapProps {
  controller: WindowsController;
}

/**
 * A to-scale map of the screens with every window drawn where it really is. Tap a window to select it; drag it to move it, also from one
 * screen to another; drag it to a screen's edge to snap it (left half, right half) or to the top to maximize.
 */
export function WindowMap({ controller }: WindowMapProps) {
  const { screens, windows, selected } = controller;
  const wrap = useRef<HTMLDivElement | null>(null);
  const map = useRef<HTMLDivElement | null>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragRef | null>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // the map only has a size while its pane is showing (portrait, list pane: none), and drawing at size 0 would empty it
  useLayoutEffect(() => {
    const element = wrap.current;
    if (!element) return undefined;
    const measure = () => setRoom({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => clearTimeout(watchdog.current), []);

  const layout: Layout | null = computeLayout(screens, room);
  const latest = useRef({ layout, windows, controller });
  latest.current = { layout, windows, controller };

  function end() {
    clearTimeout(watchdog.current);
    dragRef.current = null;
    setDrag(null);
    latest.current.controller.setDragging(false);
  }

  function begin(event: PointerEvent<HTMLDivElement>, win: Win) {
    event.preventDefault();
    if (dragRef.current && !dragRef.current.finishing) end(); // a previous gesture that never ended must not block this one
    latest.current.controller.select(win.handle);
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const state: DragRef = { win, x: event.clientX, y: event.clientY, pointerId: event.pointerId, moved: false, finishing: false };
    dragRef.current = state;
    latest.current.controller.setDragging(true);
    // a drag that has been "in progress" for 10 s is a lost gesture: forget it
    clearTimeout(watchdog.current);
    watchdog.current = setTimeout(() => { if (dragRef.current === state && !state.finishing) end(); }, 10_000);
  }

  function move(event: PointerEvent<HTMLDivElement>, win: Win) {
    const state = dragRef.current;
    const current = latest.current;
    if (!state || state.win.handle !== win.handle || !current.layout || !map.current) return; // the gesture ended while this event was on its way
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    state.moved = true;
    const box = map.current.getBoundingClientRect();
    const index = monitorAt(screens, current.layout, event.clientX - box.left, event.clientY - box.top);
    const zone = zoneAt(screens, current.layout, index, event.clientX - box.left, event.clientY - box.top);
    setDrag({ handle: win.handle, dx, dy, hint: { index, zone } });
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    const state = dragRef.current;
    const current = latest.current;
    if (!state) return; // the gesture was already ended
    const win = current.windows.find((item) => item.handle === state.win.handle) ?? state.win; // the current object, not a stale one
    state.finishing = true;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;

    // decide from where the finger really is now: the last pointermove can be a few pixels behind it
    const { layout: now, controller: ctl } = current;
    const box = map.current?.getBoundingClientRect();
    const index = now && box ? monitorAt(screens, now, event.clientX - box.left, event.clientY - box.top) : -1;
    const zone = now && box ? zoneAt(screens, now, index, event.clientX - box.left, event.clientY - box.top) : null;

    let task: (() => Promise<void>) | null = null;
    if (!state.moved) task = () => ctl.windowAction(win, 'focus');
    else if (index >= 0 && zone) task = () => ctl.snap(win, index, zone);
    else if (index >= 0 && win.state === 2) {
      if (index !== win.monitor) task = () => ctl.move(win, index);
    } else if (index >= 0 && win.state === 0 && now) {
      const x = Math.round(win.x + dx / now.scale);
      const y = Math.round(win.y + dy / now.scale);
      task = () => ctl.place(win, x, y, index);
    }

    end(); // cleared first: while a drag is active nothing from the PC is drawn
    if (task) void task();
    else ctl.refreshSoon();
  }

  function lostCapture(event: PointerEvent<HTMLDivElement>, win: Win) {
    const state = dragRef.current;
    if (!state || state.win.handle !== win.handle || state.finishing) return;
    // The browser released the capture while the finger is still down (a resize or a layout change under the finger does that):
    // take it back and the gesture goes on. Only if the element is gone for good is the drag ended instead of left hanging.
    if (!event.currentTarget.isConnected) { end(); return; }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      end(); // the pointer is not active anymore: the finger is already up
    }
  }

  const style = layout
    ? ({ width: px(layout.width), height: px(layout.height + BRIGHT_H + 6) } as CSSProperties)
    : undefined;

  return (
    <div
      className="map-wrap"
      ref={wrap}
      // tapping the empty map (not a window, not a brightness slider) clears the selection
      onPointerDown={(event) => { if (!(event.target as Element).closest('.mwin, .mon-bright')) controller.select(null); }}
    >
      <div className="map" ref={map} style={style}>
        {layout ? (
          <>
            {screens.map((screen, index) => {
              const { left, top } = toMap(layout, screen.left, screen.top);
              const width = screen.width * layout.scale;
              const height = screen.height * layout.scale;
              const hint = drag?.hint && drag.hint.index === index && drag.hint.zone ? drag.hint.zone : null;
              const hintStyle: CSSProperties = hint
                ? { display: 'block', left: hint === 'right' ? '50%' : '0', width: hint === 'full' ? '100%' : '50%', top: '0', height: '100%' }
                : { display: 'none' };
              return (
                <div key={screen.device}>
                  <div className="mon" style={{ left: px(left), top: px(top), width: px(width), height: px(height) }}>
                    <span className="mon-num">{`${index + 1}${screen.primary ? ' ★' : ''}`}</span>
                    <div className="hint" style={hintStyle} />
                  </div>
                  <Brightness screen={screen} left={left} top={layout.height + 6} width={width} />
                </div>
              );
            })}
            <div className="win-layer" style={{ width: px(layout.width), height: px(layout.height) }}>
              {onMap(windows).map((win, index) => {
                const { left, top } = toMap(layout, win.x, win.y);
                const dragging = drag?.handle === win.handle;
                return (
                  <div
                    key={win.handle}
                    className={`mwin${win.state === 2 ? ' max' : ''}${win.handle === selected ? ' sel' : ''}${dragging ? ' dragging' : ''}`}
                    data-handle={win.handle}
                    style={{ left: px(left), top: px(top), width: px(win.w * layout.scale), height: px(win.h * layout.scale), zIndex: index + 1, transform: dragging && drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined }}
                    onPointerDown={(event) => begin(event, win)}
                    onPointerMove={(event) => move(event, win)}
                    onPointerUp={finish}
                    onPointerCancel={end}
                    onLostPointerCapture={(event) => lostCapture(event, win)}
                  >
                    <div className="mwin-bar"><span className="mwin-icon"><WindowIcon win={win} /></span><span className="mwin-title">{win.title}</span></div>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
