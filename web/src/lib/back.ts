/**
 * The Back stack. The Android Back button (MainActivity calls `Deck.back()`) and any "go back" gesture undo one thing per call,
 * newest first: the sheet, the menu, an overlay, edit mode; with nothing open, any page but Apps goes to Apps.
 * Whatever can be undone registers a handler while it is open; a handler returns true when it undid something.
 */
type Handler = () => boolean;

const handlers: Handler[] = [];

export function registerBack(handler: Handler): () => void {
  handlers.push(handler);
  return () => {
    const at = handlers.lastIndexOf(handler);
    if (at !== -1) handlers.splice(at, 1);
  };
}

/** true if something was undone, false if there was nothing to undo (the shell then ignores the press: a stray Back must not drop the deck) */
export function runBack(): boolean {
  for (let i = handlers.length - 1; i >= 0; i -= 1) {
    const handler = handlers[i];
    if (handler && handler()) return true;
  }
  return false;
}
