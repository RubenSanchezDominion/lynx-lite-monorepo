import { Injectable } from '@angular/core';
import { GraphqlService } from './graphql.service';

export interface AuthUser {
  email: string;
  role: string;
}

const LOGIN = `mutation($e: String!, $p: String!) {
  login(input: { email: $e, password: $p }) { token user { email role } }
}`;

@Injectable({ providedIn: 'root' })
export class AuthService {
  constructor(private gql: GraphqlService) {}

  async login(email: string, password: string): Promise<void> {
    const data = await this.gql.request<{ login: { token: string; user: AuthUser } }>(LOGIN, {
      e: email,
      p: password,
    });
    localStorage.setItem('token', data.login.token);
    localStorage.setItem('user', JSON.stringify(data.login.user));
  }

  logout(): void {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  }

  get user(): AuthUser | null {
    const raw = localStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  }

  get isLoggedIn(): boolean {
    return !!localStorage.getItem('token');
  }
}
