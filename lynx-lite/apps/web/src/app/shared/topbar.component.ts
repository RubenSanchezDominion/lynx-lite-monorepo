import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../services/auth.service';

// Cabecera compartida entre pantallas: marca animada, navegación (Pre-factura / Optimización),
// usuario y salir, más un título de sección grande. Resalta la ruta activa.
@Component({
  selector: 'app-topbar',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive],
  template: `
    <header class="navbar">
      <span class="brand"><span class="bolt">⚡</span> LYNX&nbsp;Lite</span>
      <nav class="nav">
        <a routerLink="/prefactura" routerLinkActive="active">Pre-factura</a>
        <a routerLink="/optimizacion" routerLinkActive="active">Optimización</a>
        <a routerLink="/alertas" routerLinkActive="active">Alertas</a>
        <a routerLink="/kpi" routerLinkActive="active">KPI</a>
        <a routerLink="/huella" routerLinkActive="active">Huella</a>
        <a routerLink="/solar" routerLinkActive="active">Solar</a>
      </nav>
      <span class="spacer"></span>
      <span class="user" *ngIf="auth.user as u">{{ u.email }} · {{ u.role }}</span>
      <button class="logout" (click)="logout()">Salir</button>
    </header>

    <div class="page-title" *ngIf="section">
      <h1>{{ section }}</h1>
    </div>
  `,
  styles: [
    `
      .navbar {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 12px 24px;
        color: #fff;
        background: rgba(28, 39, 51, 0.55);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
      }

      .brand { font-weight: 700; font-size: 1.05rem; letter-spacing: 0.3px; display: flex; align-items: center; gap: 6px; }
      .bolt { display: inline-block; animation: bolt 2.2s ease-in-out infinite; transform-origin: center; }

      .nav { display: flex; gap: 4px; margin-left: 12px; }
      .nav a {
        position: relative;
        padding: 6px 12px;
        text-decoration: none;
        color: rgba(255, 255, 255, 0.78);
        font-size: 0.92rem;
        transition: color 0.2s ease;
      }
      .nav a::after {
        content: '';
        position: absolute;
        left: 12px;
        right: 12px;
        bottom: 2px;
        height: 2px;
        background: #fff;
        border-radius: 2px;
        transform: scaleX(0);
        transform-origin: left;
        transition: transform 0.25s ease;
      }
      .nav a:hover { color: #fff; }
      .nav a:hover::after { transform: scaleX(1); }
      .nav a.active { color: #fff; font-weight: 600; }
      .nav a.active::after { transform: scaleX(1); }

      .spacer { flex: 1; }
      .user { color: rgba(255, 255, 255, 0.82); font-size: 0.85rem; }
      .logout {
        background: rgba(255, 255, 255, 0.14);
        color: #fff;
        border: 0;
        border-radius: 6px;
        padding: 6px 12px;
        font-size: 0.9rem;
        cursor: pointer;
        transition: background 0.2s ease, transform 0.1s ease;
      }
      .logout:hover { background: rgba(255, 255, 255, 0.26); }
      .logout:active { transform: translateY(1px); }

      .page-title { max-width: 960px; margin: 20px auto 0; padding: 0 4px; }
      .page-title h1 {
        font-size: 1.7rem;
        margin: 0;
        color: #fff;
        text-shadow: 0 1px 8px rgba(0, 0, 0, 0.35);
        animation: titleIn 0.35s ease both;
      }

      @keyframes bolt {
        0%, 100% { transform: scale(1) rotate(0); opacity: 1; }
        50% { transform: scale(1.25) rotate(-8deg); opacity: 0.75; }
      }
      @keyframes titleIn {
        from { opacity: 0; transform: translateY(-6px); }
        to { opacity: 1; transform: translateY(0); }
      }

      @media (prefers-reduced-motion: reduce) {
        .bolt, .page-title h1 { animation: none; }
      }
    `,
  ],
})
export class TopbarComponent {
  // Título de sección mostrado en grande bajo la barra (p. ej. "Pre-factura (M01)").
  @Input() section = '';

  constructor(public auth: AuthService, private router: Router) {}

  logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
