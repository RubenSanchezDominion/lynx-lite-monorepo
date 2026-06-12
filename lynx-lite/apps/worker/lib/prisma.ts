import { PrismaClient } from '@prisma/client';

// Singleton de PrismaClient para el worker (independiente del api).
export const prisma = new PrismaClient();
