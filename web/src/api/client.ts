import createClient from 'openapi-fetch';
import type { paths } from './schema';

/** An answer the agent refused or could not give: `status` is the HTTP code, `message` the agent's `{ error }` (or the status text). */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// Types come from contracts/openapi.yaml (npm run gen:api): a path or a body the contract does not know does not compile.
// Relative URLs on purpose: the page is served by the agent itself (same origin, so the pairing cookie travels along).
export const client = createClient<paths>({ baseUrl: '', credentials: 'same-origin' });

const messageOf = (error: unknown): string | undefined => {
  if (error && typeof error === 'object' && 'error' in error && typeof (error as { error: unknown }).error === 'string') {
    return (error as { error: string }).error;
  }
  return undefined;
};

/** Awaits an openapi-fetch call and returns its data, or throws an ApiError for any non-2xx answer. */
export async function call<T>(request: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await request;
  if (!response.ok) throw new ApiError(response.status, messageOf(error) ?? (response.statusText || `HTTP ${response.status}`));
  return data as T;
}
