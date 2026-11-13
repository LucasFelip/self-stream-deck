import { useQueryClient } from '@tanstack/react-query';
import { call, client } from '../../api/client';
import { useToast } from '../../ui/Toast';
import { camera } from '../camera/controller';
import type { DeckItem } from './items';
import { errorText } from '../../lib/errors';


/** What a tap on a key does: start or focus an app, press a shortcut, run a macro. Always by id; the PC decides what the id means. */
export function useDeckActions(): { tap: (item: DeckItem) => Promise<void> } {
  const toast = useToast();
  const queryClient = useQueryClient();
  // the "running" dot appears once the window exists
  const refreshStateSoon = (ms: number) => setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['state'] }), ms);

  async function tap(item: DeckItem): Promise<void> {
    try {
      if (item.kind === 'app') {
        const { action } = await call(client.POST('/api/launch/{id}', { params: { path: { id: item.id } } }));
        toast(action === 'focused' ? `${item.label} em primeiro plano` : `Abrindo ${item.label}`);
        refreshStateSoon(1500);
      } else if (item.kind === 'camera') {
        const text = await camera.toggle();
        if (text) toast(text);
      } else if (item.kind === 'shortcut') {
        await call(client.POST('/api/shortcut/{id}', { params: { path: { id: item.id } } }));
      } else {
        const outcome = await call(client.POST('/api/macro/{id}', { params: { path: { id: item.id } } }));
        const failed = outcome.steps.filter((step) => !step.ok);
        // the steps of type "camera" are for the phone: the PC hands them back
        for (const step of outcome.client) if (step.type === 'camera') await camera.setSending(step.on);
        if (failed.length) toast(`${item.label}: ${failed.length} de ${outcome.steps.length} passos falharam (${failed[0]?.error ?? ''})`, true);
        else toast(`${item.label} ✓`);
        refreshStateSoon(800);
      }
    } catch (error) {
      toast(`Erro: ${errorText(error)}`, true);
    }
  }
  return { tap };
}
