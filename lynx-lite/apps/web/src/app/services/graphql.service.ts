import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
}

// URL del API en modo memoria (ver apps/api `npm run demo`).
const API_URL = 'http://localhost:4000/graphql';

@Injectable({ providedIn: 'root' })
export class GraphqlService {
  constructor(private http: HttpClient) {}

  // Ejecuta una operación GraphQL adjuntando el token si existe.
  async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await firstValueFrom(
      this.http.post<GraphQLResponse<T>>(API_URL, { query, variables }, { headers }),
    );

    if (res.errors?.length) {
      const e = res.errors[0];
      const code = e.extensions?.code ? ` (${e.extensions.code})` : '';
      throw new Error(e.message + code);
    }
    return res.data as T;
  }
}
