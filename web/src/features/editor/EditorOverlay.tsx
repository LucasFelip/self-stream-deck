import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, call, client } from '../../api/client';
import { Icon } from '../../ui/Icon';
import { Overlay } from '../../ui/Overlay';
import { useToast } from '../../ui/Toast';
import { DECK_QUERIES } from '../deck/data';
import { useDeckActions } from '../deck/useDeckActions';
import { editStore, useEditorOpen } from './editStore';
import { DeleteButton, Field, KeyPicker, StepRow, TextInput } from './fields';
import {
  ARM_MS, STEP_TYPES, TABS, describeKeys, makeStep, moveItem, stepWord, tabFor,
  type EditorApp, type EditorData, type MacroDraft, type MacroStep, type ShortcutDraft, type Tab,
} from './model';

interface Lists { shortcuts: ShortcutDraft[]; macros: MacroDraft[]; apps: EditorApp[] }

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Button editor ("Editar botões"): create, change and delete keyboard shortcuts and macros, and hide apps, all from the phone. Everything is
 * saved through /api/editor/*, where the PC validates it against a whitelist; a macro is a list of steps picked from fixed kinds (open an
 * app, press keys, volume, audio output, place a window, wait, camera...), never a free-form command. Opened from edit mode, on the tapped key.
 */
export function EditorOverlay() {
  const open = useEditorOpen();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { tap } = useDeckActions();

  const [data, setData] = useState<EditorData | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [lists, setLists] = useState<Lists>({ shortcuts: [], macros: [], apps: [] });
  const [tab, setTab] = useState<Tab>('shortcuts');
  const [selected, setSelected] = useState({ shortcuts: 0, macros: 0 });
  const [dirty, setDirty] = useState(false);
  const form = useRef<HTMLDivElement | null>(null);
  const focusNew = useRef(false);

  const close = useCallback(() => editStore.closeEditor(), []);

  // every time it opens: read what the PC has and select what edit mode pointed at
  useEffect(() => {
    if (!open) return undefined;
    const want = editStore.target;
    let cancelled = false;
    setData(null);
    setFailure(null);
    setDirty(false);
    call(client.GET('/api/editor')).then((reply) => {
      if (cancelled) return;
      const next: Lists = { shortcuts: clone(reply.shortcuts), macros: clone(reply.macros), apps: clone(reply.apps) };
      const where = tabFor(want, next);
      const picked = { shortcuts: 0, macros: 0 };
      if (where.selected !== undefined && (where.tab === 'shortcuts' || where.tab === 'macros')) picked[where.tab] = where.selected;
      if (want && 'create' in want) {
        if (where.tab === 'shortcuts') next.shortcuts.push({ label: '', keys: '' });
        else next.macros.push({ label: '', page: 'apps', steps: [makeStep('launch', reply)] });
        picked[where.tab as 'shortcuts' | 'macros'] = next[where.tab as 'shortcuts' | 'macros'].length - 1;
        setDirty(true);
        focusNew.current = true;
      }
      setData(reply);
      setLists(next);
      setSelected(picked);
      setTab(where.tab);
    }).catch((error: unknown) => {
      if (!cancelled) setFailure(error instanceof ApiError && error.status === 403 ? 'O editor está desligado no config.json ("editor": false).' : `Não foi possível carregar: ${errorText(error)}`);
    });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (data && focusNew.current) {
      focusNew.current = false;
      form.current?.querySelector('input')?.focus();
    }
  }, [data, lists]);

  const change = (update: (draft: Lists) => void) => {
    setLists((previous) => {
      const draft = clone(previous);
      update(draft);
      return draft;
    });
    setDirty(true);
  };

  /** Saves the list of the current tab (the working copy, or `from` when the caller has just changed it). Returns what the PC kept, or null. */
  async function save(from: Lists = lists): Promise<Lists | null> {
    try {
      let saved = from;
      if (tab === 'shortcuts') {
        const { shortcuts } = await call(client.POST('/api/editor/shortcuts', { body: { items: from.shortcuts as Array<{ id?: string; label: string; keys: string }> } }));
        saved = { ...from, shortcuts: clone(shortcuts) };
      } else if (tab === 'macros') {
        const { macros } = await call(client.POST('/api/editor/macros', { body: { items: from.macros } }));
        saved = { ...from, macros: clone(macros) };
      } else {
        await call(client.POST('/api/editor/apps', { body: { hidden: from.apps.filter((app) => app.hidden).map((app) => app.id) } }));
      }
      setLists(saved);
      setDirty(false);
      setSelected((previous) => ({ shortcuts: Math.min(previous.shortcuts, Math.max(0, saved.shortcuts.length - 1)), macros: Math.min(previous.macros, Math.max(0, saved.macros.length - 1)) }));
      toast('Salvo');
      for (const key of DECK_QUERIES) void queryClient.invalidateQueries({ queryKey: [key] });
      return saved;
    } catch (error) {
      toast(`Não salvou: ${errorText(error)}`, true);
      return null;
    }
  }

  // saves first (a new item only gets its id from the PC), then runs it once
  async function testItem() {
    const saved = await save();
    if (!saved) return;
    if (tab === 'shortcuts') {
      const item = saved.shortcuts[selected.shortcuts];
      if (!item?.id) return;
      await tap({ kind: 'shortcut', key: `s:${item.id}`, id: item.id, label: item.label, display: item.keys });
      toast(`Apertou ${item.keys}`);
    } else if (tab === 'macros') {
      const item = saved.macros[selected.macros];
      if (item?.id) await tap({ kind: 'macro', key: `m:${item.id}`, id: item.id, label: item.label, steps: item.steps.length });
    }
  }

  const shortcutAt = lists.shortcuts[selected.shortcuts];
  const macroAt = lists.macros[selected.macros];

  const renderList = () => {
    if (tab === 'apps') {
      return lists.apps.map((app, index) => (
        <div key={app.id} className={`ed-row${app.hidden ? ' off' : ''}`}>
          <span className="ed-appicon">{app.hasIcon ? <img src={`/api/icon/${app.id}?v=${app.iconVersion || ''}`} alt="" /> : <b>{app.name.charAt(0).toUpperCase()}</b>}</span>
          <span className="ed-main"><b>{app.name}</b><small className="muted">{app.hidden ? 'oculto' : 'visível'}</small></span>
          <button type="button" className="ed-ico wide" aria-label={app.hidden ? 'Mostrar' : 'Ocultar'} onClick={() => change((draft) => { const target = draft.apps[index]; if (target) target.hidden = !target.hidden; })}>
            <span>{app.hidden ? 'Mostrar' : 'Ocultar'}</span>
          </button>
        </div>
      ));
    }
    const items = tab === 'shortcuts' ? lists.shortcuts : lists.macros;
    return items.map((item, index) => (
      <div key={item.id ?? `new${index}`} className="ed-row" role="button" tabIndex={0} aria-pressed={index === selected[tab]} onClick={() => setSelected((previous) => ({ ...previous, [tab]: index }))}>
        <span className="ed-main">
          <b>{item.label || '(sem nome)'}</b>
          <small className="muted">
            {tab === 'shortcuts'
              ? (item as ShortcutDraft).keys || 'sem teclas'
              : `${stepWord((item as MacroDraft).steps.length)} · ${(item as MacroDraft).page === 'apps' ? 'tela Apps' : 'tela Atalhos'}`}
          </small>
        </span>
      </div>
    ));
  };

  const remove = () => {
    const key = tab === 'macros' ? 'macros' : 'shortcuts';
    const index = selected[key];
    const next = { ...lists, [key]: lists[key].filter((_, i) => i !== index) } as Lists;
    setLists(next);
    setSelected((previous) => ({ ...previous, [key]: Math.max(0, previous[key] - 1) }));
    void save(next); // saved straight away, with the item gone
  };

  const actions = (
    <div className="ed-actions">
      <button type="button" className="ed-test" onClick={() => void testItem()}>Testar</button>
      <DeleteButton onDelete={remove} armMs={ARM_MS} />
      <button type="button" className="ed-save" data-dirty={String(dirty)} onClick={() => void save()}>Salvar</button>
    </div>
  );

  const renderForm = () => {
    if (failure) return <p className="muted ed-hint">{failure}</p>;
    if (!data) return null;
    if (tab === 'apps') {
      return (
        <>
          <h3>Apps</h3>
          <p className="muted ed-hint">Oculte o que você não usa. Para mudar a posição de um botão, segure-o na tela e arraste: não precisa vir aqui.</p>
          <div className="ed-actions"><button type="button" className="ed-save" data-dirty={String(dirty)} onClick={() => void save()}>Salvar</button></div>
        </>
      );
    }
    if (tab === 'shortcuts') {
      if (!shortcutAt) {
        return (<><h3>Atalhos</h3><p className="muted ed-hint">Um atalho aperta uma combinação de teclas no PC. Toque em “Novo atalho”.</p></>);
      }
      return (
        <>
          <Field text="Nome"><TextInput value={shortcutAt.label} placeholder="ex.: Mutar no Discord" onChange={(label) => change((draft) => { const item = draft.shortcuts[selected.shortcuts]; if (item) item.label = label; })} /></Field>
          <div className="ed-field">
            <span>Teclas</span>
            <KeyPicker value={shortcutAt.keys} onChange={(keys) => change((draft) => { const item = draft.shortcuts[selected.shortcuts]; if (item) item.keys = keys; })} />
            <small className="muted ed-preview">{describeKeys(shortcutAt.keys)}</small>
          </div>
          {actions}
        </>
      );
    }
    if (!macroAt) {
      return (<><h3>Macros</h3><p className="muted ed-hint">Uma macro faz uma sequência de passos com um toque: abrir apps, posicionar janelas, trocar a saída de áudio, ligar a câmera… Toque em “Nova macro”.</p></>);
    }
    const setStep = (index: number, step: MacroStep) => change((draft) => { const item = draft.macros[selected.macros]; if (item) item.steps[index] = step; });
    return (
      <>
        <Field text="Nome"><TextInput value={macroAt.label} placeholder="ex.: Call de trabalho" onChange={(label) => change((draft) => { const item = draft.macros[selected.macros]; if (item) item.label = label; })} /></Field>
        <div className="ed-field">
          <span>Aparece na tela</span>
          <div className="chips">
            {([['shortcuts', 'Atalhos'], ['apps', 'Apps']] as const).map(([page, text]) => (
              <button key={page} type="button" className="chip big-chip" aria-pressed={(macroAt.page || 'shortcuts') === page} onClick={() => change((draft) => { const item = draft.macros[selected.macros]; if (item) item.page = page; })}>{text}</button>
            ))}
          </div>
        </div>
        <div className="ed-steps">
          {macroAt.steps.map((step, index) => (
            <StepRow
              key={index}
              step={step}
              index={index}
              count={macroAt.steps.length}
              data={data}
              onChange={(next) => setStep(index, next)}
              onMove={(by) => change((draft) => { const item = draft.macros[selected.macros]; if (item) item.steps = moveItem(item.steps, index, by); })}
              onRemove={() => change((draft) => { draft.macros[selected.macros]?.steps.splice(index, 1); })}
            />
          ))}
        </div>
        <select
          className="ed-select"
          value=""
          onChange={(event) => {
            const type = STEP_TYPES.find(([id]) => id === event.target.value)?.[0];
            if (type) change((draft) => { draft.macros[selected.macros]?.steps.push(makeStep(type, data)); });
          }}
        >
          <option value="">＋ Adicionar passo…</option>
          {STEP_TYPES.map(([type, text]) => <option key={type} value={type}>{text}</option>)}
        </select>
        {actions}
      </>
    );
  };

  return (
    <Overlay open={open} title="Editar botões" onClose={close}>
      <section className="editor-page">
        <div className="ed-left">
          <div className="ed-tabs">
            {TABS.map(([id, text]) => <button key={id} type="button" className="chip big-chip" aria-pressed={id === tab} onClick={() => setTab(id)}>{text}</button>)}
          </div>
          <div className="ed-list scroll">{renderList()}</div>
          <button
            type="button"
            className="ed-add"
            hidden={tab === 'apps'}
            onClick={() => {
              const key = tab === 'macros' ? 'macros' : 'shortcuts';
              change((draft) => {
                if (key === 'shortcuts') draft.shortcuts.push({ label: '', keys: '' });
                else if (data) draft.macros.push({ label: '', page: 'shortcuts', steps: [makeStep('launch', data)] });
              });
              setSelected((previous) => ({ ...previous, [key]: lists[key].length }));
              focusNew.current = true;
            }}
          >
            <Icon name="plus" size={18} />
            <span>{tab === 'shortcuts' ? 'Novo atalho' : 'Nova macro'}</span>
          </button>
        </div>
        <div className="card ed-form" ref={form}>{renderForm()}</div>
      </section>
    </Overlay>
  );
}
