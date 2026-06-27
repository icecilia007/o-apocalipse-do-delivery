/**
 * CheckoutService.test.js
 *
 * Ciclo TDD respeitado:
 *   Vermelho  → testes escritos antes da implementação
 *   Verde     → CheckoutService implementado para passar nos testes
 *   Refatore  → Extract Method aplicado no serviço
 *
 * Padrões aplicados:
 *   - PedidoBuilder (Data Builder): elimina Obscure Setup
 *   - Stubs: controlam o retorno do gateway (estado)
 *   - Mocks (jest.fn): verificam se e-mail foi ou não chamado (comportamento)
 *
 * Cobertura do GFC:
 *   CT-01 → N1→N2→N3→N4→N7  (APROVADO)
 *   CT-02 → N1→N2→N3→N5→N7  (RECUSADO)
 *   CT-03 → N1→N2→N6→N7     (exceção no gateway)
 */

const { CheckoutService } = require('../../src/services/CheckoutService');
const { PedidoBuilder }   = require('../../src/builders/PedidoBuilder');

// ─── Factories de Stubs e Mocks ───────────────────────────────────────────────

/**
 * Cria um stub do gateway controlando o status de retorno.
 * Stub = controla estado/retorno, não verifica chamadas.
 */
function criarGatewayStub(statusRetorno) {
  return {
    cobrar: jest.fn().mockResolvedValue({ status: statusRetorno })
  };
}

/**
 * Cria um stub do gateway que lança exceção (simula timeout/queda).
 */
function criarGatewayComFalha(mensagemErro = 'Timeout: gateway indisponível') {
  return {
    cobrar: jest.fn().mockRejectedValue(new Error(mensagemErro))
  };
}

/**
 * Cria um mock do repositório.
 * Retorna o pedido com id simulado.
 */
function criarRepositoryMock() {
  return {
    salvar: jest.fn().mockImplementation(async (pedido) => ({ ...pedido, id: 99 }))
  };
}

/**
 * Cria um mock do serviço de e-mail.
 * Mock = verificamos SE foi chamado e COM QUAIS argumentos.
 */
function criarEmailMock() {
  return {
    enviarConfirmacao: jest.fn().mockResolvedValue(undefined)
  };
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('CheckoutService', () => {

  // ── CT-01: N1→N2→N3→N4→N7 ────────────────────────────────────────────────
  describe('Caminho N4 — pagamento APROVADO (caminho feliz)', () => {

    let gateway, repository, emailService, service, pedido;

    beforeEach(() => {
      gateway      = criarGatewayStub('APROVADO');
      repository   = criarRepositoryMock();
      emailService = criarEmailMock();
      service      = new CheckoutService(gateway, repository, emailService);
      pedido       = new PedidoBuilder()
                       .comEmail('cliente@email.com')
                       .comValor(150.00)
                       .build();
    });

    test('deve retornar o pedido salvo com status PROCESSADO', async () => {
      const resultado = await service.processar(pedido);

      expect(resultado).not.toBeNull();
      expect(resultado.status).toBe('PROCESSADO');
      expect(resultado.id).toBe(99);
    });

    test('deve salvar o pedido no repositório exatamente uma vez', async () => {
      await service.processar(pedido);

      expect(repository.salvar).toHaveBeenCalledTimes(1);
      expect(repository.salvar).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'PROCESSADO' })
      );
    });

    test('MOCK — deve disparar o e-mail de confirmação para o cliente (comportamento)', async () => {
      await service.processar(pedido);

      // Aguarda o fire-and-forget resolver
      await Promise.resolve();

      expect(emailService.enviarConfirmacao).toHaveBeenCalledTimes(1);
      expect(emailService.enviarConfirmacao).toHaveBeenCalledWith(
        'cliente@email.com',
        'Pagamento Aprovado'
      );
    });

    test('deve chamar o gateway com o valor e cartão do pedido', async () => {
      await service.processar(pedido);

      expect(gateway.cobrar).toHaveBeenCalledWith(150.00, pedido.cartao);
    });
  });

  // ── CT-02: N1→N2→N3→N5→N7 ────────────────────────────────────────────────
  describe('Caminho N5 — pagamento RECUSADO (falha de negócio)', () => {

    let gateway, repository, emailService, service, pedido;

    beforeEach(() => {
      gateway      = criarGatewayStub('RECUSADO');
      repository   = criarRepositoryMock();
      emailService = criarEmailMock();
      service      = new CheckoutService(gateway, repository, emailService);
      pedido       = new PedidoBuilder()
                       .comEmail('cliente@email.com')
                       .comValor(150.00)
                       .build();
    });

    test('deve retornar null quando o cartão é recusado', async () => {
      const resultado = await service.processar(pedido);

      expect(resultado).toBeNull();
    });

    test('deve salvar o pedido com status FALHOU', async () => {
      await service.processar(pedido);

      expect(repository.salvar).toHaveBeenCalledTimes(1);
      expect(repository.salvar).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'FALHOU' })
      );
    });

    test('MOCK — NÃO deve enviar e-mail quando o pagamento falha (comportamento crítico)', async () => {
      await service.processar(pedido);

      await Promise.resolve();

      expect(emailService.enviarConfirmacao).not.toHaveBeenCalled();
    });
  });

  // ── CT-03: N1→N2→N6→N7 ───────────────────────────────────────────────────
  describe('Caminho N6 — ERRO_GATEWAY (falha de infraestrutura / catch)', () => {

    let gateway, repository, emailService, logger, service, pedido;

    beforeEach(() => {
      gateway      = criarGatewayComFalha('Timeout: gateway indisponível');
      repository   = criarRepositoryMock();
      emailService = criarEmailMock();
      logger       = { error: jest.fn() };
      service      = new CheckoutService(gateway, repository, emailService, logger);
      pedido       = new PedidoBuilder()
                       .comEmail('cliente@email.com')
                       .comValor(150.00)
                       .build();
    });

    test('deve retornar null quando o gateway lança exceção', async () => {
      const resultado = await service.processar(pedido);

      expect(resultado).toBeNull();
    });

    test('deve salvar o pedido com status ERRO_GATEWAY', async () => {
      await service.processar(pedido);

      expect(repository.salvar).toHaveBeenCalledTimes(1);
      expect(repository.salvar).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'ERRO_GATEWAY' })
      );
    });

    test('MOCK — NÃO deve enviar e-mail quando há erro de infraestrutura', async () => {
      await service.processar(pedido);

      await Promise.resolve();

      expect(emailService.enviarConfirmacao).not.toHaveBeenCalled();
    });

    test('deve registrar o erro do gateway sem poluir a saida dos testes', async () => {
      await service.processar(pedido);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('gateway'),
        expect.stringContaining('Timeout: gateway')
      );
    });

    test('deve tratar a exceção sem relançá-la (falha controlada)', async () => {
      await expect(service.processar(pedido)).resolves.not.toThrow();
    });
  });

  // ── Testes do PedidoBuilder ───────────────────────────────────────────────
  describe('PedidoBuilder — Data Builder Pattern', () => {

    test('deve construir pedido com valores padrão sensatos', () => {
      const pedido = new PedidoBuilder().build();

      expect(pedido.clienteEmail).toBe('cliente@entregasja.com');
      expect(pedido.valor).toBe(100.00);
      expect(pedido.cartao).toBeDefined();
      expect(pedido.status).toBe('PENDENTE');
    });

    test('deve permitir sobrescrever apenas o e-mail', () => {
      const pedido = new PedidoBuilder().comEmail('outro@email.com').build();

      expect(pedido.clienteEmail).toBe('outro@email.com');
      expect(pedido.valor).toBe(100.00); // padrão mantido
    });

    test('deve construir pedido sem e-mail para testar validação', () => {
      const pedido = new PedidoBuilder().semEmail().build();

      expect(pedido.clienteEmail).toBeNull();
    });

    test('deve construir pedido sem cartão para testar validação', () => {
      const pedido = new PedidoBuilder().semCartao().build();

      expect(pedido.cartao).toBeNull();
    });
  });

});
