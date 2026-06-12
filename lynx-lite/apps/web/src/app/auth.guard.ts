import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

// Guard simple: si no hay token, redirige a /login.
export const authGuard: CanActivateFn = () => {
  const router = inject(Router);
  if (localStorage.getItem('token')) return true;
  router.navigate(['/login']);
  return false;
};
