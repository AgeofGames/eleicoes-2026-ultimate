# Eleições 2026 Ultimate

Site independente para acompanhar a eleição presidencial de 2026, com mapa por estado, comparação dos candidatos, resultados oficiais do TSE, consulta ao primeiro turno e tema escuro.

Endereço público: [Eleições 2026 Ultimate](https://eleicoes-2026-ultimate-production.up.railway.app). Repositório: [AgeofGames/eleicoes-2026-ultimate](https://github.com/AgeofGames/eleicoes-2026-ultimate).

## Rodar e verificar

Instale Node.js 24 ou superior. O projeto usa apenas módulos nativos: não é necessário instalar pacotes.

```sh
npm start
npm test
```

Abra `http://localhost:3000`. A raiz mostra o segundo turno, de 25 de outubro de 2026. `/primeiro-turno` mostra o primeiro turno, de 4 de outubro de 2026. O servidor responde na interface `0.0.0.0` e respeita a variável `PORT`.

## Dados oficiais

O navegador consulta `/api/resultados?turno=2&uf=br`. O servidor consulta exclusivamente o domínio `resultados.tse.jus.br`, nos arquivos da eleição presidencial 6257 (primeiro turno) ou 6258 (segundo turno), do ciclo `ele2026`. São aceitos `br` e as 27 siglas de UF, em letras minúsculas.

Antes de repassar o JSON, o servidor verifica fase oficial, eleição, turno, abrangência, autorização de divulgação, ano de geração e presença do cargo de presidente. Arquivos de treinamento, de outro turno ou de outra eleição são rejeitados. O cache de 25 segundos é separado por turno e UF; consultas simultâneas compartilham a mesma requisição. O horário da consulta original é preservado no cabeçalho `X-Data-Checked-At`.

Uma falha da fonte oficial não é substituída por dados antigos no servidor. O navegador pode conservar a última consulta, identificando-a como desatualizada. O servidor aguarda até 10 segundos pela fonte; respostas 403/429 suspendem novas consultas à fonte por 10 minutos em todas as UFs e turnos, e respostas 404 suspendem a consulta daquele arquivo por 3 minutos. Esses códigos HTTP e o intervalo `Retry-After` são preservados para o navegador. A ausência de arquivo ou autorização não representa zero votos nem resultado definido.

## Publicar no GitHub e Railway

1. Envie este diretório ao repositório [AgeofGames/eleicoes-2026-ultimate](https://github.com/AgeofGames/eleicoes-2026-ultimate). Não envie credenciais nem arquivos `.env`.
2. No Railway, crie um serviço conectado a esse repositório. O `Dockerfile` na raiz é detectado automaticamente; confirme essa seleção na configuração de build. O `railway.json` fica como referência legada: serviços novos não devem depender da aplicação automática desse arquivo.
3. Nas configurações de deploy do serviço, defina manualmente o **Healthcheck Path** como `/health`.
4. Em **Settings → Networking**, gere um domínio público. Recomenda-se definir explicitamente `SITE_URL` nas variáveis do serviço como a origem HTTPS completa. Neste site, o valor é `https://eleicoes-2026-ultimate-production.up.railway.app`. Use apenas a origem, sem caminho nem parâmetros. Se `SITE_URL` não estiver definida, o servidor tenta usar `RAILWAY_PUBLIC_DOMAIN`.
5. Se configurar domínio próprio, atualize `SITE_URL` para ele, por exemplo `https://eleicoes2026.seudominio.com.br`. Faça um novo deploy após alterar a variável ou as configurações do serviço.
6. Aguarde a confirmação do deploy e verifique a página inicial, `/primeiro-turno`, `/health`, `/robots.txt` e `/sitemap.xml` no domínio publicado.

O contêiner usa um usuário sem privilégios e não exige volume, banco de dados ou chave de API. O cache é temporário e reinicia a cada deploy. No ambiente local, o site envia `noindex` e bloqueia rastreamento. Com uma origem pública HTTPS configurada, as duas páginas permitem indexação.

## Google e compartilhamento

As páginas possuem títulos e descrições por turno, endereço canônico, metadados de compartilhamento e dados estruturados. O servidor gera `robots.txt` e `sitemap.xml` com o domínio efetivo. Páginas inexistentes devolvem HTTP 404 e a API é marcada como `noindex`.

Depois da publicação, adicione o domínio ao [Google Search Console](https://search.google.com/search-console/about). Para um domínio próprio, use uma propriedade de domínio e valide pelo registro DNS solicitado. Para o subdomínio Railway, use uma propriedade de prefixo de URL e uma das opções de verificação disponibilizadas pelo Google. O método de verificação pode exigir acrescentar uma tag HTML ao site ou hospedar o arquivo fornecido pelo Google.

Após validar a propriedade, envie `https://SEU-DOMINIO/sitemap.xml` na seção **Sitemaps** e use **Inspeção de URL** para solicitar a indexação de `/` e `/primeiro-turno`. A configuração técnica permite rastreamento, mas a decisão e o prazo de indexação pertencem ao Google.

## Estrutura

- `public/`: interface, mapa, estilos, scripts e imagens.
- `server.mjs`: páginas, arquivos públicos, SEO e acesso validado ao TSE.
- `server.test.mjs` e `frontend.test.mjs`: testes com fonte oficial simulada; não dependem de disponibilidade da rede.
- `Dockerfile`: imagem de publicação detectada pelo Railway.
- `railway.json`: referência legada de configuração; defina o healthcheck e as variáveis também no painel do Railway.

O projeto não é um serviço do TSE. Os resultados exibidos dependem da publicação e da disponibilidade da fonte oficial. Não há resultados simulados na interface de produção.
