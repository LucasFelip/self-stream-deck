import type { PagerApi } from './PagerContext';
import { SECTIONS } from './sections';
import { Icon } from '../ui/Icon';

interface NavProps {
  pager: PagerApi;
  menuOpen: boolean;
  onMenu: () => void;
}

/**
 * The navigation: a rail on the left in landscape, a bar at the bottom in portrait (chosen by orientation in style.css).
 * One tab per section, icon over a short label, and the gear that opens the menu.
 */
export function Nav({ pager, menuOpen, onMenu }: NavProps) {
  return (
    <nav className="nav" aria-label="Seções">
      <div id="tabs" className="tabs" role="tablist" aria-label="Seções">
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            className="tab"
            role="tab"
            aria-selected={pager.active === section.id}
            data-section={section.id}
            onClick={() => pager.goTo(section.id)}
          >
            <Icon name={section.icon} />
            <span className="tab-label">{section.label}</span>
          </button>
        ))}
      </div>
      <div className="nav-end">
        <button id="menu" className="icon-btn quiet" type="button" aria-label="Configurações" aria-haspopup="true" aria-expanded={menuOpen} onClick={onMenu}>
          <Icon name="settings" size={20} />
        </button>
      </div>
    </nav>
  );
}
