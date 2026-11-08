'use strict';

// The pairing page (pair.html): shown instead of the deck while this browser has no token, e.g. a Home Screen app on iPhone, which
// keeps its own cookies apart from Safari. The code (or the whole pairing link) goes to the server as ?token=..., which stores the
// cookie and returns to the deck; a wrong one comes back here with ?error=1.
(() => {
  const input = document.getElementById('code');
  if (new URLSearchParams(location.search).has('error')) document.getElementById('error').hidden = false;

  /** The token from what was pasted: the code itself, or the "token" parameter of a pairing link. */
  function tokenFrom(text) {
    const value = String(text || '').trim();
    try {
      const fromLink = new URL(value).searchParams.get('token');
      if (fromLink) return fromLink;
    } catch {
      // not a link: it is the code
    }
    return value;
  }

  document.getElementById('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const token = tokenFrom(input.value);
    if (token) location.replace(`/?token=${encodeURIComponent(token)}`);
  });
})();
