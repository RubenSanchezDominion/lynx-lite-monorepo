import type { ApolloContext } from '../../context.js';
import { prisma } from '../../lib/prisma.js';
import { gqlError, forbidden } from '../../lib/errors.js';
import { hashPassword, verifyPassword, signJwt } from '../../services/auth.js';
import { requireAuth } from '../../services/authz.js';
import type { UserRole } from '@prisma/client';

function toGqlUser(u: {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  clientId: string | null;
  supplyId: string | null;
  createdAt: Date;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    clientId: u.clientId,
    supplyId: u.supplyId,
    createdAt: u.createdAt.toISOString(),
  };
}

// ─── Reglas de creación de usuarios (SPECS §2.2) ───────────────────────────────
function assertCanCreate(actor: { role: UserRole; clientId?: string; supplyId?: string },
  input: { role: UserRole; clientId?: string | null; supplyId?: string | null }) {
  switch (actor.role) {
    case 'DOMINION':
      return; // puede crear cualquier rol
    case 'ADMIN':
      // ADMIN/GESTOR/USUARIO dentro de su cliente
      if (input.role === 'DOMINION') throw forbidden();
      if (input.clientId !== actor.clientId) throw forbidden();
      return;
    case 'GESTOR':
      // solo USUARIO de su supply
      if (input.role !== 'USUARIO') throw forbidden();
      if (input.supplyId !== actor.supplyId) throw forbidden();
      return;
    default:
      throw forbidden(); // USUARIO no crea usuarios
  }
}

export const authResolvers = {
  Query: {
    me: async (_p: unknown, _a: unknown, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const user = await prisma.user.findUnique({ where: { id: actor.id } });
      if (!user) throw gqlError('USER_NOT_FOUND');
      return toGqlUser(user);
    },

    users: async (
      _p: unknown,
      args: { clientId?: string; supplyId?: string },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);

      // Alcance de visibilidad por rol.
      let where: { clientId?: string; supplyId?: string } = {};
      switch (actor.role) {
        case 'DOMINION':
          where = { clientId: args.clientId, supplyId: args.supplyId };
          break;
        case 'ADMIN':
          where = { clientId: actor.clientId };
          break;
        case 'GESTOR':
          where = { supplyId: actor.supplyId };
          break;
        default:
          throw forbidden(); // USUARIO no ve usuarios
      }
      const users = await prisma.user.findMany({ where });
      return users.map(toGqlUser);
    },

    user: async (_p: unknown, args: { id: string }, ctx: ApolloContext) => {
      requireAuth(ctx.user);
      const user = await prisma.user.findUnique({ where: { id: args.id } });
      return user ? toGqlUser(user) : null;
    },
  },

  Mutation: {
    login: async (_p: unknown, args: { input: { email: string; password: string } }) => {
      const { email, password } = args.input;
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) throw gqlError('UNAUTHENTICATED', 'Credenciales inválidas');

      const ok = await verifyPassword(password, user.passwordHash);
      if (!ok) throw gqlError('UNAUTHENTICATED', 'Credenciales inválidas');

      const token = signJwt({
        sub: user.id,
        role: user.role,
        clientId: user.clientId,
        supplyId: user.supplyId,
      });
      return { token, user: toGqlUser(user) };
    },

    createUser: async (
      _p: unknown,
      args: {
        input: {
          email: string;
          password: string;
          name: string;
          role: UserRole;
          clientId?: string | null;
          supplyId?: string | null;
        };
      },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);
      const { input } = args;

      assertCanCreate(actor, input);

      // Validación de invariantes de integridad (§2.3).
      if (input.role === 'GESTOR' || input.role === 'USUARIO') {
        if (!input.clientId || !input.supplyId) throw gqlError('SUPPLY_SCOPE_MISMATCH');
        const supply = await prisma.supply.findUnique({ where: { id: input.supplyId } });
        if (!supply || supply.clientId !== input.clientId) throw gqlError('SUPPLY_SCOPE_MISMATCH');
      }

      const existing = await prisma.user.findUnique({ where: { email: input.email } });
      if (existing) throw gqlError('EMAIL_ALREADY_EXISTS');

      const user = await prisma.user.create({
        data: {
          email: input.email,
          passwordHash: await hashPassword(input.password),
          name: input.name,
          role: input.role,
          clientId: input.clientId ?? null,
          supplyId: input.supplyId ?? null,
        },
      });
      return toGqlUser(user);
    },

    updateUser: async (
      _p: unknown,
      args: { id: string; input: { name?: string; password?: string; role?: UserRole } },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);

      const target = await prisma.user.findUnique({ where: { id: args.id } });
      if (!target) throw gqlError('USER_NOT_FOUND');

      // Solo DOMINION (cualquiera) y ADMIN (de su cliente) modifican usuarios (§2.2).
      if (actor.role === 'ADMIN') {
        if (target.clientId !== actor.clientId) throw forbidden();
      } else if (actor.role !== 'DOMINION') {
        throw forbidden();
      }

      const data: { name?: string; passwordHash?: string; role?: UserRole } = {};
      if (args.input.name !== undefined) data.name = args.input.name;
      if (args.input.role !== undefined) data.role = args.input.role;
      if (args.input.password !== undefined) {
        data.passwordHash = await hashPassword(args.input.password);
      }

      const updated = await prisma.user.update({ where: { id: args.id }, data });
      return toGqlUser(updated);
    },

    deleteUser: async (_p: unknown, args: { id: string }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);

      const target = await prisma.user.findUnique({ where: { id: args.id } });
      if (!target) throw gqlError('USER_NOT_FOUND');

      // DOMINION: cualquiera. ADMIN: del cliente. GESTOR: solo USUARIO de su supply (§2.2).
      switch (actor.role) {
        case 'DOMINION':
          break;
        case 'ADMIN':
          if (target.clientId !== actor.clientId) throw forbidden();
          break;
        case 'GESTOR':
          if (target.role !== 'USUARIO' || target.supplyId !== actor.supplyId) throw forbidden();
          break;
        default:
          throw forbidden();
      }

      await prisma.user.delete({ where: { id: args.id } });
      return true;
    },
  },
};
