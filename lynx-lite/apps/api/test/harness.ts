import { ApolloServer } from '@apollo/server';
import { typeDefs } from '../src/graphql/typeDefs.js';
import { resolvers } from '../src/graphql/resolvers/index.js';
import type { ApolloContext, AuthUser } from '../src/context.js';

// Nota: el mock de Prisma se construye con vi.hoisted en cada test (debe existir
// antes de que vi.mock — hoisted al top — ejecute su factory).

export function buildServer() {
  return new ApolloServer<ApolloContext>({ typeDefs, resolvers });
}

// Ejecuta una operación con un contexto de usuario dado (null = sin autenticar).
export async function runOp(
  server: ApolloServer<ApolloContext>,
  query: string,
  opts: { variables?: Record<string, unknown>; user?: AuthUser | null } = {},
) {
  const res = await server.executeOperation(
    { query, variables: opts.variables },
    { contextValue: { user: opts.user ?? null } },
  );
  // executeOperation devuelve singleResult para queries no-incremental.
  if (res.body.kind !== 'single') throw new Error('Respuesta no singular');
  return res.body.singleResult;
}

// Extrae el primer código de error de extensions.
export function errorCode(result: { errors?: ReadonlyArray<{ extensions?: { code?: unknown } }> }): string | undefined {
  return result.errors?.[0]?.extensions?.code as string | undefined;
}
