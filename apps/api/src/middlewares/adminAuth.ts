import { FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'crypto';

/**
 * Guard de autenticação para endpoints sob /api/v1/admin/*.
 *
 * Exige a passagem do header 'x-admin-key' (ou 'authorization: Bearer <key>').
 * Compara o valor fornecido com a variável de ambiente ADMIN_MASTER_KEY usando
 * timingSafeEqual (hashes SHA-256 de tamanho constante) para prevenir ataques de temporização (timing attacks).
 *
 * Falha de forma estritamente segura: se ADMIN_MASTER_KEY não estiver definida no ambiente
 * ou for uma string vazia/em branco, qualquer acesso administrativo é sumariamente bloqueado (503 Service Unavailable).
 */
export async function adminAuth(request: FastifyRequest, reply: FastifyReply) {
  const configuredMasterKey = process.env.ADMIN_MASTER_KEY?.trim();

  // 1. Falha segura: sem chave mestra configurada no ambiente, o acesso administrativo é permanentemente fechado
  if (!configuredMasterKey) {
    request.log.error('Acesso administrativo bloqueado: ADMIN_MASTER_KEY não configurada no ambiente.');
    return reply.status(503).send({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Acesso administrativo temporariamente indisponível.',
    });
  }

  // 2. Extração da credencial do request (suporta 'x-admin-key' ou 'Authorization: Bearer <key>')
  const headerKey = request.headers['x-admin-key'] as string | undefined;
  const authHeader = request.headers['authorization'] as string | undefined;

  let providedKey = headerKey?.trim();
  if (!providedKey && authHeader?.startsWith('Bearer ')) {
    providedKey = authHeader.substring(7).trim();
  }

  if (!providedKey) {
    return reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Acesso negado: Credencial administrativa ausente.',
    });
  }

  // 3. Comparação em tempo constante usando SHA-256 digests
  const hashProvided = crypto.createHash('sha256').update(providedKey).digest();
  const hashExpected = crypto.createHash('sha256').update(configuredMasterKey).digest();

  const isMatch = crypto.timingSafeEqual(hashProvided, hashExpected);

  if (!isMatch) {
    return reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Acesso negado: Credencial administrativa inválida.',
    });
  }
}
