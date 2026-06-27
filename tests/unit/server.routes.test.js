const http = require('http');

const CHAOS_ENV_KEYS = [
  'GATEWAY_URL',
  'GATEWAY_TIMEOUT_MS',
  'GATEWAY_MAX_RETRIES',
  'GATEWAY_BACKOFF_MS'
];
const ORIGINAL_ENV = { ...process.env };

const gatewayModulePath = require.resolve('../../src/gateways/HttpGatewayPagamento');
const cacheModulePath = require.resolve('../../src/cache/ConfigCache');

function resetChaosEnv() {
  for (const key of CHAOS_ENV_KEYS) delete process.env[key];
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function loadServerDefault() {
  jest.resetModules();
  resetChaosEnv();
  jest.dontMock(gatewayModulePath);
  jest.dontMock(cacheModulePath);
  return require('../../src/server');
}

function loadServerChaos({ gatewayInstance, cacheMockFactory } = {}) {
  jest.resetModules();
  resetChaosEnv();
  process.env.GATEWAY_URL = 'http://fake-gateway';

  const gateway = gatewayInstance ?? {
    cobrar: jest.fn().mockResolvedValue({ status: 'APROVADO' }),
    estadoAtual: jest.fn(() => ({ estado: 'FECHADO', amostras: 0, taxaErro: 0 }))
  };
  const HttpGatewayPagamento = jest.fn(() => gateway);

  jest.doMock(gatewayModulePath, () => ({ HttpGatewayPagamento }));
  if (cacheMockFactory) {
    jest.doMock(cacheModulePath, cacheMockFactory);
  } else {
    jest.dontMock(cacheModulePath);
  }

  const server = require('../../src/server');
  return { ...server, gateway, HttpGatewayPagamento };
}

function requestJson(app, { method = 'GET', path = '/', body } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const payload = body === undefined ? null : JSON.stringify(body);
      const headers = payload
        ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        : {};

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => {
            server.close(() => {
              let parsed = null;
              if (raw) parsed = JSON.parse(raw);
              resolve({ status: res.statusCode, body: parsed, raw });
            });
          });
        }
      );

      req.on('error', (error) => {
        server.close(() => reject(error));
      });

      if (payload) req.write(payload);
      req.end();
    });

    server.on('error', reject);
  });
}

function pedidoValido() {
  return {
    clienteEmail: 'cliente@email.com',
    valor: 150,
    cartao: {
      numero: '4111111111111111',
      validade: '12/2028',
      cvv: '123'
    }
  };
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.resetModules();
  jest.dontMock(gatewayModulePath);
  jest.dontMock(cacheModulePath);
  restoreEnv();
});

describe('server routes - modo padrao', () => {
  test('retorna 400 quando o payload de checkout e invalido', async () => {
    const { app } = loadServerDefault();

    const response = await requestJson(app, {
      method: 'POST',
      path: '/api/v1/checkout',
      body: { clienteEmail: null, valor: 0, cartao: null }
    });

    expect(response.status).toBe(400);
    expect(response.body.erro).toBe('Dados inválidos para checkout');
    expect(response.body.detalhes).toEqual(
      expect.arrayContaining([
        'clienteEmail inválido',
        'valor deve ser maior que zero',
        'cartao incompleto'
      ])
    );
  });

  test('processa checkout aprovado com as dependencias padrao', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { app } = loadServerDefault();

    const response = await requestJson(app, {
      method: 'POST',
      path: '/api/v1/checkout',
      body: pedidoValido()
    });

    expect(response.status).toBe(200);
    expect(response.body.mensagem).toBe('Pedido finalizado com sucesso!');
    expect(response.body.pedido).toEqual(
      expect.objectContaining({ status: 'PROCESSADO', clienteEmail: 'cliente@email.com' })
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('E-mail enviado para cliente@email.com')
    );
  });

  test('invalida cache mesmo quando o modo caos esta desligado', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { app } = loadServerDefault();

    const response = await requestJson(app, {
      method: 'POST',
      path: '/api/v1/cache/flush'
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'cache_invalidated' });
    expect(consoleSpy).toHaveBeenCalledWith('CACHE LIMPO ABRUPTAMENTE!');
  });

  test('health informa que o modo caos esta desligado', async () => {
    const { app } = loadServerDefault();

    const response = await requestJson(app, { path: '/health' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', modoCaos: false });
  });
});

describe('server routes - modo caos', () => {
  test('usa gateway HTTP, aquece cache e expoe observabilidade no health', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const gatewayInstance = {
      cobrar: jest.fn().mockResolvedValue({ status: 'APROVADO' }),
      estadoAtual: jest.fn(() => ({ estado: 'FECHADO', amostras: 0, taxaErro: 0 }))
    };
    const { app, HttpGatewayPagamento } = loadServerChaos({ gatewayInstance });

    const checkout = await requestJson(app, {
      method: 'POST',
      path: '/api/v1/checkout',
      body: pedidoValido()
    });
    const health = await requestJson(app, { path: '/health' });

    expect(HttpGatewayPagamento).toHaveBeenCalledWith(
      'http://fake-gateway',
      expect.objectContaining({ timeoutMs: 2000, maxRetries: 3, backoffMs: 500 })
    );
    expect(checkout.status).toBe(200);
    expect(health.status).toBe(200);
    expect(health.body.modoCaos).toBe(true);
    expect(health.body.circuitBreaker).toEqual({ estado: 'FECHADO', amostras: 0, taxaErro: 0 });
    expect(health.body.cache).toEqual(expect.objectContaining({ temValor: true }));
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('E-mail enviado para cliente@email.com')
    );
  });

  test('degrada graciosamente quando o cache falha e o pagamento nao processa', async () => {
    const cache = {
      get: jest.fn().mockRejectedValue(new Error('cache down')),
      flush: jest.fn(),
      snapshot: jest.fn(() => ({ temValor: false }))
    };
    const ConfigCache = jest.fn(() => cache);
    const gatewayInstance = {
      cobrar: jest.fn().mockResolvedValue({ status: 'RECUSADO' }),
      estadoAtual: jest.fn(() => ({ estado: 'FECHADO', amostras: 1, taxaErro: 0 }))
    };
    const { app } = loadServerChaos({
      gatewayInstance,
      cacheMockFactory: () => ({ ConfigCache })
    });

    const response = await requestJson(app, {
      method: 'POST',
      path: '/api/v1/checkout',
      body: pedidoValido()
    });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      erro: 'Não foi possível processar seu pagamento. Tente mais tarde.'
    });
    expect(cache.get).toHaveBeenCalledTimes(1);
  });

  test('flush chama o cache quando o modo caos esta ligado', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const cache = {
      get: jest.fn().mockResolvedValue({}),
      flush: jest.fn(),
      snapshot: jest.fn(() => ({ temValor: false }))
    };
    const ConfigCache = jest.fn(() => cache);
    const { app } = loadServerChaos({ cacheMockFactory: () => ({ ConfigCache }) });

    const response = await requestJson(app, {
      method: 'POST',
      path: '/api/v1/cache/flush'
    });

    expect(response.status).toBe(200);
    expect(cache.flush).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith('CACHE LIMPO ABRUPTAMENTE!');
  });
});