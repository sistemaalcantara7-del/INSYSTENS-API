import { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { healthRouter } from './v1/health';
import { adminAuth } from '../middlewares/adminAuth';
import { adminAccountsRouter } from './v1/adminAccounts';
import { adminImportsRouter } from './v1/adminImports';
import { tenantProfileRouter } from './v1/tenantProfile';
import { tenantFiltersRouter } from './v1/tenantFilters';
import { tenantVotersRouter } from './v1/tenantVoters';
import { tenantIntelligenceRouter } from './v1/tenantIntelligence';
import { tenantContext } from '../middlewares/tenantContext';

export async function registerRoutes(fastify: FastifyInstance) {
  // Global /health route
  fastify.get('/health', async (request, reply) => {
    return reply.status(200).send({
      status: 'OK',
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString()
    });
  });

  // Prefix routes under /api/v1
  await fastify.register(async (v1Instance) => {
    await v1Instance.register(healthRouter);
    
    // Admin routes (protegidas com adminAuth guard e rate limit específico)
    // Limite administrativo padrão: 20 req/min por IP (ajustável por RATE_LIMIT_ADMIN_MAX)
    const adminRateLimitMax = Number(process.env.RATE_LIMIT_ADMIN_MAX) || 20;
    // Limite de importação: 5 req/min por IP (ajustável por RATE_LIMIT_IMPORT_MAX)
    const importRateLimitMax = Number(process.env.RATE_LIMIT_IMPORT_MAX) || 5;

    await v1Instance.register(async (adminScope) => {
      adminScope.addHook('preHandler', adminAuth);

      // Aplica rate limit restrito de 20 req/min para o escopo administrativo
      await adminScope.register(rateLimit, {
        max: adminRateLimitMax,
        timeWindow: '1 minute',
      });

      // Endpoint leve de ping para monitoramento do escopo administrativo
      adminScope.get('/ping', async () => ({ status: 'ADMIN_PONG', timestamp: new Date().toISOString() }));

      await adminScope.register(adminAccountsRouter);

      // Subescopo de importações com rate limit estrito adicional de 5 req/min
      await adminScope.register(async (importScope) => {
        await importScope.register(rateLimit, {
          max: importRateLimitMax,
          timeWindow: '1 minute',
        });
        await importScope.register(adminImportsRouter);
      });
    }, { prefix: '/admin' });
    
    // Tenant routes (protegidas por tenantContext com rate limiting específico por tenantId)
    // Limite por tenant padrão: 60 req/min por conta (ajustável por RATE_LIMIT_TENANT_MAX)
    const tenantRateLimitMax = Number(process.env.RATE_LIMIT_TENANT_MAX) || 60;

    await v1Instance.register(async (tenantScope) => {
      // 1. Hook preHandler para validação de tenantContext (injeta request.tenantId)
      tenantScope.addHook('preHandler', tenantContext);

      // 2. Rate limiting por tenant no hook preHandler (executado após a validação do tenantContext)
      // NUNCA utiliza a x-api-key bruta: utiliza apenas request.tenantId já validado no banco
      await tenantScope.register(rateLimit, {
        hook: 'preHandler',
        max: tenantRateLimitMax,
        timeWindow: '1 minute',
        keyGenerator: (request) => {
          if (request.tenantId) {
            return `tenant:${request.tenantId}`;
          }
          return `ip:${request.ip}`;
        },
        errorResponseBuilder: (request, context) => ({
          statusCode: 429,
          error: 'Too Many Requests',
          message: `Limite de requisições do plano do tenant excedido. Tente novamente em ${context.after}.`,
        }),
      });

      await tenantScope.register(tenantProfileRouter);
      await tenantScope.register(tenantFiltersRouter);
      await tenantScope.register(tenantVotersRouter);
      await tenantScope.register(tenantIntelligenceRouter);
    }, { prefix: '/tenant' });
  }, { prefix: '/api/v1' });
}
