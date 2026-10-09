import fastify from 'fastify';
import dotenv from 'dotenv';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { registerRoutes } from './routes';

dotenv.config();

// Resolução segura de trustProxy:
// - Padrão seguro: false (não confia em headers forjados sem proxy verificado)
// - Se 'true': true
// - Se numérico (ex: '1'): interpreta como número de saltos confiáveis (hop count)
// - Se lista/string (ex: '127.0.0.1,10.0.0.0/8'): array ou string de IPs/subredes confiáveis
function resolveTrustProxy(rawVal?: string): boolean | number | string | string[] {
  if (!rawVal || rawVal.trim() === '' || rawVal.trim().toLowerCase() === 'false') {
    return false;
  }
  const trimmed = rawVal.trim();
  if (trimmed.toLowerCase() === 'true') {
    return true;
  }
  const numericVal = Number(trimmed);
  if (!Number.isNaN(numericVal)) {
    return numericVal;
  }
  if (trimmed.includes(',')) {
    return trimmed.split(',').map((ip) => ip.trim()).filter(Boolean);
  }
  return trimmed;
}

const app = fastify({
  trustProxy: resolveTrustProxy(process.env.TRUST_PROXY),
  logger: {
    transport: process.env.NODE_ENV === 'development' ? {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    } : undefined,
  },
});

// 1. Configuração de CORS Seguro
// Origens permitidas explícitas via CORS_ORIGIN (ex: "http://localhost:3000,https://app.mandatopro.com.br")
const rawCorsOrigin = process.env.CORS_ORIGIN?.trim();
const allowedOrigins = rawCorsOrigin
  ? rawCorsOrigin.split(',').map((o) => o.trim()).filter(Boolean)
  : ['http://localhost:3000'];

app.register(cors, {
  origin: (origin, cb) => {
    // Permite chamadas sem cabeçalho Origin (ex: server-to-server, curl, ferramentas locais)
    if (!origin) {
      cb(null, true);
      return;
    }

    if (allowedOrigins.includes(origin)) {
      cb(null, true);
      return;
    }

    cb(new Error(`Acesso bloqueado pela política de CORS: Origem '${origin}' não autorizada.`), false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-api-key',
    'x-tenant-id',
    'x-admin-key',
  ],
  credentials: true,
});

// 2. Configuração de Rate Limiting Global (por IP no hook onRequest)
// Limite inicial padrão: 120 requisições/minuto por IP (ajustável por RATE_LIMIT_GLOBAL_MAX)
// Protege toda a superfície HTTP antes mesmo de autenticação ou resolução de rotas
const globalRateLimitMax = Number(process.env.RATE_LIMIT_GLOBAL_MAX) || 120;

app.register(rateLimit, {
  global: true,
  max: globalRateLimitMax,
  timeWindow: '1 minute',
  keyGenerator: (request) => request.ip,
  errorResponseBuilder: (request, context) => ({
    statusCode: 429,
    error: 'Too Many Requests',
    message: `Limite de requisições excedido. Tente novamente em ${context.after}.`,
  }),
});

// 3. Registrar rotas
app.register(registerRoutes);

export { app };
