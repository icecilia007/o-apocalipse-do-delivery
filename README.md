# O Apocalipse do Delivery — EntregasJá

Blindagem do microsserviço de **Checkout/Pagamentos** para a Black Friday:
código limpo, cobertura contra mutantes, BDD e resiliência sob caos (SRE).

## Integrantes
- Sthel
- Izabela
- Filipe
- Rafael
- Amanda
- Vinícius

---

## Como rodar

```bash
npm install        # instala dependências

npm test           # Fase 3 — testes unitários (Jest) + cobertura
npm run bdd        # Fase 2 — especificação viva (Cucumber)
npm run mutation   # Fase 3 — teste de mutação (Stryker)
npm start          # sobe o servidor (modo padrão, porta 3000)

node chaos/smoke-resiliencia.js   # Fase 4 — prova local de resiliência (sem docker/k6)
```

---

## Mapa das fases e artefatos

> Documento único com Fases 1, 3 e 4: [`docs/relatorio-fases.md`](docs/relatorio-fases.md).

### Fase 1 — Análise Estrutural, Complexidade e Métricas
- [`docs/relatorio-fases.md`](docs/relatorio-fases.md#fase-1--análise-estrutural-complexidade-e-métricas)
  — grafo de fluxo, **V(G) = 3** (3 fórmulas de McCabe) e estimativa (Test Case Points ≈ 28h).
- [`docs/grafo-fluxo-processar.png`](docs/grafo-fluxo-processar.png) — GFC do método `processar`.

### Fase 2 — TDD, BDD e Padrões de Projeto
- `features/*.feature` — cenários Gherkin (sucesso + caminhos infelizes).
- `features/steps/checkout.steps.js` — step definitions (BDD executável).
- `src/services/CheckoutService.js` — refatorado com **Extract Method**.
- `src/builders/PedidoBuilder.js` — **Data Builder** (elimina Obscure Setup).
- `tests/unit/` — TDD com **Stubs** (estado) e **Mocks** (comportamento do e-mail).

### Fase 3 — Teste de Mutação
- `stryker.config.json` — configuração do Stryker (threshold 80, meta 90).
- `tests/unit/mutant-killers.test.js` — testes que matam os mutantes sobreviventes.
- [`docs/relatorio-fases.md`](docs/relatorio-fases.md#fase-3--teste-de-mutação) — resultado e justificativa de mutantes equivalentes.
- `reports/mutation/mutation.html` — relatório (**Mutation Score 100%**).

### Fase 4 — Engenharia do Caos e Performance (SRE)
- [`docs/relatorio-fases.md`](docs/relatorio-fases.md#fase-4--engenharia-do-caos-e-performance-sre) — SLOs, mecanismos, MTTR e roteiro.
- `src/gateways/HttpGatewayPagamento.js` — timeout, retry, backoff+jitter, **circuit breaker**.
- `src/cache/ConfigCache.js` — **single-flight** (proteção Thundering Herd).
- `chaos/` — gateway externo, Toxiproxy, scripts k6 e medidor de MTTR (ver [`chaos/README.md`](chaos/README.md)).

---

## Arquitetura (resumo)

`POST /api/v1/checkout` → valida payload (RF01) → `CheckoutService.processar`:

| Resposta do gateway | Status final | HTTP | E-mail |
| :--- | :--- | :--- | :--- |
| `APROVADO` | `PROCESSADO` | 200 | enviado (assíncrono) |
| `RECUSADO` | `FALHOU` | 500 | **não** enviado |
| exceção / timeout / breaker | `ERRO_GATEWAY` | 500 | **não** enviado |

No **modo caos** (`GATEWAY_URL` definido), o `cobrar` vira uma chamada HTTP real ao
gateway externo, protegida por timeout/retry/backoff+jitter/circuit breaker, e o
endpoint `GET /health` expõe o estado do breaker e do cache.

---

## Resultados de qualidade

| Fase | Métrica | Resultado |
| :--- | :--- | :--- |
| Fase 1 | Complexidade Ciclomática | V(G) = 3 (baixo risco) |
| Fase 2 | Cenários BDD | 4 cenários / 29 passos ✓ |
| Fase 3 | Mutation Score | **100%** (36/36 mutantes mortos) |
| Fase 3 | Testes unitários | 49 testes ✓ |
| Fase 4 | SLOs | p95 < 5000ms, erro < 5% |
