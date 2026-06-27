/**
 * Step definitions (glue code) que tornam os arquivos .feature uma
 * especificação viva executável, ligando o Gherkin ao CheckoutService.
 *
 * Padrões reutilizados da Fase 2:
 *   - Data Builder (PedidoBuilder) para fabricar o pedido
 *   - Stubs para controlar o estado de retorno do gateway
 *   - Mocks (spies manuais) para asserção de comportamento (e-mail / repositório)
 *
 * Cucumber roda fora do Jest, então usamos `assert` nativo e spies próprios
 * (sem jest.fn) para rastrear chamadas.
 */
const assert = require('assert');
const { Given, When, Then, setWorldConstructor } = require('@cucumber/cucumber');

const { CheckoutService } = require('../../src/services/CheckoutService');
const { PedidoBuilder }   = require('../../src/builders/PedidoBuilder');
const { validarPayload }  = require('../../src/server');

/** Cria um spy: função que registra chamadas e delega para a implementação. */
function criarSpy(impl = async () => {}) {
  const fn = async (...args) => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [];
  return fn;
}

class CheckoutWorld {
  constructor() {
    // Dependências padrão (gateway disponível, repositório e e-mail funcionando).
    this.gateway = {
      cobrar: criarSpy(async () => ({ status: 'APROVADO' }))
    };
    this.repository = {
      salvar: criarSpy(async (pedido) => ({ ...pedido, id: 99 }))
    };
    this.emailService = {
      enviarConfirmacao: criarSpy(async () => undefined)
    };
    this.logger = {
      error: () => undefined
    };
    this.pedido = null;
    this.resultado = undefined;
  }

  novoServico() {
    return new CheckoutService(this.gateway, this.repository, this.emailService, this.logger);
  }

  /** Replica a lógica da rota: valida antes e só processa se o payload for válido. */
  async processarComoRota() {
    const erros = validarPayload(this.pedido);
    if (erros.length > 0) {
      this.resultado = undefined;
      return;
    }
    this.resultado = await this.novoServico().processar(this.pedido);
    await new Promise((r) => setImmediate(r)); // deixa o e-mail fire-and-forget resolver
  }
}

setWorldConstructor(CheckoutWorld);

// ─── Contexto (Dado / E) ────────────────────────────────────────────────────

Given('que o gateway de pagamento está disponível', function () {
  this.gateway.cobrar = criarSpy(async () => ({ status: 'APROVADO' }));
});

Given(/^(?:que )?o repositório de pedidos está funcionando$/, function () {
  this.repository.salvar = criarSpy(async (pedido) => ({ ...pedido, id: 99 }));
});

Given('o serviço de e-mail está disponível', function () {
  this.emailService.enviarConfirmacao = criarSpy(async () => undefined);
});

// ─── Construção do pedido (Data Builder) ─────────────────────────────────────

Given(
  'um pedido válido com email {string}, valor {float} e cartão informado',
  function (email, valor) {
    this.pedido = new PedidoBuilder().comEmail(email).comValor(valor).build();
  }
);

Given('um pedido sem e-mail informado', function () {
  this.pedido = new PedidoBuilder().semEmail().build();
});

// ─── Ações (Quando) ──────────────────────────────────────────────────────────

When('o checkout é processado', async function () {
  await this.processarComoRota();
});

When('o gateway retorna status {string}', async function (status) {
  this.gateway.cobrar = criarSpy(async () => ({ status }));
  this.resultado = await this.novoServico().processar(this.pedido);
  await new Promise((r) => setImmediate(r));
});

When('o gateway lança uma exceção de timeout', async function () {
  this.gateway.cobrar = criarSpy(async () => {
    throw new Error('Timeout: gateway indisponível');
  });
  this.resultado = await this.novoServico().processar(this.pedido);
  await new Promise((r) => setImmediate(r));
});

// ─── Asserções (Então / E) ───────────────────────────────────────────────────

Then('o status do pedido deve ser {string}', function (statusEsperado) {
  assert.strictEqual(this.pedido.status, statusEsperado);
});

Then('o pedido deve ser salvo no repositório', function () {
  assert.strictEqual(
    this.repository.salvar.calls.length,
    1,
    'esperava exatamente 1 chamada a repository.salvar'
  );
});

Then('um e-mail de confirmação deve ser enviado para {string}', function (email) {
  assert.strictEqual(
    this.emailService.enviarConfirmacao.calls.length,
    1,
    'esperava 1 envio de e-mail'
  );
  const [destinatario, mensagem] = this.emailService.enviarConfirmacao.calls[0];
  assert.strictEqual(destinatario, email);
  assert.strictEqual(mensagem, 'Pagamento Aprovado');
});

Then('a resposta deve conter o pedido salvo', function () {
  assert.ok(this.resultado, 'resposta não deveria ser nula');
  assert.strictEqual(this.resultado.status, 'PROCESSADO');
  assert.ok(this.resultado.id, 'pedido salvo deveria ter id');
});

Then('nenhum e-mail de confirmação deve ser enviado', function () {
  assert.strictEqual(
    this.emailService.enviarConfirmacao.calls.length,
    0,
    'nenhum e-mail deveria ter sido enviado'
  );
});

Then('a resposta deve ser nula', function () {
  assert.strictEqual(this.resultado, null);
});

Then('o gateway não deve ser chamado', function () {
  assert.strictEqual(
    this.gateway.cobrar.calls.length,
    0,
    'o gateway não deveria ter sido chamado'
  );
});

Then('o repositório não deve ser chamado', function () {
  assert.strictEqual(
    this.repository.salvar.calls.length,
    0,
    'o repositório não deveria ter sido chamado'
  );
});
