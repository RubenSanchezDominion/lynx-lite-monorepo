import { PrismaClient } from '@prisma/client';

// El cliente Prisma se expone como un Proxy inyectable: por defecto resuelve a un
// PrismaClient real (lazy), pero el modo demo (src/demo.ts) puede sustituirlo por
// una implementación en memoria vía setPrisma() — sin tocar los resolvers, que
// siguen haciendo `import { prisma }`.
let instance: PrismaClient | null = null;

export function setPrisma(client: unknown): void {
  instance = client as PrismaClient;
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    if (!instance) instance = new PrismaClient();
    // @ts-expect-error acceso dinámico a los delegates de Prisma
    return instance[prop];
  },
});
