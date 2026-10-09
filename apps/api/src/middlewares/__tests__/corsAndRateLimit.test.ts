// Configura o banco descartável para que consultas Prisma dentro de rotas administrativas não falhem
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://insystens_test:TestOnly_8xQ!2026@127.0.0.1:54339/insystens_test?schema=public';
process.env.DIRECT_URL = process.env.DIRECT_URL || 'postgresql://insystens_test:TestOnly_8xQ!2026@127.0.0.1:54339/insystens_test?schema=public';

import { app } from '../../app';

async function runCorsAndRateLimitTests() {
  console.log('=== TESTES DE SEGURANÇA: CORS E RATE LIMITING ===\n');

  let passedCount = 0;
  let totalCount = 0;

  function assert(testName: string, condition: boolean, detail?: string) {
    totalCount++;
    if (condition) {
      passedCount++;
      console.log(`✓ PASSOU: [${testName}]`);
    } else {
      console.error(`✗ FALHOU: [${testName}] - ${detail || ''}`);
      process.exitCode = 1;
    }
  }

  // Certifica que o app Fastify inicializa seus plugins antes das chamadas
  await app.ready();

  // ----------------------------------------------------------------------------------------
  // 1. TESTES DE CORS
  // ----------------------------------------------------------------------------------------
  console.log('--- 1. Validação de CORS ---');

  // 1.1 Requisição sem Origin (server-to-server, curl, apps nativos) -> Deve ser permitida
  {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });
    assert(
      'CORS: Chamada sem header Origin é permitida (200)',
      res.statusCode === 200,
      `Recebido ${res.statusCode}`
    );
  }

  // 1.2 Requisição com Origin autorizada (default localhost:3000)
  {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        origin: 'http://localhost:3000',
      },
    });
    const allowOrigin = res.headers['access-control-allow-origin'];
    assert(
      'CORS: Origem autorizada recebe Access-Control-Allow-Origin',
      res.statusCode === 200 && allowOrigin === 'http://localhost:3000',
      `Allow-Origin: ${allowOrigin}, Status: ${res.statusCode}`
    );
  }

  // 1.3 Preflight OPTIONS com métodos e headers permitidos (x-api-key, x-admin-key)
  {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/admin/accounts',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-admin-key,x-api-key',
      },
    });

    const allowMethods = res.headers['access-control-allow-methods'] as string;
    const allowHeaders = res.headers['access-control-allow-headers'] as string;
    const allowCredentials = res.headers['access-control-allow-credentials'];

    assert(
      'CORS Preflight: OPTIONS retorna 204 com métodos e headers autorizados',
      res.statusCode === 204 &&
      allowCredentials === 'true' &&
      allowHeaders.toLowerCase().includes('x-admin-key') &&
      allowHeaders.toLowerCase().includes('x-api-key'),
      `Status: ${res.statusCode}, Methods: ${allowMethods}, Headers: ${allowHeaders}`
    );
  }

  // 1.4 Requisição com Origin não autorizada (ex: hacker-site.com) -> Bloqueada
  {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        origin: 'https://hacker-site-malicioso.com',
      },
    });
    const allowOrigin = res.headers['access-control-allow-origin'];
    assert(
      'CORS: Origem não autorizada é rejeitada (sem allow-origin e erro 500/bloqueio)',
      allowOrigin === undefined || res.statusCode !== 200,
      `Status: ${res.statusCode}, Allow-Origin retornado: ${allowOrigin}`
    );
  }

  // ----------------------------------------------------------------------------------------
  // 2. TESTES DE RATE LIMITING
  // ----------------------------------------------------------------------------------------
  console.log('\n--- 2. Validação de Rate Limiting ---');

  // 2.1 Limite estrito do subescopo de importação (máximo 5 req/min)
  // Utiliza um IP específico para isolar o teste
  const TEST_IP_IMPORT = '198.51.100.10';
  const MASTER_KEY = 'Secret_RateLimit_Test_2026!';
  process.env.ADMIN_MASTER_KEY = MASTER_KEY;

  let hit429OnImport = false;
  let responsesImport: number[] = [];

  for (let i = 0; i < 8; i++) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/imports',
      remoteAddress: TEST_IP_IMPORT,
      headers: {
        'x-admin-key': MASTER_KEY,
      },
    });
    responsesImport.push(res.statusCode);
    if (res.statusCode === 429) {
      hit429OnImport = true;
      break;
    }
  }

  assert(
    'RateLimit Imports: Dispara HTTP 429 ao exceder o teto de 5 req/min',
    hit429OnImport,
    `Respostas obtidas: ${responsesImport.join(', ')}`
  );

  // 2.2 Limite do escopo administrativo geral (/api/v1/admin/*)
  // Utiliza outro IP para testar teto de 20 req/min
  const TEST_IP_ADMIN = '198.51.100.20';
  let hit429OnAdmin = false;
  let countAdminSuccess = 0;

  for (let i = 0; i < 25; i++) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/ping',
      remoteAddress: TEST_IP_ADMIN,
      headers: {
        'x-admin-key': MASTER_KEY,
      },
    });
    if (res.statusCode === 200) {
      countAdminSuccess++;
    } else if (res.statusCode === 429) {
      hit429OnAdmin = true;
      break;
    }
  }

  assert(
    'RateLimit Admin: Dispara HTTP 429 no escopo /admin ao exceder 20 req/min',
    hit429OnAdmin && countAdminSuccess >= 15,
    `Sucessos antes do bloqueio: ${countAdminSuccess}, hit429: ${hit429OnAdmin}`
  );

  // 2.4 Alternância entre diferentes endpoints de importação sob o mesmo teto (5 req/min)
  {
    const TEST_IP_IMPORT_ALT = '198.51.100.15';
    let hit429OnAlt = false;

    // Faz chamadas intercaladas em rotas de importação diferentes:
    // 1: GET /api/v1/admin/imports
    // 2: GET /api/v1/admin/imports/job-fake-1
    // 3: GET /api/v1/admin/imports
    // 4: GET /api/v1/admin/imports/job-fake-2
    // 5: GET /api/v1/admin/imports
    // 6: Deve bater 429
    for (let i = 0; i < 7; i++) {
      const url = i % 2 === 0 ? '/api/v1/admin/imports' : `/api/v1/admin/imports/job-fake-${i}`;
      const res = await app.inject({
        method: 'GET',
        url,
        remoteAddress: TEST_IP_IMPORT_ALT,
        headers: {
          'x-admin-key': MASTER_KEY,
        },
      });
      if (res.statusCode === 429) {
        hit429OnAlt = true;
        break;
      }
    }

    assert(
      'RateLimit Imports Alternância: Limite é compartilhado entre diferentes rotas de importação',
      hit429OnAlt,
      `Esperado HTTP 429 na alternância de rotas de importação`
    );
  }

  // 2.5 Resposta amigável e segura no 429 (sem credenciais expostas)
  {
    const res429 = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/imports',
      remoteAddress: TEST_IP_IMPORT,
      headers: {
        'x-admin-key': MASTER_KEY,
      },
    });

    const body = JSON.parse(res429.payload);
    assert(
      'RateLimit 429: Retorna payload padronizado com Too Many Requests',
      res429.statusCode === 429 &&
      body.error === 'Too Many Requests' &&
      !JSON.stringify(body).includes(MASTER_KEY),
      `Payload: ${res429.payload}`
    );
  }

  // 2.6 Isolamento de IP: Outro IP continua apto a navegar
  {
    const FRESH_IP = '198.51.100.99';
    const resFresh = await app.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: FRESH_IP,
    });

    assert(
      'RateLimit Isolamento: IP distinto continua acessando normalmente (200)',
      resFresh.statusCode === 200,
      `Status do IP não bloqueado: ${resFresh.statusCode}`
    );
  }

  // ----------------------------------------------------------------------------------------
  // 3. TESTES DE TRUST PROXY E RATE LIMIT POR TENANT
  // ----------------------------------------------------------------------------------------
  console.log('\n--- 3. Validação de Trust Proxy e Rate Limiting por Tenant ---');

  // 3.1 Comportamento do trustProxy (quando habilitado, extrai IP do cliente do X-Forwarded-For)
  {
    // Constrói instância isolada com trustProxy: 1 (1 salto de proxy reverso)
    const { fastify: fastifyFactory } = await import('fastify');
    const rateLimitPlugin = (await import('@fastify/rate-limit')).default;

    const proxyApp = fastifyFactory({ trustProxy: 1 });
    await proxyApp.register(rateLimitPlugin, {
      global: true,
      max: 2,
      timeWindow: '1 minute',
      keyGenerator: (req) => req.ip,
    });

    proxyApp.get('/ip-check', async (req) => ({ ip: req.ip }));
    await proxyApp.ready();

    // Cliente Real A atrás do proxy
    const resProxyA1 = await proxyApp.inject({
      url: '/ip-check',
      remoteAddress: '10.0.0.1', // IP do proxy reverso
      headers: { 'x-forwarded-for': '198.51.100.111' },
    });
    const resProxyA2 = await proxyApp.inject({
      url: '/ip-check',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.111' },
    });
    const resProxyA3 = await proxyApp.inject({
      url: '/ip-check',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.111' },
    });

    // Cliente Real B passando pelo MESMO proxy reverso (10.0.0.1)
    const resProxyB = await proxyApp.inject({
      url: '/ip-check',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.222' },
    });

    assert(
      'TrustProxy: IP do cliente é extraído do header X-Forwarded-For',
      JSON.parse(resProxyA1.payload).ip === '198.51.100.111',
      `IP resolvido: ${resProxyA1.payload}`
    );
    assert(
      'TrustProxy: Limite bloqueia cliente A (429) mas preserva cliente B (200) sob mesmo proxy',
      resProxyA1.statusCode === 200 &&
      resProxyA2.statusCode === 200 &&
      resProxyA3.statusCode === 429 &&
      resProxyB.statusCode === 200,
      `A3: ${resProxyA3.statusCode}, B: ${resProxyB.statusCode}`
    );
  }

  // 3.2 Rate limiting por tenant autenticado e isolamento entre tenants sob mesmo IP
  {
    const { fastify: fastifyFactory } = await import('fastify');
    const rateLimitPlugin = (await import('@fastify/rate-limit')).default;

    const tenantTestApp = fastifyFactory();

    // Limite global por IP no hook onRequest (máximo 10)
    await tenantTestApp.register(rateLimitPlugin, {
      global: true,
      max: 10,
      timeWindow: '1 minute',
    });

    // Escopo de tenant: hook preHandler com validação e rate limit por tenantId
    await tenantTestApp.register(async (tenantScope) => {
      // Simulação do preHandler tenantContext
      tenantScope.addHook('preHandler', async (req, reply) => {
        const apiKey = req.headers['x-api-key'] as string;
        if (!apiKey) {
          return reply.status(401).send({ error: 'Unauthorized' });
        }
        if (apiKey === 'key-tenant-alpha') req.tenantId = 'tenant-alpha-uuid';
        else if (apiKey === 'key-tenant-beta') req.tenantId = 'tenant-beta-uuid';
        else return reply.status(401).send({ error: 'Invalid key' });
      });

      // Rate limit específico de tenant executado no hook preHandler após autenticação
      await tenantScope.register(rateLimitPlugin, {
        hook: 'preHandler',
        max: 2,
        timeWindow: '1 minute',
        keyGenerator: (req) => req.tenantId ? `tenant:${req.tenantId}` : `ip:${req.ip}`,
        errorResponseBuilder: (req, ctx) => ({
          statusCode: 429,
          error: 'Too Many Requests',
          message: 'Limite do plano de tenant excedido.',
        }),
      });

      // Endpoints múltiplos do tenant para testar compartilhamento da cota
      tenantScope.get('/profile', async (req) => ({ tenant: req.tenantId, path: 'profile' }));
      tenantScope.get('/filters', async (req) => ({ tenant: req.tenantId, path: 'filters' }));
    }, { prefix: '/api/v1/tenant' });

    await tenantTestApp.ready();

    const SHARED_NAT_IP = '203.0.113.88';

    // Tenant Alpha faz 2 requisições alternadas entre /profile e /filters (deve passar)
    const tAlpha1 = await tenantTestApp.inject({
      url: '/api/v1/tenant/profile',
      remoteAddress: SHARED_NAT_IP,
      headers: { 'x-api-key': 'key-tenant-alpha' },
    });
    const tAlpha2 = await tenantTestApp.inject({
      url: '/api/v1/tenant/filters',
      remoteAddress: SHARED_NAT_IP,
      headers: { 'x-api-key': 'key-tenant-alpha' },
    });
    // Tenant Alpha faz a 3ª requisição (deve estourar cota do tenant -> 429)
    const tAlpha3 = await tenantTestApp.inject({
      url: '/api/v1/tenant/profile',
      remoteAddress: SHARED_NAT_IP,
      headers: { 'x-api-key': 'key-tenant-alpha' },
    });

    // Tenant Beta faz requisição pelo MESMO IP de origem (SHARED_NAT_IP)
    // Não deve sofrer bloqueio porque a cota é isolada por tenantId
    const tBeta1 = await tenantTestApp.inject({
      url: '/api/v1/tenant/profile',
      remoteAddress: SHARED_NAT_IP,
      headers: { 'x-api-key': 'key-tenant-beta' },
    });

    // Requisição sem credencial é barrada no preHandler (401) sem queimar cota
    const tNoKey = await tenantTestApp.inject({
      url: '/api/v1/tenant/profile',
      remoteAddress: SHARED_NAT_IP,
    });

    assert(
      'RateLimit Tenant: Cota do tenant é compartilhada entre rotas (/profile e /filters)',
      tAlpha1.statusCode === 200 && tAlpha2.statusCode === 200 && tAlpha3.statusCode === 429,
      `Alpha 1: ${tAlpha1.statusCode}, Alpha 2: ${tAlpha2.statusCode}, Alpha 3: ${tAlpha3.statusCode}`
    );
    assert(
      'RateLimit Tenant Isolamento: Tenant Beta não é afetado pelo esgotamento de Alpha no mesmo IP',
      tBeta1.statusCode === 200,
      `Beta 1 recebido: ${tBeta1.statusCode}`
    );
    assert(
      'RateLimit Tenant: Requisição não autenticada recebe 401 antes do rate limiter',
      tNoKey.statusCode === 401,
      `Status recebido sem chave: ${tNoKey.statusCode}`
    );
  }

  console.log(`\nRESUMO: ${passedCount}/${totalCount} testes de CORS e Rate Limit aprovados.`);
  if (passedCount !== totalCount) {
    throw new Error('Falha nos testes de CORS e Rate Limit.');
  }
}

runCorsAndRateLimitTests().catch((err) => {
  console.error('ERRO FATAL NOS TESTES:', err);
  process.exit(1);
});
