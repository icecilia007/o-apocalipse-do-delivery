const express = require('express');
const { CheckoutService } = require('./services/CheckoutService');

const app = express();
app.use(express.json());

// ───────────────────────────────────────────────────────────────────────────
// Seleção de dependências.
//
// Modo PADRÃO (sem env): mocks em memória — usado pelos testes e pela demo
// local. Comportamento idêntico ao código original (não afeta Fase 1/2/3).
//
// Modo CAOS (Fase 4): se GATEWAY_URL estiver definido, o checkout passa a
// chamar o gateway externo REAL via HTTP (atravessando o Toxiproxy) usando o
// adapter resiliente (timeout/retry/backoff+jitter/circuit breaker), e o cache
// de configuração ganha proteção contra Thundering Herd.
// ───────────────────────────────────────────────────────────────────────────
const MODO_CAOS = Boolean(process.env.GATEWAY_URL);

let gatewayPagamento;
let configCache = null;

if (MODO_CAOS) {
  const { HttpGatewayPagamento } = require('./gateways/HttpGatewayPagamento');
  const { ConfigCache } = require('./cache/ConfigCache');

  gatewayPagamento = new HttpGatewayPagamento(process.env.GATEWAY_URL, {
    timeoutMs: Number(process.env.GATEWAY_TIMEOUT_MS) || 2000,
    maxRetries: Number(process.env.GATEWAY_MAX_RETRIES) || 3,
    backoffMs: Number(process.env.GATEWAY_BACKOFF_MS) || 500
  });

  // "Banco" lento simulado por trás do cache (leitura de ~150ms).
  const lerConfigDoBanco = () =>
    new Promise((resolve) =>
      setTimeout(() => resolve({ taxaServico: 0.05, atualizadoEm: Date.now() }), 150)
    );
  configCache = new ConfigCache(lerConfigDoBanco, { ttlMs: 30000 });
} else {
  gatewayPagamento = {
    cobrar: async () =>
      new Promise((resolve) => setTimeout(() => resolve({ status: 'APROVADO' }), 300))
  };
}

const pedidoRepositoryMock = {
  salvar: async (pedido) => ({ ...pedido, id: Math.floor(Math.random() * 10000) })
};

const emailServiceMock = {
  enviarConfirmacao: async (email, msg) =>
    console.log(`E-mail enviado para ${email}: ${msg}`)
};

const checkoutService = new CheckoutService(
  gatewayPagamento,
  pedidoRepositoryMock,
  emailServiceMock
);

function validarPayload({ clienteEmail, valor, cartao }) {
  const erros = [];
  if (!clienteEmail || !clienteEmail.includes('@')) erros.push('clienteEmail inválido');
  if (!valor || valor <= 0)                          erros.push('valor deve ser maior que zero');
  if (!cartao || !cartao.numero || !cartao.cvv)      erros.push('cartao incompleto');
  return erros;
}

app.post('/api/v1/checkout', async (req, res) => {
  const erros = validarPayload(req.body);
  if (erros.length > 0) {
    return res.status(400).json({ erro: 'Dados inválidos para checkout', detalhes: erros });
  }

  // Consulta de configuração protegida contra Thundering Herd (modo caos).
  if (configCache) {
    try {
      await configCache.get();
    } catch (_) {
      /* degradação graciosa: segue com a configuração default */
    }
  }

  const { clienteEmail, valor, cartao } = req.body;
  const pedido = { clienteEmail, valor, cartao, status: 'PENDENTE' };

  const resultado = await checkoutService.processar(pedido);

  if (resultado && resultado.status === 'PROCESSADO') {
    return res.status(200).json({ mensagem: 'Pedido finalizado com sucesso!', pedido: resultado });
  }

  return res.status(500).json({
    erro: 'Não foi possível processar seu pagamento. Tente mais tarde.'
  });
});

app.post('/api/v1/cache/flush', (req, res) => {
  if (configCache) configCache.flush();
  console.log('CACHE LIMPO ABRUPTAMENTE!');
  res.json({ status: 'cache_invalidated' });
});

// Endpoint de observabilidade para SRE / medição de MTTR.
app.get('/health', (req, res) => {
  const saude = { status: 'ok', modoCaos: MODO_CAOS };
  if (MODO_CAOS && typeof gatewayPagamento.estadoAtual === 'function') {
    saude.circuitBreaker = gatewayPagamento.estadoAtual();
  }
  if (configCache) saude.cache = configCache.snapshot();
  res.json(saude);
});

module.exports = { app, validarPayload };

/* istanbul ignore next */
if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, () =>
    console.log(`Servidor da EntregasJá rodando na porta ${PORT} (modoCaos=${MODO_CAOS})`)
  );
}
