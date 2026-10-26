'use strict';

/**
 * Shared toolkit for the deck UI: API client, toast, haptics, formatters and the page registry.
 * Page modules (media.js, audio.js, ...) register themselves here; app.js owns the pager.
 */
window.Deck = (() => {
  const $ = (id) => document.getElementById(id);

  // h('div', { class: 'x', text: 'hi', on: { click } }, child, child)
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'on') for (const [name, handler] of Object.entries(value)) el.addEventListener(name, handler);
      else if (key === 'data') Object.assign(el.dataset, value);
      else if (key === 'style') el.style.cssText = value;
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, value);
    }
    el.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
    return el;
  }

  // inline SVG icons, 24x24, stroke only (same style as the header buttons)
  const ICONS = {
    prev: '<path d="M6 5v14M19 5l-9 7 9 7V5z"/>',
    next: '<path d="M18 5v14M5 5l9 7-9 7V5z"/>',
    play: '<path d="M7 4l13 8-13 8V4z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    note: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
    speaker: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    muted: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9l5 6M22 9l-5 6" class="err"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    micOff: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/><path d="M3 3l18 18" class="err"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    sleep: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
    hibernate: '<path d="M12 3v9M7 6.5a7.5 7.5 0 1 0 10 0"/><path d="M9 15l3 3 3-3"/>',
    logout: '<path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9"/>',
    restart: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    power: '<path d="M12 3v9"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0"/>',
    chip: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
    wrench: '<path d="M14.5 6.5a4 4 0 0 0-5 5L4 17l3 3 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2-.5-.5-2z"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    minimize: '<path d="M6 18h12"/>',
    maximize: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
    restore: '<rect x="9" y="4" width="11" height="11" rx="1.5"/><path d="M4 9v10a1 1 0 0 0 1 1h10"/>',
    swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
    snapLeft: '<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M4.6 5.6h7.4v12.8H4.6z" fill="currentColor" stroke="none" opacity=".55"/>',
    snapRight: '<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M12 5.6h7.4v12.8H12z" fill="currentColor" stroke="none" opacity=".55"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    camera: '<path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8z"/><circle cx="12" cy="12.5" r="3.5"/>',
    keys: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    windows: '<rect x="3" y="7" width="13" height="11" rx="1.5"/><path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h10A1.5 1.5 0 0 1 21 5.5v8a1.5 1.5 0 0 1-1.5 1.5H16M3 10.5h13"/>',
    pc: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  };

  // Fluent UI System Icons (Microsoft, MIT license): filled shapes, drawn with fill (class .fluent) instead of the stroke of the icons above
  const FLUENT = {
    'fl-lock': '<path d="M12 1C14.7614 1 17 3.23858 17 6V8.00977C18.6781 8.13743 20 9.5392 20 11.25V18.75C20 20.5449 18.5449 22 16.75 22H7.25C5.45507 22 4 20.5449 4 18.75V11.25C4 9.5392 5.3219 8.13743 7 8.00977V6C7 3.23858 9.23858 1 12 1ZM7.25 9.5C6.2835 9.5 5.5 10.2835 5.5 11.25V18.75C5.5 19.7165 6.2835 20.5 7.25 20.5H16.75C17.7165 20.5 18.5 19.7165 18.5 18.75V11.25C18.5 10.2835 17.7165 9.5 16.75 9.5H7.25ZM12 13.75C12.6904 13.75 13.25 14.3096 13.25 15C13.25 15.6904 12.6904 16.25 12 16.25C11.3096 16.25 10.75 15.6904 10.75 15C10.75 14.3096 11.3096 13.75 12 13.75ZM12 2.5C10.067 2.5 8.5 4.067 8.5 6V8H15.5V6C15.5 4.067 13.933 2.5 12 2.5Z"/>',
    'fl-sleep': '<path d="M20.0258 17.0014C17.2639 21.7851 11.1471 23.4241 6.3634 20.6622C5.06068 19.9101 3.964 18.8926 3.12872 17.6797C2.84945 17.2741 3.0301 16.7141 3.49369 16.5482C7.26112 15.1997 9.27892 13.6372 10.4498 11.4021C11.6825 9.04908 12.001 6.47162 11.1387 2.93862C11.0195 2.45008 11.4053 1.98492 11.9075 2.01186C13.4645 2.09539 14.9856 2.54263 16.3649 3.33903C21.1486 6.10088 22.7876 12.2177 20.0258 17.0014ZM11.7785 12.0981C10.5272 14.4867 8.46706 16.1972 4.96104 17.597C5.5693 18.2929 6.29275 18.8894 7.1134 19.3632C11.1796 21.7108 16.3791 20.3176 18.7267 16.2514C21.0744 12.1852 19.6812 6.98571 15.6149 4.63807C14.7379 4.1317 13.7951 3.79168 12.8228 3.62253C13.4699 7.00652 13.0525 9.66622 11.7785 12.0981Z"/>',
    'fl-power': '<path d="M8.2042 4.82046C8.57962 4.64545 9.02584 4.80792 9.20085 5.18334C9.37586 5.55876 9.2134 6.00498 8.83797 6.18C6.21382 7.4033 4.5 10.0416 4.5 12.9914C4.5 17.1386 7.85759 20.5002 11.9989 20.5002C16.1403 20.5002 19.4979 17.1386 19.4979 12.9914C19.4979 10.0477 17.7912 7.41389 15.1753 6.18718C14.8002 6.01131 14.6388 5.56472 14.8147 5.1897C14.9905 4.81467 15.4371 4.65322 15.8121 4.82909C18.9502 6.30065 20.9979 9.46066 20.9979 12.9914C20.9979 17.9666 16.9691 22.0002 11.9989 22.0002C7.02876 22.0002 3 17.9666 3 12.9914C3 9.45334 5.05623 6.28796 8.2042 4.82046ZM11.9989 2.49609C12.3786 2.49609 12.6924 2.77825 12.7421 3.14432L12.7489 3.24609V10.746C12.7489 11.1602 12.4132 11.496 11.9989 11.496C11.6192 11.496 11.3055 11.2139 11.2558 10.8478L11.2489 10.746V3.24609C11.2489 2.83188 11.5847 2.49609 11.9989 2.49609Z"/>',
    'fl-restart': '<path d="M12 4.5C7.85786 4.5 4.5 7.85786 4.5 12C4.5 16.1421 7.85786 19.5 12 19.5C16.1421 19.5 19.5 16.1421 19.5 12C19.5 11.6236 19.4723 11.2538 19.4188 10.8923C19.3515 10.4382 19.6839 10 20.1429 10C20.5138 10 20.839 10.2562 20.8953 10.6228C20.9642 11.0718 21 11.5317 21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C14.3051 3 16.4077 3.86656 18 5.29168V4.25C18 3.83579 18.3358 3.5 18.75 3.5C19.1642 3.5 19.5 3.83579 19.5 4.25V7.25C19.5 7.66421 19.1642 8 18.75 8H15.75C15.3358 8 15 7.66421 15 7.25C15 6.83579 15.3358 6.5 15.75 6.5H17.0991C15.7609 5.25883 13.9691 4.5 12 4.5Z"/>',
    'fl-logout': '<path d="M8.50215 11.4995C9.05562 11.4995 9.5043 11.9482 9.5043 12.5017C9.5043 13.0552 9.05562 13.5038 8.50215 13.5038C7.94868 13.5038 7.5 13.0552 7.5 12.5017C7.5 11.9482 7.94868 11.4995 8.50215 11.4995ZM12 4.3537V10.4995L12.0005 11.0045L19.442 11.0035L17.7196 9.27977C17.4534 9.01346 17.4292 8.59679 17.6471 8.30321L17.7198 8.21911C17.9861 7.95289 18.4027 7.92875 18.6963 8.14666L18.7804 8.21929L21.777 11.2169C22.043 11.483 22.0674 11.8992 21.85 12.1928L21.7775 12.2769L18.7809 15.2803C18.4884 15.5736 18.0135 15.5741 17.7203 15.2816C17.4537 15.0156 17.429 14.599 17.6465 14.3051L17.7191 14.2209L19.432 12.5035L12.0005 12.5045L12 19.2495C12 19.7159 11.5788 20.0692 11.1196 19.9881L2.61955 18.4868C2.26121 18.4235 2 18.1121 2 17.7482V5.74953C2 5.38222 2.26601 5.06896 2.62847 5.00944L11.1285 3.61361C11.5851 3.53863 12 3.89097 12 4.3537ZM10.5 5.2369L3.5 6.38641V17.1191L10.5 18.3555V5.2369ZM13 18.5008L13.7652 18.501L13.867 18.4941C14.2335 18.4443 14.5158 18.1299 14.5152 17.7497L14.508 13.4995H13V18.5008ZM13.002 9.99953L13 8.72487V4.99952L13.7453 4.99953C14.1245 4.99953 14.4381 5.28105 14.4883 5.64664L14.4953 5.74829L14.502 9.99953H13.002Z"/>',
    'fl-wrench': '<path d="M11.0002 7.5C11.0002 4.46243 13.4627 2 16.5002 2C17.267 2 17.999 2.15735 18.6641 2.44223C18.8929 2.54023 19.0582 2.74534 19.1053 2.98974C19.1524 3.23414 19.0751 3.48599 18.8991 3.66198L16.3111 6.25L17.7505 7.68934L20.3384 5.10142C20.5144 4.92542 20.7663 4.8482 21.0107 4.8953C21.2551 4.94241 21.4602 5.10771 21.5582 5.33652C21.8429 6.00153 22.0002 6.73337 22.0002 7.5C22.0002 10.5376 19.5378 13 16.5002 13C16.058 13 15.6272 12.9477 15.214 12.8486L6.90165 21.1609C5.78033 22.2823 3.96231 22.2823 2.84099 21.1609C1.71967 20.0396 1.71967 18.2216 2.84099 17.1003L11.1523 8.78899C11.0528 8.37496 11.0002 7.94322 11.0002 7.5ZM16.5002 3.5C14.2911 3.5 12.5002 5.29086 12.5002 7.5C12.5002 7.94506 12.5726 8.37169 12.7057 8.76964C12.7959 9.0393 12.7258 9.33677 12.5248 9.53783L3.90165 18.1609C3.36612 18.6965 3.36612 19.5648 3.90165 20.1003C4.43718 20.6358 5.30546 20.6358 5.84099 20.1003L14.465 11.4763C14.6659 11.2754 14.9632 11.2053 15.2327 11.2952C15.6301 11.4279 16.056 11.5 16.5002 11.5C18.7094 11.5 20.5002 9.70914 20.5002 7.5C20.5002 7.35886 20.4929 7.21955 20.4787 7.08239L18.6344 8.92678C18.1462 9.41493 17.3547 9.41493 16.8666 8.92678L15.0737 7.13388C14.5855 6.64573 14.5855 5.85427 15.0737 5.36612L16.9183 3.52153C16.781 3.5073 16.6415 3.5 16.5002 3.5Z"/>',
    'fl-board': '<path d="M15.25 2C15.6297 2 15.9435 2.28215 15.9932 2.64823L16 2.75L16.0005 5.07512C17.4697 5.37357 18.6269 6.53092 18.925 8.00018L21.25 8C21.6642 8 22 8.33579 22 8.75C22 9.1297 21.7178 9.44349 21.3518 9.49315L21.25 9.5H19V11.25H21.25C21.6297 11.25 21.9435 11.5322 21.9932 11.8982L22 12C22 12.3797 21.7178 12.6935 21.3518 12.7432L21.25 12.75H19V14.5H21.25C21.6297 14.5 21.9435 14.7822 21.9932 15.1482L22 15.25C22 15.6297 21.7178 15.9435 21.3518 15.9932L21.25 16L18.9248 16.0008C18.6263 17.4696 17.4694 18.6265 16.0005 18.9249L16 21.25C16 21.6642 15.6642 22 15.25 22C14.8703 22 14.5565 21.7178 14.5068 21.3518L14.5 21.25V18.999H12.749L12.75 21.25C12.75 21.6297 12.4678 21.9435 12.1018 21.9932L12 22C11.6203 22 11.3065 21.7178 11.2568 21.3518L11.25 21.25L11.249 18.999H9.5V21.25C9.5 21.6297 9.21785 21.9435 8.85177 21.9932L8.75 22C8.3703 22 8.05651 21.7178 8.00685 21.3518L8 21.25L8.00046 18.9251C6.53088 18.627 5.37329 17.4695 5.07501 16L2.75 16C2.33579 16 2 15.6642 2 15.25C2 14.8703 2.28215 14.5565 2.64823 14.5068L2.75 14.5L5 14.499V12.749L2.75 12.75C2.3703 12.75 2.05651 12.4678 2.00685 12.1018L2 12C2 11.6203 2.28215 11.3065 2.64823 11.2568L2.75 11.25L5 11.249V9.499L2.75 9.5C2.3703 9.5 2.05651 9.21785 2.00685 8.85177L2 8.75C2 8.3703 2.28215 8.05651 2.64823 8.00685L2.75 8L5.07521 7.99904C5.37381 6.53 6.53121 5.37297 8.00046 5.07492L8 2.75C8 2.33579 8.33579 2 8.75 2C9.1297 2 9.44349 2.28215 9.49315 2.64823L9.5 2.75V4.999H11.249L11.25 2.75C11.25 2.3703 11.5322 2.05651 11.8982 2.00685L12 2C12.3797 2 12.6935 2.28215 12.7432 2.64823L12.75 2.75L12.749 4.999H14.5V2.75C14.5 2.40482 14.7332 2.11411 15.0506 2.02679L15.1482 2.00685L15.25 2ZM15.25 6.5H8.75C7.50736 6.5 6.5 7.50736 6.5 8.75V15.25C6.5 16.4926 7.50736 17.5 8.75 17.5H15.25C16.4926 17.5 17.5 16.4926 17.5 15.25V8.75C17.5 7.50736 16.4926 6.5 15.25 6.5ZM12.0049 9.00493C13.6618 9.00493 15.0049 10.3481 15.0049 12.0049C15.0049 13.6618 13.6618 15.0049 12.0049 15.0049C10.3481 15.0049 9.00493 13.6618 9.00493 12.0049C9.00493 10.3481 10.3481 9.00493 12.0049 9.00493ZM12.0049 10.5049C11.1765 10.5049 10.5049 11.1765 10.5049 12.0049C10.5049 12.8334 11.1765 13.5049 12.0049 13.5049C12.8334 13.5049 13.5049 12.8334 13.5049 12.0049C13.5049 11.1765 12.8334 10.5049 12.0049 10.5049Z"/>',
    'fl-hibernate': '<path d="M18.2498 20.5009C18.664 20.5008 19 20.8365 19 21.2507C19 21.6649 18.6644 22.0008 18.2502 22.0009L5.25022 22.0047C4.836 22.0048 4.5 21.6691 4.5 21.2549C4.5 20.8407 4.83557 20.5048 5.24978 20.5047L18.2498 20.5009ZM11.6482 2.01271L11.75 2.00586C12.1297 2.00586 12.4435 2.28801 12.4932 2.65409L12.5 2.75586L12.499 16.4409L16.2208 12.7205C16.4871 12.4543 16.9038 12.4301 17.1974 12.648L17.2815 12.7206C17.5477 12.9869 17.5719 13.4036 17.354 13.6972L17.2814 13.7813L12.2837 18.7779C12.0176 19.044 11.6012 19.0683 11.3076 18.8507L11.2235 18.7782L6.22003 13.7816C5.92694 13.4889 5.92661 13.014 6.21931 12.7209C6.48539 12.4545 6.90204 12.43 7.1958 12.6477L7.27997 12.7202L10.999 16.4339L11 2.75586C11 2.37616 11.2822 2.06237 11.6482 2.01271L11.75 2.00586L11.6482 2.01271Z"/>',
  };

  function icon(name, size) {
    const svg = h('span', { class: FLUENT[name] ? 'ico fluent' : 'ico', 'aria-hidden': 'true' });
    svg.innerHTML = `<svg viewBox="0 0 24 24">${FLUENT[name] || ICONS[name] || ''}</svg>`;
    if (size) svg.style.setProperty('--size', `${size}px`);
    return svg;
  }

  // --- feedback -------------------------------------------------------------------------------

  const toastEl = $('toast');
  let toastTimer;
  function toast(message, isError = false, ms = 2000) {
    toastEl.textContent = message;
    toastEl.classList.toggle('error', isError);
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  // Haptics: the Android shell exposes a native vibrator (the WebView's own navigator.vibrate is unreliable);
  // a normal browser falls back to the Vibration API where it exists.
  function vibrate(ms = 10) {
    try {
      if (window.Android && typeof window.Android.vibrate === 'function') window.Android.vibrate(ms);
      else if (navigator.vibrate) navigator.vibrate(ms);
    } catch {
      // haptics are optional
    }
  }

  // --- API ------------------------------------------------------------------------------------

  async function api(path, { method = 'GET', json, signal } = {}) {
    const options = { method, credentials: 'same-origin', signal };
    if (json !== undefined) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(json);
    }
    const response = await fetch(path, options);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw Object.assign(new Error(body.error || response.statusText), { status: response.status });
    }
    return response.json();
  }

  // --- formatting -----------------------------------------------------------------------------

  const pad = (n) => String(n).padStart(2, '0');

  const fmt = {
    clock(seconds) {
      if (!Number.isFinite(seconds)) return '–:––';
      const s = Math.max(0, Math.floor(seconds));
      const hours = Math.floor(s / 3600);
      const minutes = Math.floor((s % 3600) / 60);
      return hours ? `${hours}:${pad(minutes)}:${pad(s % 60)}` : `${minutes}:${pad(s % 60)}`;
    },
    duration(seconds) {
      const s = Math.max(0, Math.floor(seconds));
      const days = Math.floor(s / 86400);
      const hours = Math.floor((s % 86400) / 3600);
      const minutes = Math.floor((s % 3600) / 60);
      if (days) return `${days}d ${hours}h ${minutes}min`;
      if (hours) return `${hours}h ${pad(minutes)}min`;
      return `${minutes}min`;
    },
    bytes(value) {
      if (!Number.isFinite(value)) return '–';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let n = value;
      let i = 0;
      while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
      return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
    },
    rate: (value) => (Number.isFinite(value) ? `${Deck.fmt.bytes(value)}/s` : '–'),
    gb: (mb) => (Number.isFinite(mb) ? `${(mb / 1024).toFixed(1)} GB` : '–'),
    pct: (value) => (Number.isFinite(value) ? `${Math.round(value)}%` : '–'),
    date: (iso) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–'),
    dateTime: (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–'),
  };

  // --- slider with a throttled "latest value wins" sender -------------------------------------

  /**
   * Range input that reports changes while dragging, but never has more than one request in flight:
   * newer positions replace older ones. `set()` updates the display from outside (e.g. polling) without
   * fighting the user's finger.
   */
  function slider({ onChange, className = '' }) {
    const input = h('input', { type: 'range', min: 0, max: 100, step: 1, value: 0, class: `range ${className}` });
    let dragging = false;
    let timer;
    let pending = null;
    let sending = false;

    const paint = (value) => input.style.setProperty('--fill', `${value}%`);

    async function flush() {
      if (sending || pending === null) return;
      sending = true;
      const value = pending;
      pending = null;
      try {
        await onChange(value);
      } catch (err) {
        toast(`Erro: ${err.message}`, true);
      }
      sending = false;
      flush();
    }

    input.addEventListener('pointerdown', () => { dragging = true; clearTimeout(timer); });
    const end = () => { clearTimeout(timer); timer = setTimeout(() => { dragging = false; }, 400); };
    input.addEventListener('pointerup', end);
    input.addEventListener('pointercancel', end);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      paint(value);
      input.dispatchEvent(new CustomEvent('level', { detail: value }));
      pending = value;
      flush();
    });

    return {
      el: input,
      isDragging: () => dragging,
      set(value) {
        if (dragging || !Number.isFinite(value)) return;
        input.value = value;
        paint(value);
      },
      disable(disabled) { input.disabled = disabled; },
    };
  }

  // --- hold to confirm ------------------------------------------------------------------------

  /** A button that only fires after being held (1.2 s by default), with a fill that shows the progress. */
  function holdButton(label, onDone, { ms = 1200, className = '' } = {}) {
    const button = h('button', { type: 'button', class: `hold ${className}`.trim(), style: `--hold-ms:${ms}ms` }, h('span', { text: label }));
    let timer = null;

    const start = (event) => {
      event.preventDefault();
      if (timer) return;
      button.classList.add('holding');
      vibrate(15);
      timer = setTimeout(() => {
        timer = null;
        button.classList.remove('holding');
        // the sheet was taken away while held (Back, a rebuild): pointerleave never comes for a removed button, and it must not act
        if (!button.isConnected) return;
        vibrate(80);
        onDone();
      }, ms);
    };
    const stop = () => {
      clearTimeout(timer);
      timer = null;
      button.classList.remove('holding');
    };
    button.addEventListener('pointerdown', start);
    for (const name of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(name, stop);
    button.addEventListener('contextmenu', (event) => event.preventDefault());
    return button;
  }
  // --- page registry --------------------------------------------------------------------------

  const pages = [];
  /** def: { id, title, el, show?(), hide?() } - show/hide fire when the page becomes/stops being the visible one. */
  function addPage(def) { pages.push(def); }

  /**
   * A segmented selector ("Lista | Mapa"): one button per item, 48 px targets, exactly one selected. `set(id)` selects without
   * calling onChange (the caller already knows); a tap calls onChange(id).
   */
  function segmented(items, onChange, label) {
    const buttons = new Map();
    const el = h('div', { class: 'seg', role: 'tablist', 'aria-label': label || '' });
    const set = (id) => buttons.forEach((button, key) => button.setAttribute('aria-selected', String(key === id)));
    for (const item of items) {
      const button = h('button', { type: 'button', class: 'seg-btn', role: 'tab', data: { seg: item.id }, text: item.label, on: { click: () => { set(item.id); onChange(item.id); } } });
      buttons.set(item.id, button);
      el.append(button);
    }
    return { el, set };
  }

  // entries the settings (gear) menu shows besides its own: { label, onClick }
  const menuItems = [];

  const isPortrait = () => window.matchMedia('(orientation: portrait)').matches;

  /**
   * Drag-down-to-close for a portrait bottom sheet. Only `handle` (the grabber / title bar) starts it, never the content, so
   * scrolling inside the sheet cannot close it. The handle has touch-action: none (style.css), so the gesture is ours and never
   * a page swipe. Follows the finger, then closes past a threshold (or flicks back). `close` runs after the short slide-out.
   */
  function dragToClose(handle, panel, close) {
    const THRESHOLD = 90; // px of drag that counts as "close"
    let startY = null;
    let dy = 0;
    let moved = false;
    handle.addEventListener('pointerdown', (event) => {
      if (!isPortrait()) return;
      startY = event.clientY;
      dy = 0;
      moved = false;
    });
    handle.addEventListener('pointermove', (event) => {
      if (startY === null) return;
      dy = Math.max(0, event.clientY - startY);
      if (!moved && dy < 6) return;
      if (!moved) {
        moved = true;
        panel.style.transition = 'none';
        try { handle.setPointerCapture(event.pointerId); } catch { /* the pointer may be gone already */ }
      }
      panel.style.transform = `translateY(${dy}px)`;
    });
    const end = () => {
      if (startY === null) return;
      startY = null;
      if (!moved) return;
      panel.style.transition = 'transform 0.16s ease';
      if (dy >= THRESHOLD) {
        panel.style.transform = 'translateY(100%)';
        setTimeout(() => { close(); panel.style.transition = ''; panel.style.transform = ''; }, 170);
      } else {
        panel.style.transform = '';
        setTimeout(() => { panel.style.transition = ''; }, 170);
      }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // A panel over the deck (the camera, the button editor): one tap in the menu or on a button opens it, one tap on its close
  // button returns. Landscape: a full panel. Portrait: a bottom sheet (~92 % high, grabber on top) that also closes by dragging
  // its bar down or tapping the dimmed strip above it. onOpen/onClose are where a panel starts and stops its polling.
  // the overlays that are open, oldest first: Deck.back() closes the newest
  const openOverlays = [];

  function overlay({ title, el, onOpen, onClose }) {
    const closeButton = h('button', { type: 'button', class: 'overlay-close', 'aria-label': 'Fechar' }, icon('close', 22), h('span', { text: 'Fechar' }));
    const bar = h('div', { class: 'overlay-bar' }, h('i', { class: 'grabber', 'aria-hidden': 'true' }), h('b', { text: title }), closeButton);
    const root = h('div', { class: 'overlay', hidden: true, role: 'dialog', 'aria-label': title },
      bar,
      h('div', { class: 'overlay-body' }, el));
    // portrait only (style.css): the dimmed strip above the sheet; a tap there closes it instead of reaching the deck below
    const scrim = h('div', { class: 'overlay-scrim', hidden: true, on: { click: () => control.close() } });
    document.body.append(scrim, root);

    const control = {
      open() {
        if (!root.hidden) return;
        root.hidden = false;
        scrim.hidden = false;
        openOverlays.push(control);
        if (onOpen) onOpen();
      },
      close() {
        if (root.hidden) return;
        root.hidden = true;
        scrim.hidden = true;
        const at = openOverlays.indexOf(control);
        if (at !== -1) openOverlays.splice(at, 1);
        if (onClose) onClose();
      },
      get isOpen() { return !root.hidden; },
    };
    closeButton.addEventListener('click', control.close);
    dragToClose(bar, root, control.close);
    return control;
  }

  /**
   * The Android Back button (MainActivity calls this) and any "go back" gesture. Undoes one thing per call, newest first:
   * the sheet in #modal-root, the open menu, the newest overlay, edit mode; with nothing open, any page but Apps goes
   * to Apps. Returns true if it did something, false if already on Apps with nothing open (the shell then ignores the press:
   * a stray Back must not drop the deck).
   */
  function back() {
    const sheet = $('modal-root').lastElementChild;
    if (sheet) {
      sheet.remove();
      return true;
    }
    for (const id of ['menu-pop']) {
      const panel = $(id);
      if (panel && !panel.hidden) {
        panel.hidden = true;
        return true;
      }
    }
    const top = openOverlays[openOverlays.length - 1];
    if (top) {
      top.close();
      return true;
    }
    if (Deck.edit && Deck.edit.active) {
      Deck.edit.exit();
      return true;
    }
    if (Deck.pager && Deck.pager.currentSection() !== 'apps') return Deck.goTo('apps-0');
    return false;
  }

  return { $, h, icon, api, toast, vibrate, fmt, slider, holdButton, pages, addPage, segmented, menuItems, overlay, dragToClose, back, state: { online: false } };
})();
