import { FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'crypto';
import { prisma } from '../database/prisma';

// Estende a tipagem do FastifyRequest
declare module 'fastify' {
  interface FastifyRequest {
    tenantId?: string;
    tenantType?: string;
  }
}

export async function tenantContext(request: FastifyRequest, reply: FastifyReply) {
  // Idempotência: se o tenant já foi validado e resolvido em escopo pai, não re-executa queries
  if (request.tenantId) {
    return;
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const apiKey = request.headers['x-api-key'] as string;
  const devTenantId = request.headers['x-tenant-id'] as string;

  // 1. Em produção, exigi obrigatoriamente a x-api-key
  if (isProduction && !apiKey) {
    return reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Acesso negado: x-api-key é obrigatório em produção.',
    });
  }

  // 2. Se houver x-api-key, resolvemos a conta através dela
  if (apiKey) {
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const apiKeyRecord = await prisma.apiKey.findUnique({
      where: { keyHash, isActive: true },
      include: { account: true },
    });

    if (!apiKeyRecord || !apiKeyRecord.account || !apiKeyRecord.account.isActive) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Chave de API inválida ou conta inativa.',
      });
    }

    request.tenantId = apiKeyRecord.account.id;
    request.tenantType = apiKeyRecord.account.type;
    return;
  }

  // 3. Em dev/local, se não houver x-api-key, permite usar o x-tenant-id diretamente
  if (!isProduction && devTenantId) {
    const account = await prisma.account.findUnique({
      where: { id: devTenantId, isActive: true },
    });

    if (!account) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Conta do tenant fornecido não encontrada ou inativa.',
      });
    }

    request.tenantId = account.id;
    request.tenantType = account.type;
    return;
  }

  // 4. Se chegou aqui sem autenticação válida
  return reply.status(401).send({
    statusCode: 401,
    error: 'Unauthorized',
    message: 'Credenciais ausentes ou inválidas.',
  });
}
