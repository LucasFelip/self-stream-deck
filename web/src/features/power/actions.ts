import type { components, paths } from '../../api/schema';

export type PowerAction = NonNullable<paths['/api/power']['post']['requestBody']>['content']['application/json']['action'];
export type PowerInfo = components['schemas']['Power'];

/** What each action does, in the words shown in the confirmation sheet. */
export interface ActionDef {
  id: PowerAction;
  icon: string;
  label: string;
  /** colours the icon */
  tone: 'soft' | 'warn' | 'danger';
  /** the tooltip / accessible description of the key (the sheet spells out the consequences) */
  short: string;
  /** runs at once, with no confirmation sheet */
  immediate?: boolean;
  title?: string;
  effects?: string;
  reconnect?: string;
  /** a field of the power info that must be true for the key to show (hibernation is off on some PCs) */
  needs?: 'hibernate';
  /** warn about open apps (they may hold unsaved work) */
  apps?: boolean;
  /** can be scheduled */
  delay?: boolean;
}

export const ACTIONS: ActionDef[] = [
  { id: 'lock', icon: 'fl-lock', label: 'Bloquear', tone: 'soft', short: 'Vai para a tela de login. Os apps continuam abertos.', immediate: true },
  {
    id: 'sleep', icon: 'fl-sleep', label: 'Suspender', tone: 'soft', short: 'Baixo consumo, volta em segundos.',
    title: 'Suspender o PC?', effects: 'O PC entra em suspensão com tudo aberto na memória.',
    reconnect: 'O painel perde a conexão até o PC acordar (mouse, teclado ou botão de ligar).',
  },
  {
    id: 'hibernate', icon: 'fl-hibernate', label: 'Hibernar', tone: 'soft', short: 'Salva a sessão no disco e desliga.',
    title: 'Hibernar o PC?', effects: 'A sessão é salva no disco e o PC desliga, sem consumo. Ao ligar, tudo volta como estava.',
    reconnect: 'O painel só volta quando o PC for ligado de novo.', needs: 'hibernate',
  },
  {
    id: 'logoff', icon: 'fl-logout', label: 'Sair da conta', tone: 'warn', short: 'Encerra a sessão e fecha os apps do usuário.',
    title: 'Sair da conta?', effects: 'A sessão do usuário é encerrada e todos os apps abertos são fechados.',
    reconnect: 'O painel para de funcionar até alguém entrar de novo (o servidor roda dentro da sessão).', apps: true,
  },
  {
    id: 'restart', icon: 'fl-restart', label: 'Reiniciar', tone: 'danger', short: 'Fecha tudo e liga de novo.',
    title: 'Reiniciar o PC?', effects: 'Todos os apps são fechados e o Windows reinicia.',
    reconnect: 'O painel reconecta sozinho quando o Windows e o servidor voltarem.', apps: true, delay: true,
  },
  {
    id: 'shutdown', icon: 'fl-power', label: 'Desligar', tone: 'danger', short: 'Fecha tudo e desliga o PC.',
    title: 'Desligar o PC?', effects: 'Todos os apps são fechados e o PC desliga por completo.',
    reconnect: 'Para ligar de novo você precisa apertar o botão do PC: este painel não consegue acordá-lo.', apps: true, delay: true,
  },
  {
    id: 'firmware', icon: 'fl-board', label: 'Reiniciar p/ BIOS', tone: 'danger', short: 'Reinicia direto na configuração da placa-mãe (UEFI).',
    title: 'Reiniciar para a BIOS?', effects: 'O PC reinicia e abre a configuração UEFI em vez do Windows. É preciso um teclado e monitor no PC para usá-la.',
    reconnect: 'O painel só volta depois que você sair da BIOS e o Windows iniciar.', apps: true, delay: true,
  },
  {
    id: 'advanced', icon: 'fl-wrench', label: 'Modo avançado', tone: 'danger', short: 'Menu de recuperação: modo seguro, reparo, restauração.',
    title: 'Reiniciar no menu avançado?', effects: 'O PC reinicia no menu de opções avançadas do Windows (modo seguro, reparo de inicialização, restauração).',
    reconnect: 'O painel só volta depois que você escolher uma opção e o Windows iniciar. É preciso teclado e monitor no PC.', apps: true, delay: true,
  },
];

/** [label, seconds] */
export const DELAYS: ReadonlyArray<readonly [string, number]> = [['Agora', 0], ['10 s', 10], ['1 min', 60], ['5 min', 300], ['15 min', 900], ['30 min', 1800], ['1 h', 3600], ['2 h', 7200]];

export const SCHEDULE_LABELS: Record<string, string> = { shutdown: 'Desligamento', restart: 'Reinício', firmware: 'Reinício para a BIOS', advanced: 'Reinício avançado' };

/** The delay a sheet starts with: schedulable actions default to 10 s, the rest run now. */
export const defaultDelay = (action: ActionDef): number => (action.delay ? 10 : 0);

/** Windows rule: "shutdown /t N" with N > 0 implies /f, so a delayed action always forces apps to close. */
export const isForced = (force: boolean, delaySec: number): boolean => force || delaySec > 0;

/** The sentence under the options: what is about to happen. */
export function summarize(action: ActionDef, delaySec: number, forced: boolean): string {
  const label = DELAYS.find(([, seconds]) => seconds === delaySec)?.[0] ?? `${delaySec} s`;
  const when = delaySec === 0 ? 'imediatamente' : `em ${label} (dá para cancelar até lá)`;
  return `${action.label} ${when}${forced ? ', fechando os apps à força' : ''}.`;
}
