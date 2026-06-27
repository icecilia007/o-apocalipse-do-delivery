/**
 * Testes do ConfigCache (Fase 4 — proteção contra Thundering Herd).
 */
const { ConfigCache } = require('../../src/cache/ConfigCache');

const sleepFake = () => Promise.resolve();

describe('ConfigCache — single-flight (Thundering Herd)', () => {
  test('coalesce N requisições simultâneas em uma única leitura no banco', async () => {
    let leituras = 0;
    const cache = new ConfigCache(async () => {
      leituras++;
      await new Promise((r) => setTimeout(r, 20));
      return { taxaServico: 0.05 };
    });

    const N = 5000;
    const resultados = await Promise.all(Array.from({ length: N }, () => cache.get()));

    expect(resultados).toHaveLength(N);
    expect(resultados.every((r) => r.taxaServico === 0.05)).toBe(true);
    expect(leituras).toBe(1);
    expect(cache.metricas.coalescidas).toBe(N - 1);
  });
});

describe('ConfigCache — TTL e flush', () => {
  test('serve do cache (hit) dentro do TTL sem reler o banco', async () => {
    let leituras = 0;
    const cache = new ConfigCache(
      async () => {
        leituras++;
        return { v: leituras };
      },
      { ttlMs: 10000 }
    );

    await cache.get();
    await cache.get();
    await cache.get();

    expect(leituras).toBe(1);
    expect(cache.metricas.hits).toBe(2);
  });

  test('flush força nova leitura do banco', async () => {
    let leituras = 0;
    const cache = new ConfigCache(
      async () => {
        leituras++;
        return { v: leituras };
      },
      { ttlMs: 10000 }
    );

    await cache.get();
    cache.flush();
    await cache.get();

    expect(leituras).toBe(2);
  });
});

describe('ConfigCache — resiliência na recarga', () => {
  test('faz retry com backoff e recupera após falha transitória do banco', async () => {
    let tentativas = 0;
    const cache = new ConfigCache(
      async () => {
        tentativas++;
        if (tentativas < 2) throw new Error('DB indisponível');
        return { ok: true };
      },
      { maxRetries: 3, sleepImpl: sleepFake }
    );

    const r = await cache.get();

    expect(r).toEqual({ ok: true });
    expect(tentativas).toBe(2);
  });

  test('usa o sleep padrao com backoff quando nao recebe sleepImpl', async () => {
    let tentativas = 0;
    const cache = new ConfigCache(
      async () => {
        tentativas++;
        if (tentativas === 1) throw new Error('DB oscilou');
        return { ok: true };
      },
      { maxRetries: 1, backoffMs: 0, jitterMs: 0 }
    );

    const r = await cache.get();

    expect(r).toEqual({ ok: true });
    expect(tentativas).toBe(2);
    expect(cache.metricas.leiturasNoBanco).toBe(2);
  });

  test('propaga o erro quando o banco falha em todas as tentativas', async () => {
    const cache = new ConfigCache(
      async () => {
        throw new Error('DB caiu');
      },
      { maxRetries: 2, sleepImpl: sleepFake }
    );

    await expect(cache.get()).rejects.toThrow('DB caiu');
  });
});

describe('ConfigCache — snapshot', () => {
  test('expõe métricas para o /health', async () => {
    const cache = new ConfigCache(async () => ({ v: 1 }), { ttlMs: 10000 });
    await cache.get();
    const snap = cache.snapshot();
    expect(snap.temValor).toBe(true);
    expect(snap.leiturasNoBanco).toBe(1);
  });
});
