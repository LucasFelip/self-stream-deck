import { ApiError } from '../api/client';

/**
 * What went wrong, in words for the person holding the phone. One place for every notice of the panel: the agent's own reason when it
 * gave one (it explains a refusal better than the panel could), and plain Portuguese for what the browser reports in its own terms
 * ("Failed to fetch" is the PC not answering).
 */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 401: return 'o painel perdeu o pareamento com o PC';
      case 413: return 'o envio é grande demais para o PC';
      case 429: return 'muitas tentativas; aguarde um minuto';
      default: return error.message;
    }
  }
  // fetch rejects with a TypeError when there is no answer at all (the PC is off, asleep or out of reach)
  if (error instanceof TypeError) return 'o PC não respondeu';
  if (error instanceof DOMException && error.name === 'AbortError') return 'o pedido foi interrompido';
  if (error instanceof Error) return error.message;
  return String(error);
}
