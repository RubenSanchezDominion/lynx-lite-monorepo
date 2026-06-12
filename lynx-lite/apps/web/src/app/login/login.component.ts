import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="card login">
      <h1>LYNX Lite — Acceso</h1>
      <label>Email
        <input type="email" [(ngModel)]="email" name="email" autocomplete="username" />
      </label>
      <label>Contraseña
        <input type="password" [(ngModel)]="password" name="password" autocomplete="current-password" />
      </label>
      <button (click)="submit()" [disabled]="loading">{{ loading ? 'Entrando…' : 'Entrar' }}</button>
      <p class="error" *ngIf="error">{{ error }}</p>
      <p class="hint">Demo: <code>dominion&#64;lynx.local</code> / <code>dominion</code></p>
    </div>
  `,
})
export class LoginComponent {
  email = 'dominion@lynx.local';
  password = 'dominion';
  loading = false;
  error = '';

  constructor(private auth: AuthService, private router: Router) {}

  async submit(): Promise<void> {
    this.error = '';
    this.loading = true;
    try {
      await this.auth.login(this.email, this.password);
      this.router.navigate(['/prefactura']);
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }
}
