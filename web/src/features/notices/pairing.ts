import { call, client } from '../../api/client';

/**
 * Menu > "Código de pareamento": copies the pairing code, for a Home Screen app on iPhone. That app keeps its own cookies apart from Safari,
 * so on its first start it shows the pairing page (pair.html); the code copied here goes into that page once. Shown only on iOS: the Android
 * app pairs by itself and a desktop browser has no need.
 */
export async function copyPairingCode(toast: (message: string, isError?: boolean, ms?: number) => void): Promise<void> {
  try {
    const { code } = await call(client.GET('/api/pair-code'));
    try {
      await navigator.clipboard.writeText(code);
      toast('Código copiado. Cole na tela de pareamento do app');
    } catch {
      // no clipboard (not a secure context, or refused): show it so it can be typed
      toast(`Código: ${code}`, false, 15000);
    }
  } catch {
    toast('Não foi possível obter o código', true);
  }
}
