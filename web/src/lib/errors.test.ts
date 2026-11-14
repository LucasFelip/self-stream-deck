import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { errorText } from './errors';

describe('errorText', () => {
  it('keeps the reason the agent gave for a refusal', () => {
    expect(errorText(new ApiError(400, 'level must be a number'))).toBe('level must be a number');
    expect(errorText(new ApiError(403, 'the editor is turned off in config.json'))).toBe('the editor is turned off in config.json');
    expect(errorText(new ApiError(404, 'unknown app'))).toBe('unknown app');
  });

  it('says in Portuguese what a status alone means', () => {
    expect(errorText(new ApiError(401, 'unauthorized'))).toBe('o painel perdeu o pareamento com o PC');
    expect(errorText(new ApiError(429, 'too many attempts, try again in a minute'))).toBe('muitas tentativas; aguarde um minuto');
    expect(errorText(new ApiError(413, 'body too large'))).toBe('o envio é grande demais para o PC');
  });

  it('never shows the browser\'s "Failed to fetch"', () => {
    expect(errorText(new TypeError('Failed to fetch'))).toBe('o PC não respondeu');
    expect(errorText(new DOMException('The user aborted a request.', 'AbortError'))).toBe('o pedido foi interrompido');
  });

  it('falls back to the message, or to the value itself', () => {
    expect(errorText(new Error('algo'))).toBe('algo');
    expect(errorText('texto')).toBe('texto');
    expect(errorText(undefined)).toBe('undefined');
  });
});
