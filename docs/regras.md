# Regras de automação

Uma regra diz: "quando isto acontecer no PC, e durar um tempo, faça aquilo **no painel**". Por exemplo, abrir a página Som quando uma música começa, mostrar um aviso quando a CPU passa de 90 % por 15 segundos, ou deixar um valor no painel durante uma reunião. A decisão está em [ADR 0011](adr/0011-regras-de-automacao.md).

Uma regra só mexe no **painel**: troca a página, mostra um aviso, guarda um valor. Nenhuma aperta tecla, abre programa ou mexe na energia do PC.

## Onde ficam

Na chave `rules` do `config.json` (veja [configuração](configuracao.md)), uma lista. O agente relê a lista quando ela muda, sem reiniciar. **Se uma regra da lista estiver errada, a lista inteira é recusada** (o log e o card *Regras* do painel dizem qual regra e por quê), para um erro de digitação não virar metade das regras funcionando.

```json
"rules": [
  {
    "id": "musica-tocando",
    "when": { "type": "media-playing" },
    "whileActive": true,
    "do": { "type": "goto", "page": "sound" }
  },
  {
    "id": "cpu-alta",
    "when": { "type": "cpu-above", "percent": 90 },
    "for": 15,
    "cooldown": 10,
    "do": { "type": "notify", "title": "PC", "text": "CPU alta" }
  }
]
```

## Campos de uma regra

| Campo | Significado |
|---|---|
| `id` | 1 a 40 caracteres: `a-z`, `0-9` e `-`; único na lista. |
| `enabled` | `false` desliga a regra sem apagá-la. |
| `when` | A condição (abaixo). |
| `for` | Segundos que a condição precisa **durar** antes de a regra disparar (até 3600). Padrão: 0, e 15 para `cpu-above` (um pico é normal). |
| `cooldown` | Minutos até a regra poder disparar de novo (até 1440). Padrão: 0. |
| `whileActive` | `true`: quando a condição acaba, o efeito é desfeito (o painel volta à página em que estava, o valor é apagado). Um aviso não se desfaz. |
| `do` | A ação (abaixo). |

A regra só termina depois de **4 segundos** sem a condição, para uma condição que pisca não ficar ligando e desligando. Uma janela de horário (`time-window`) termina na hora.

## Condições (`when`)

| `type` | Campos | Vale quando |
|---|---|---|
| `cpu-above` | `percent` (1 a 100) | o uso da CPU está igual ou acima disso. |
| `media-playing` | | algum player está tocando. |
| `window-title-contains` | `text` | o título de alguma janela visível contém o texto (sem diferenciar maiúsculas). |
| `notification-from` | `app` | chegou uma notificação do app (só as que o Windows deixa o agente ler; veja `notifications` na configuração). Vale no instante em que chega. |
| `time-window` | `from`, `to` (`"22:00"`) | a hora local está entre os dois horários; `from` maior que `to` atravessa a meia-noite (`"22:00"` a `"06:00"`). |

## Ações (`do`)

| `type` | Campos | Efeito |
|---|---|---|
| `goto` | `page` | O painel abre a página (`apps`, `shortcuts`, `windows`, `sound`, `pc`, `power`). Com `whileActive`, volta à página em que estava quando a regra termina. |
| `notify` | `title?`, `text` | Mostra um aviso no painel. |
| `push` | `key`, `value`, `ttl?` | Guarda um valor (o mesmo dos [webhooks](webhooks.md)), que aparece em PC › Painel. Com `whileActive`, é apagado quando a regra termina. |

## Pausar

No painel, em **PC › Painel › Regras**: *Pausar 30 min* e *Retomar regras*. A API é `POST /api/rules/pause` com `{ "minutes": 0 a 1440 }` (0 retoma), e só o token do celular a abre, não a chave dos webhooks. Ao pausar, as regras que estavam valendo terminam (e desfazem o efeito, se `whileActive`) e podem disparar de novo depois da pausa.

`GET /api/rules` mostra as regras cadastradas, as que valem agora, até quando está pausado e o erro da lista, se houver.

## Custo

Sem nenhuma regra ligada, o agente não lê nada do PC por causa delas. Com regras, ele lê **só o que as regras perguntam** (a CPU a cada 2 s no máximo, o que está tocando, as janelas, as notificações), uma vez por segundo.

## Ainda não

Um editor de regras no celular (hoje as regras se editam no `config.json`) e ações sobre o PC, que ficam fora até existir uma forma de confirmar.
