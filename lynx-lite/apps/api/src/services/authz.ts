import type { AuthUser } from '../context.js';
import { unauthenticated, forbidden } from '../lib/errors.js';

// Exige usuario autenticado; lo devuelve estrechado a no-null.
export function requireAuth(user: AuthUser | null): AuthUser {
  if (!user) throw unauthenticated();
  return user;
}

// Verifica que el usuario puede acceder a un supply concreto, dado el clientId
// dueño del supply. Reglas SPECS §2.2:
//  - DOMINION: cualquiera.
//  - ADMIN: solo supplies de su clientId.
//  - GESTOR/USUARIO: solo su supplyId.
export function assertSupplyAccess(
  user: AuthUser,
  supply: { id: string; clientId: string },
): void {
  switch (user.role) {
    case 'DOMINION':
      return;
    case 'ADMIN':
      if (user.clientId === supply.clientId) return;
      break;
    case 'GESTOR':
    case 'USUARIO':
      if (user.supplyId === supply.id) return;
      break;
  }
  throw forbidden();
}

// Acciones de escritura sobre pre-facturas: USUARIO nunca puede (§2.2).
export function assertCanWritePreInvoice(user: AuthUser): void {
  if (user.role === 'USUARIO') throw forbidden();
}
