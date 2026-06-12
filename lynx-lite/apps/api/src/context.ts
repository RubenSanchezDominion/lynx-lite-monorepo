import type { IncomingMessage } from 'http';
import { verifyJwt, type JwtPayload } from './services/auth.js';

export interface AuthUser {
  id: string;
  role: JwtPayload['role'];
  clientId?: string;
  supplyId?: string;
}

export interface ApolloContext {
  user: AuthUser | null;
}

// Construye el contexto Apollo a partir del header Authorization.
// El usuario es null si no hay token o es inválido/expirado; los resolvers
// que requieran autenticación elevan UNAUTHENTICATED.
export async function buildContext({ req }: { req: IncomingMessage }): Promise<ApolloContext> {
  const header = req.headers['authorization'];
  if (!header || Array.isArray(header)) return { user: null };

  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return { user: null };

  const payload = verifyJwt(token);
  if (!payload) return { user: null };

  return {
    user: {
      id: payload.sub,
      role: payload.role,
      clientId: payload.clientId,
      supplyId: payload.supplyId,
    },
  };
}
