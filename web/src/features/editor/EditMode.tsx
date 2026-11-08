import { useEffect, useRef } from 'react';
import { registerBack } from '../../lib/back';
import { usePager } from '../../shell/PagerContext';
import { useToast } from '../../ui/Toast';
import { editStore, useEditing } from './editStore';

const GRID_SECTIONS = ['apps', 'shortcuts'];
const HINT_KEY = 'ssd.editHint';
const HINT = 'Toque numa tecla para editar · segure e arraste para mover';

function hintSeen(): boolean {
  try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; /* no storage: rely on the in-memory flag */ }
}

/**
 * The bar of edit mode ("Concluir"), in the flow between the notices and the pager so the pager shrinks instead of being covered, and the
 * rules of the mode: it ends with Back (after the editor sheet), with "Concluir" and when you leave Apps / Atalhos; entering it from another
 * section goes to Apps first; the first time, a tip says how to move a key.
 */
export function EditMode() {
  const editing = useEditing();
  const toast = useToast();
  const { active, goToPage, pages } = usePager();
  const hintShown = useRef(false); // also covers a WebView without storage: at most once per load

  // the mode is a class of the body (style.css draws the "+" of the empty slots from it)
  useEffect(() => {
    document.body.classList.toggle('editing', editing);
    return () => document.body.classList.remove('editing');
  }, [editing]);

  // entering from another section: Apps first; the mode ends if you leave Apps / Atalhos later (not while it is still on its way there)
  useEffect(() => {
    if (!editing) return;
    if (GRID_SECTIONS.includes(active)) { editStore.settled(); return; }
    if (editStore.entering) {
      const apps = pages.find((page) => page.section === 'apps');
      if (apps) goToPage(apps.id);
      return;
    }
    editStore.exit();
  }, [editing, active, pages, goToPage]);

  // Back: the editor sheet registers after this one, so it closes first; then the mode ends
  useEffect(() => (editing ? registerBack(() => { editStore.exit(); return true; }) : undefined), [editing]);

  useEffect(() => {
    if (!editing || hintShown.current || hintSeen()) return;
    hintShown.current = true;
    try { localStorage.setItem(HINT_KEY, '1'); } catch { /* no storage: it just shows once per load */ }
    toast(HINT);
  }, [editing, toast]);

  return (
    <div id="edit-bar" className="edit-bar" role="toolbar" aria-label="Modo de edição" hidden={!editing}>
      <span className="edit-hint">Toque numa tecla para editar · + para criar</span>
      <button id="edit-done" className="edit-done" type="button" onClick={() => editStore.exit()}>Concluir</button>
    </div>
  );
}
