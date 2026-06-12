import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';

const JWT_SECRET = process.env.JWT_SECRET ?? 'cambia-esto-en-produccion';
const JWT_EXPIRY = process.env.JWT_EXPIRY ?? '8h';
const SALT_ROUNDS = 10;

export interface JwtPayload {
  sub: string; // userId
  role: UserRole;
  clientId?: string;
  supplyId?: string;
  iat: number;
  exp: number;
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signJwt(payload: {
  sub: string;
  role: UserRole;
  clientId?: string | null;
  supplyId?: string | null;
}): string {
  // Omitimos claves null para que el payload solo lleve lo aplicable al rol.
  const claims: Record<string, unknown> = { sub: payload.sub, role: payload.role };
  if (payload.clientId) claims.clientId = payload.clientId;
  if (payload.supplyId) claims.supplyId = payload.supplyId;

  const options: jwt.SignOptions = { expiresIn: JWT_EXPIRY as jwt.SignOptions['expiresIn'] };
  return jwt.sign(claims, JWT_SECRET, options);
}

// Devuelve el payload decodificado o null si el token es inválido/expirado.
export function verifyJwt(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}
