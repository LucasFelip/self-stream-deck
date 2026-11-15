# Plano visual

Objetivo: dar ao painel mais cor, mais leitura de longe e mais vida, sem perder o que ele já tem de bom (preto puro para a tela AMOLED, a hierarquia simples, o mapa de janelas, os ícones de linha da Energia). O ponto de partida é a comparação com o phonebox: ele usa cor com significado, números grandes, gráficos com preenchimento e uma tela de descanso útil.

Convenções: um branch e um PR por lote, empilhados; cada lote termina com `npm test` (tipos, lint, unidade) e os testes de navegador das páginas que mexeu; no fim, `node tools/check.js --full`. Nada de dependência nova no painel.

## Lotes

| Lote | Entrega | Onde | Esforço |
|---|---|---|---|
| 1 | **Cor por métrica** (CPU, memória, GPU, disco, rede) nos títulos, barras, gráficos e núcleos; **gráficos que ocupam o card**; **números maiores** em PC e Som | `styles/pages.css`, `features/pc` | P |
| 2 | **Tons nos botões** derivados do ícone do app (e das macros), e **vermelho suave nas ações destrutivas** da Energia | `features/deck`, `features/power`, `styles` | M |
| 3 | **Grade de Apps sem a faixa vazia**: some a fileira de espaços tracejados que sobra e a grade se ajusta ao que existe | `features/deck/layout.ts`, `styles` | M |
| 4 | **Player de Som maior**: capa em destaque, título grande, controles amplos | `features/sound`, `styles` | M |
| 5 | **Tela de descanso**: relógio grande, o que está tocando e os valores dos webhooks, em vez de só escurecer | `features/idle` | M |
| 6 | **Aparência escolhível**: cor de destaque e tamanho do texto, guardados no aparelho | `features/appearance` (novo), `styles` | M |
| 7 | **README com imagem de capa e GIF do tour**, gerados da demonstração | `tools/screenshots`, `docs/img` | P |

## Regras do desenho

1. **Cor tem significado.** Cada métrica tem uma cor fixa e a usa em todo lugar onde aparece (título, barra, gráfico). Os alertas continuam amarelo e vermelho e vencem a cor da métrica.
2. **Contraste.** Todo texto e todo traço sobre o fundo escuro precisa de contraste de pelo menos 4,5:1 (texto) e 3:1 (gráficos e barras). As cores das métricas são checadas por um teste.
3. **Nada novo que gaste bateria.** Sem gradientes animados nem brilhos que mexam; o fundo continua preto puro.
4. **Os testes de layout continuam valendo.** Os cenários de seis tamanhos de tela de `web/e2e/layout.e2e.cjs` e `pc.e2e.cjs` não podem ter nada cortado nem sobreposto; quando um número cresce, o teste diz.
5. **Respeita o aparelho.** O tamanho do texto escolhido só aumenta ou reduz dentro de limites que os testes de layout aceitam.

## Fora do plano

Fundos com gradiente, animações de entrada e emojis coloridos: custam bateria e gostos. Ficam como ideia, não como tarefa.
