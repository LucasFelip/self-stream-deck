/** The destinations of the rail/bar, in order (SECTIONS in the old pager.js). The id is also the page's `data-section`. */
export const SECTIONS = [
  { id: 'apps', label: 'Apps', icon: 'grid' },
  { id: 'shortcuts', label: 'Atalhos', icon: 'keys' },
  { id: 'windows', label: 'Janelas', icon: 'windows' },
  { id: 'sound', label: 'Som', icon: 'speaker' },
  { id: 'pc', label: 'PC', icon: 'pc' },
  { id: 'power', label: 'Energia', icon: 'power' },
] as const;

export type SectionId = (typeof SECTIONS)[number]['id'];
