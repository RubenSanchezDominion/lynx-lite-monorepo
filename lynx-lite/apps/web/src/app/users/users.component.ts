import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TopbarComponent } from '../shared/topbar.component';

interface UserRow {
  name: string;
  email: string;
  role: 'DOMINION' | 'ADMIN' | 'GESTOR' | 'USUARIO';
  client: string | null;
  supply: string | null;
  status: 'ACTIVE' | 'PENDING' | 'INACTIVE';
  lastLogin: string;
}

// DEMO — Gestión de usuarios (Cliente / Supply / roles). Datos hardcodeados, sin backend.
@Component({
  selector: 'app-users',
  standalone: true,
  imports: [CommonModule, FormsModule, TopbarComponent],
  template: `
    <app-topbar section="Usuarios" />

    <div class="card">
      <span class="demo-badge">DEMO · datos de ejemplo</span>
      <p class="muted intro">Gestión de usuarios y su asignación a cliente y punto de suministro. Esta pantalla es una maqueta: el alta y la edición no hacen nada.</p>
      <div class="toolbar">
        <input class="search" type="text" placeholder="Buscar por nombre o email…" [(ngModel)]="q" name="q" />
        <label class="filter">Rol
          <select [(ngModel)]="roleFilter" name="role">
            <option value="">Todos</option>
            <option *ngFor="let r of roleKeys" [value]="r">{{ roleLabel[r] }}</option>
          </select>
        </label>
        <span class="spacer"></span>
        <button class="add" (click)="noop()">＋ Nuevo usuario</button>
      </div>
    </div>

    <div class="card">
      <h3 class="t">Usuarios <span class="muted">({{ visible().length }})</span></h3>
      <table>
        <thead>
          <tr><th>Usuario</th><th>Rol</th><th>Cliente</th><th>Suministro</th><th>Estado</th><th>Último acceso</th><th></th></tr>
        </thead>
        <tbody>
          <tr *ngFor="let u of visible()">
            <td>
              <div class="ucell">
                <span class="avatar">{{ initials(u.name) }}</span>
                <div><span class="uname">{{ u.name }}</span><span class="umail">{{ u.email }}</span></div>
              </div>
            </td>
            <td><span class="role" [class]="'r-' + u.role">{{ roleLabel[u.role] }}</span></td>
            <td>{{ u.client || '—' }}</td>
            <td class="mono">{{ u.supply || '—' }}</td>
            <td><span class="pill" [class]="'st-' + u.status">{{ statusLabel[u.status] }}</span></td>
            <td>{{ u.lastLogin }}</td>
            <td class="acts"><button class="lnk" (click)="noop()">Editar</button><button class="lnk danger" (click)="noop()">Desactivar</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  `,
  styles: [
    `
      .t { margin: 0 0 14px; font-size: 1rem; }
      .muted { color: var(--muted); }
      .intro { margin: 8px 0 14px; font-size: 0.9rem; }
      .demo-badge {
        display: inline-block; background: #fef6dd; color: #8a6d00; border: 1px solid #f4d77a;
        border-radius: 999px; padding: 3px 12px; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.3px;
      }
      .toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      .search { flex: 1; min-width: 220px; max-width: 360px; }
      .filter { max-width: 200px; }
      .spacer { flex: 1; }
      .add { background: #15539e; color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; font-size: 0.88rem; cursor: pointer; }
      .add:hover { background: #11457f; }
      .mono { font-family: ui-monospace, monospace; font-size: 0.82rem; }

      table { width: 100%; border-collapse: collapse; }
      .ucell { display: flex; align-items: center; gap: 10px; }
      .avatar { width: 32px; height: 32px; border-radius: 50%; background: #dce6f5; color: #15539e; font-weight: 700; font-size: 0.78rem; display: flex; align-items: center; justify-content: center; }
      .uname { display: block; font-weight: 600; font-size: 0.9rem; }
      .umail { display: block; font-size: 0.78rem; color: var(--muted); }

      .role { font-size: 0.74rem; font-weight: 700; padding: 2px 10px; border-radius: 999px; }
      .r-DOMINION { background: #efe3fb; color: #6b30a8; }
      .r-ADMIN { background: #fde8e3; color: #b23a1a; }
      .r-GESTOR { background: #e3eefd; color: #15539e; }
      .r-USUARIO { background: #eef0f2; color: #5a6573; }

      .pill { font-size: 0.74rem; font-weight: 600; padding: 2px 10px; border-radius: 999px; }
      .st-ACTIVE { background: #e3f6ec; color: #1f7a4d; }
      .st-PENDING { background: #fef6dd; color: #8a6d00; }
      .st-INACTIVE { background: #f0f0f0; color: #777; }

      .acts { white-space: nowrap; }
      .lnk { background: none; border: 0; color: #15539e; cursor: pointer; font-size: 0.82rem; padding: 4px 6px; }
      .lnk:hover { text-decoration: underline; }
      .lnk.danger { color: #c0392b; }
    `,
  ],
})
export class UsersComponent {
  q = '';
  roleFilter = '';
  roleKeys: UserRow['role'][] = ['DOMINION', 'ADMIN', 'GESTOR', 'USUARIO'];
  roleLabel: Record<UserRow['role'], string> = {
    DOMINION: 'Dominion',
    ADMIN: 'Administrador',
    GESTOR: 'Gestor',
    USUARIO: 'Usuario',
  };
  statusLabel: Record<UserRow['status'], string> = {
    ACTIVE: 'Activo',
    PENDING: 'Pendiente',
    INACTIVE: 'Inactivo',
  };

  users: UserRow[] = [
    { name: 'Lynx Operaciones', email: 'ops@lynx.energy', role: 'DOMINION', client: null, supply: null, status: 'ACTIVE', lastLogin: 'hoy 08:12' },
    { name: 'Marta Ibáñez', email: 'marta@acerosnorte.es', role: 'ADMIN', client: 'Aceros del Norte S.L.', supply: null, status: 'ACTIVE', lastLogin: 'hoy 07:45' },
    { name: 'Javier Soto', email: 'javier@acerosnorte.es', role: 'GESTOR', client: 'Aceros del Norte S.L.', supply: 'ES0031…0001JN', status: 'ACTIVE', lastLogin: 'ayer 18:20' },
    { name: 'Lucía Pérez', email: 'lucia@panaderiacentro.es', role: 'ADMIN', client: 'Panadería Centro', supply: null, status: 'ACTIVE', lastLogin: 'hace 3 días' },
    { name: 'Pedro Gómez', email: 'pedro@panaderiacentro.es', role: 'USUARIO', client: 'Panadería Centro', supply: 'ES0031…0002JN', status: 'ACTIVE', lastLogin: 'hace 5 días' },
    { name: 'Ana Ruiz', email: 'ana@logisticasur.es', role: 'ADMIN', client: 'Logística Sur S.A.', supply: null, status: 'PENDING', lastLogin: '—' },
    { name: 'Carlos Vidal', email: 'carlos@talleresruiz.es', role: 'USUARIO', client: 'Talleres Mecánicos Ruiz', supply: 'ES0031…0004JN', status: 'INACTIVE', lastLogin: 'hace 2 meses' },
  ];

  visible(): UserRow[] {
    const q = this.q.trim().toLowerCase();
    return this.users.filter(
      u =>
        (!this.roleFilter || u.role === this.roleFilter) &&
        (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)),
    );
  }

  initials(name: string): string {
    return name.split(' ').slice(0, 2).map(p => p[0]).join('').toUpperCase();
  }

  noop(): void {
    // DEMO: las acciones no hacen nada.
  }
}
