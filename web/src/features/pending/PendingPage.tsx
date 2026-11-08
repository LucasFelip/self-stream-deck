import { Page } from '../../shell/Page';
import { SECTIONS, type SectionId } from '../../shell/sections';

/** A section that has not been moved to the new interface yet (docs/plano-reestruturacao.md, Phase 2.2): points to the old one. */
export function PendingPage({ section }: { section: SectionId }) {
  const label = SECTIONS.find((candidate) => candidate.id === section)?.label ?? section;
  return (
    <Page section={section} className="pending-page">
      <div className="pending-note">
        <b>{label}</b>
        <p>Esta página ainda não foi migrada para a interface nova.</p>
        <a className="pending-link" href="/">Abrir a interface antiga</a>
      </div>
    </Page>
  );
}
