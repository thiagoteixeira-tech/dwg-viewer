# DWG Viewer

Visualizador web de arquivos **DWG (AutoCAD)**. Funciona inteiramente no navegador: o arquivo é lido localmente por uma versão WebAssembly da [LibreDWG](https://www.gnu.org/software/libredwg/) e nada é enviado a servidores.

## Funcionalidades

- **Abrir um arquivo `.dwg`**: pelo botão ou arrastando o arquivo para a página.
- **Zoom e navegação**: roda do mouse (zoom no cursor), arrastar para mover, pinça no celular, botões `+`/`−`/enquadrar e atalhos `+`, `-`, `F`.
- **Seleção**: clique em um objeto (parede, porta, bloco, texto…) para destacá-lo; duplo clique aproxima o zoom dele.
- **Tabela de dimensões** com cada objeto e seu tipo, camada, **largura (X)**, **altura (Y)**, comprimento total e área. É possível ordenar, filtrar por tipo ou camada, buscar e mostrar só o que está na área visível.
- **Painel de detalhes** do objeto selecionado, que mostra:
  - largura e altura (caixa envolvente, também desenhada como cota sobre o desenho);
  - **comprimento e espessura orientados** (retângulo mínimo girado), úteis para paredes inclinadas;
  - propriedades específicas: raio/diâmetro de círculos, ângulo de linhas, nome/escala/rotação de blocos, valor de cotas, texto etc.
- **Camadas**: liga e desliga a visibilidade de cada uma.
- **Exportar CSV** da tabela, pronto para abrir no Excel (separador `;` e vírgula decimal).
- Unidade lida do cabeçalho do DWG (`$INSUNITS`).

Entidades suportadas: LINE, LWPOLYLINE, POLYLINE 2D/3D, CIRCLE, ARC, ELLIPSE, SPLINE (NURBS), HATCH, SOLID, 3DFACE, POINT, TEXT, MTEXT, ATTRIB, INSERT (blocos aninhados e matrizes), DIMENSION, LEADER e MLINE.

## Bibliotecas reutilizadas

| Biblioteca | Uso |
|---|---|
| [`@mlightcad/libredwg-web`](https://github.com/mlightcad/libredwg-web), que é a LibreDWG compilada em WebAssembly | Leitura e decodificação do DWG (versões R14 a 2018+) |
| Canvas 2D / Path2D (nativo do navegador) | Renderização com zoom e pan |

A biblioteca é carregada do CDN jsDelivr (veja [js/config.js](js/config.js)), então o projeto **não tem etapa de build nem dependências npm**.

## Executar localmente

Você precisa de **Python 3** (ou Node.js).

```bash
# Windows: clique duas vezes em iniciar.bat, ou:
python serve.py          # abre http://localhost:8000 no navegador

# alternativa com Node.js
npm start                # usa "npx serve" na porta 8000
```

> Não abra o `index.html` direto pelo sistema de arquivos (`file://`). Web Workers e módulos ES exigem um servidor HTTP.

Para testar com um arquivo hospedado, use `?url=`: `http://localhost:8000/?url=/caminho/arquivo.dwg`.

## Deploy no Vercel

O projeto é um site estático, e o [vercel.json](vercel.json) já está configurado.

**Opção 1: pelo GitHub**
1. Envie este repositório para o GitHub.
2. Em <https://vercel.com/new>, importe o repositório.
3. Framework Preset: **Other**. Deixe Build Command e Output Directory vazios.
4. Clique em **Deploy**.

**Opção 2: pela CLI**
```bash
npm i -g vercel
vercel          # preview
vercel --prod   # produção
```

## Estrutura

```
index.html        interface
css/style.css     estilos (tema escuro, responsivo)
js/app.js         controlador da interface: tabela, filtros, detalhes, CSV
js/viewer.js      renderizador em canvas: zoom, pan, seleção, cotas
js/geometry.js    converte entidades DWG em geometria e calcula dimensões
js/worker.js      Web Worker que lê o DWG com LibreDWG (sem travar a tela)
js/config.js      URL/versão da biblioteca LibreDWG
js/colors.js      paleta de cores ACI do AutoCAD
serve.py          servidor local (Python)
vercel.json       configuração do Vercel
```

## Limitações

- Na primeira abertura o navegador baixa cerca de 10 MB (o módulo WebAssembly). Depois disso ele fica em cache.
- Sólidos 3D (ACIS), tabelas, multileaders, imagens e wipeouts não são desenhados.
- Padrões de hachura aparecem como preenchimento translúcido, não como o padrão de linhas.
- A largura dos textos na tabela é estimada, porque as fontes SHX não estão disponíveis.

## Licença

GPL-3.0, a mesma da LibreDWG / libredwg-web.
