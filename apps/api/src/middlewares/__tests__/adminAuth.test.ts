import fastify, { FastifyInstance } from 'fastify';
import { adminAuth } from '../adminAuth';

async function buildAdminTestApp(): Promise<FastifyInstance> {
  const app = fastify({ logger: false });

  // Endpoint de teste sob /api/v1/admin
  app.register(async (adminScope) => {
    adminScope.addHook('preHandler', adminAuth);

    adminScope.get('/test', async () => ({ status: 'ADMIN_ACCESS_GRANTED' }));
    adminScope.post('/accounts', async () => ({ status: 'ACCOUNT_CREATED' }));
  }, { prefix: '/api/v1/admin' });

  // Endpoint público de comparação
  app.get('/api/v1/public', async () => ({ status: 'PUBLIC_ACCESS' }));

  return app;
}

async function runAdminSecurityTests() {
  console.log('=== TESTES DE SEGURANÇA: ADMIN AUTH GUARD ===\n');

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

  // Cenario 1: ADMIN_MASTER_KEY não configurada no ambiente (Falha Segura / 503)
  {
    delete process.env.ADMIN_MASTER_KEY;
    const app = await buildAdminTestApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/test',
      headers: { 'x-admin-key': 'qualquer_chave' },
    });

    assert(
      'Bloqueio 503 quando ADMIN_MASTER_KEY não configurada',
      res.statusCode === 503 && JSON.parse(res.payload).error === 'Service Unavailable',
      `Esperado 503, recebido ${res.statusCode}`
    );
  }

  // Cenario 2: ADMIN_MASTER_KEY configurada apenas com espaços em branco (Falha Segura / 503)
  {
    process.env.ADMIN_MASTER_KEY = '   ';
    const app = await buildAdminTestApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/test',
      headers: { 'x-admin-key': '   ' },
    });

    assert(
      'Bloqueio 503 quando ADMIN_MASTER_KEY é vazia ou whitespace',
      res.statusCode === 503,
      `Esperado 503, recebido ${res.statusCode}`
    );
  }

  // Cenario 3: Requisição sem nenhuma credencial administrativa (401 Unauthorized)
  const TEST_KEY = 'Secret_MasterKey_Test_2026_xyz!@#';
  process.env.ADMIN_MASTER_KEY = TEST_KEY;

  {
    const app = await buildAdminTestApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/test',
    });

    assert(
      'Bloqueio 401 quando nenhuma credencial é enviada',
      res.statusCode === 401 && JSON.parse(res.payload).message.includes('Credencial administrativa ausente'),
      `Esperado 401, recebido ${res.statusCode}`
    );
  }

  // Cenario 4: Requisição com credencial inválida via header x-admin-key (401 Unauthorized)
  {
    const app = await buildAdminTestApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/test',
      headers: { 'x-admin-key': 'chave_incorreta_totalmente_invalida' },
    });

    assert(
      'Bloqueio 401 com chave incorreta em x-admin-key',
      res.statusCode === 401 && JSON.parse(res.payload).message.includes('Credencial administrativa inválida'),
      `Esperado 401, recebido ${res.statusCode}`
    );
  }

  // Cenario 5: Requisição com credencial correta via header x-admin-key (200 OK)
  {
    const app = await buildAdminTestApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/test',
      headers: { 'x-admin-key': TEST_KEY },
    });

    assert(
      'Acesso 200 concedido com chave correta em x-admin-key',
      res.statusCode === 200 && JSON.parse(res.payload).status === 'ADMIN_ACCESS_GRANTED',
      `Esperado 200, recebido ${res.statusCode}`
    );
  }

  // Cenario 6: Requisição com credencial correta via Authorization Bearer (200 OK)
  {
    const app = await buildAdminTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/accounts',
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });

    assert(
      'Acesso 200 concedido com chave correta em Authorization Bearer',
      res.statusCode === 200 && JSON.parse(res.payload).status === 'ACCOUNT_CREATED',
      `Esperado 200, recebido ${res.statusCode}`
    );
  }

  // Cenario 7: Rotas fora de /admin permanecem acessíveis sem afetar escopo público/tenant
  {
    const app = await buildAdminTestApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public',
    });

    assert(
      'Rotas fora do escopo /admin permanecem desimpedidas',
      res.statusCode === 200 && JSON.parse(res.payload).status === 'PUBLIC_ACCESS',
      `Esperado 200, recebido ${res.statusCode}`
    );
  }

  console.log(`\nRESUMO: ${passedCount}/${totalCount} testes de segurança aprovados.`);
  if (passedCount !== totalCount) {
    throw new Error('Falha nos testes de segurança do adminAuth.');
  }
}

runAdminSecurityTests().catch((err) => {
  console.error('ERRO FATAL NOS TESTES:', err);
  process.exit(1);
});
