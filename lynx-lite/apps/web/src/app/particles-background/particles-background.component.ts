import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { tsParticles, type Container, type ISourceOptions } from '@tsparticles/engine';
import { loadSlim } from '@tsparticles/slim';

/**
 * Fondo global compuesto por tres capas (de atrás hacia delante):
 *  1. Canvas del cometa (#cometa): fondo oscuro + un cometa que cruza cada 30 s.
 *  2. Canvas de tsParticles (transparente): campo de partículas blancas.
 *  3. Contenido de la app.
 *
 * Imán (sobre las partículas, hecho a mano):
 *  - Mantener pulsado atrae hacia el cursor las partículas dentro de un radio.
 *  - El radio crece un poco cada 100 ms mientras se mantiene pulsado.
 *  - Al soltar, las partículas regresan a la posición que tenían al pulsar.
 *
 * Cometa (capa de atrás, no reacciona a nada):
 *  - Cada 30 s cruza una partícula grande y brillante con un rastro corto.
 *  - Cae en diagonal (más horizontal que vertical) de un lado al otro.
 */
const BG_COLOR = '#1c2733';

@Component({
  selector: 'app-particles-background',
  standalone: true,
  template: `
    <canvas #cometa class="layer comet-layer"></canvas>
    <div id="tsparticles" class="layer particles-layer"></div>
  `,
  styles: [
    `
      .layer {
        position: fixed;
        inset: 0;
      }
      .comet-layer {
        z-index: -2;
        background-color: ${BG_COLOR};
      }
      .particles-layer {
        z-index: -1;
      }
    `,
  ],
})
export class ParticlesBackgroundComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('cometa', { static: true }) private cometaRef!: ElementRef<HTMLCanvasElement>;

  private container?: Container;

  // --- Estado del imán (coordenadas CSS; se reescalan a px de canvas por pixelRatio) ---
  private readonly mouse = { x: 0, y: 0 };
  private pressed = false;
  private radiusCss = 0;
  private readonly baseRadiusCss = 140;
  private readonly stepCss = 5; // cuánto crece el radio cada tick
  private readonly maxRadiusCss = 700;
  private readonly pullFactor = 0.06; // 0..1, cuán rápido acuden al cursor
  private readonly returnFactor = 0.12; // 0..1, cuán rápido regresan al soltar
  private readonly returnMs = 700; // duración del retorno antes de devolver el control al motor
  private returnUntil = 0;
  private growTimer?: ReturnType<typeof setInterval>;
  private rafId?: number;
  private readonly homes = new Map<object, { x: number; y: number }>();

  // --- Estado del cometa ---
  private ctx?: CanvasRenderingContext2D;
  private cometRaf?: number;
  private cometTimer?: ReturnType<typeof setInterval>;
  private comet?: { x: number; y: number; vx: number; vy: number };

  constructor(private readonly zone: NgZone) {}

  async ngOnInit(): Promise<void> {
    await loadSlim(tsParticles);
    this.container = await tsParticles.load({ id: 'tsparticles', options: this.options });
  }

  ngAfterViewInit(): void {
    const canvas = this.cometaRef.nativeElement;
    this.ctx = canvas.getContext('2d') ?? undefined;
    this.resizeComet();

    this.zone.runOutsideAngular(() => {
      // Primer cometa a los pocos segundos y luego cada 30 s.
      setTimeout(() => this.spawnComet(), 3000);
      this.cometTimer = setInterval(() => this.spawnComet(), 30000);
      this.cometRaf = requestAnimationFrame(() => this.cometLoop());
    });
  }

  ngOnDestroy(): void {
    clearInterval(this.growTimer);
    clearInterval(this.cometTimer);
    if (this.rafId !== undefined) {
      cancelAnimationFrame(this.rafId);
    }
    if (this.cometRaf !== undefined) {
      cancelAnimationFrame(this.cometRaf);
    }
    this.container?.destroy();
  }

  @HostListener('window:resize')
  onResize(): void {
    this.resizeComet();
  }

  // ====================== IMÁN (capa de partículas) ======================

  @HostListener('window:pointermove', ['$event'])
  onPointerMove(e: PointerEvent): void {
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
  }

  @HostListener('window:pointerdown', ['$event'])
  onPointerDown(e: PointerEvent): void {
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
    this.pressed = true;
    this.radiusCss = this.baseRadiusCss;
    this.snapshotHomes();

    clearInterval(this.growTimer);
    // El radio crece un poquito cada 100 ms mientras se mantiene pulsado.
    this.growTimer = setInterval(() => {
      this.radiusCss = Math.min(this.maxRadiusCss, this.radiusCss + this.stepCss);
    }, 100);

    this.ensureLoop();
  }

  @HostListener('window:pointerup')
  @HostListener('window:pointercancel')
  onPointerUp(): void {
    this.pressed = false;
    clearInterval(this.growTimer);
    this.growTimer = undefined;
    // Retorno acotado en el tiempo; al terminar, el control vuelve al motor.
    this.returnUntil = performance.now() + this.returnMs;
  }

  /** Guarda la posición actual de cada partícula como destino de retorno. */
  private snapshotHomes(): void {
    this.homes.clear();
    for (const p of this.particles()) {
      this.homes.set(p, { x: p.position.x, y: p.position.y });
    }
  }

  /** Arranca el bucle del imán (fuera de Angular para no disparar change detection). */
  private ensureLoop(): void {
    if (this.rafId !== undefined) {
      return;
    }
    this.zone.runOutsideAngular(() => {
      const tick = (): void => {
        const keepGoing = this.step();
        this.rafId = keepGoing ? requestAnimationFrame(tick) : undefined;
      };
      this.rafId = requestAnimationFrame(tick);
    });
  }

  /** Un fotograma del imán. Devuelve true si hay que seguir animando. */
  private step(): boolean {
    const container = this.container;
    if (!container) {
      return false;
    }
    const pr = container.retina.pixelRatio;
    const mx = this.mouse.x * pr;
    const my = this.mouse.y * pr;
    const particles = this.particles();

    if (this.pressed) {
      const r = this.radiusCss * pr;
      const r2 = r * r;
      for (const p of particles) {
        const dx = mx - p.position.x;
        const dy = my - p.position.y;
        if (dx * dx + dy * dy < r2) {
          p.position.x += dx * this.pullFactor;
          p.position.y += dy * this.pullFactor;
        }
      }
      return true;
    }

    // Soltado: devolver cada partícula hacia su posición guardada durante un
    // tiempo acotado. Al expirar, soltamos el control y el motor retoma la deriva.
    if (performance.now() >= this.returnUntil) {
      this.homes.clear();
      return false;
    }
    for (const p of particles) {
      const home = this.homes.get(p);
      if (!home) {
        continue;
      }
      p.position.x += (home.x - p.position.x) * this.returnFactor;
      p.position.y += (home.y - p.position.y) * this.returnFactor;
    }
    return true;
  }

  /** Lista de partículas del contenedor (API interna acotada por cast). */
  private particles(): Array<{ position: { x: number; y: number } }> {
    const store = this.container?.particles as unknown as {
      filter?: (cb: () => boolean) => Array<{ position: { x: number; y: number } }>;
    };
    return store?.filter?.(() => true) ?? [];
  }

  // ====================== COMETA (capa de atrás) ======================

  private resizeComet(): void {
    const canvas = this.cometaRef.nativeElement;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    // Pintamos el fondo de golpe para evitar destello inicial transparente.
    if (this.ctx) {
      this.ctx.fillStyle = BG_COLOR;
      this.ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  /** Lanza un cometa desde un lado, cayendo en diagonal (más horizontal que vertical). */
  private spawnComet(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const fromLeft = Math.random() < 0.5;
    const speed = 7 + Math.random() * 4; // velocidad horizontal (px/frame)
    const vx = fromLeft ? speed : -speed;
    const vy = speed * (0.3 + Math.random() * 0.25); // siempre cae, pero poco

    this.comet = {
      x: fromLeft ? -40 : w + 40,
      y: Math.random() * h * 0.35, // arranca en la parte alta para tener recorrido
      vx,
      vy,
    };
  }

  private cometLoop(): void {
    const ctx = this.ctx;
    if (ctx) {
      const w = ctx.canvas.width;
      const h = ctx.canvas.height;

      // Limpiamos por completo cada frame (fondo opaco) → sin rastros fantasma.
      ctx.fillStyle = BG_COLOR;
      ctx.fillRect(0, 0, w, h);

      const c = this.comet;
      if (c) {
        c.x += c.vx;
        c.y += c.vy;
        this.drawComet(ctx, c);
        if (c.x < -60 || c.x > w + 60 || c.y > h + 60) {
          this.comet = undefined;
        }
      }
    }
    this.cometRaf = requestAnimationFrame(() => this.cometLoop());
  }

  /** Dibuja el cometa: rastro (degradado detrás) + cabeza brillante. */
  private drawComet(
    ctx: CanvasRenderingContext2D,
    c: { x: number; y: number; vx: number; vy: number },
  ): void {
    const len = Math.hypot(c.vx, c.vy) || 1;
    const ux = c.vx / len;
    const uy = c.vy / len;
    const tail = 130; // longitud del rastro en px
    const tailX = c.x - ux * tail;
    const tailY = c.y - uy * tail;

    ctx.save();
    // Todo el cometa (rastro + cabeza) se dibuja semitransparente.
    ctx.globalAlpha = 0.33;
    // Rastro: línea con degradado de transparente (cola) a brillante (cabeza).
    const trail = ctx.createLinearGradient(tailX, tailY, c.x, c.y);
    trail.addColorStop(0, 'rgba(255, 214, 90, 0)');
    trail.addColorStop(1, 'rgba(255, 244, 200, 0.9)');
    ctx.strokeStyle = trail;
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(c.x, c.y);
    ctx.stroke();

    // Halo brillante blanco→amarillo.
    const glow = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 16);
    glow.addColorStop(0, 'rgba(255, 255, 255, 1)');
    glow.addColorStop(0.35, 'rgba(255, 244, 200, 0.85)');
    glow.addColorStop(1, 'rgba(255, 214, 90, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 16, 0, Math.PI * 2);
    ctx.fill();

    // Núcleo nítido.
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private readonly options: ISourceOptions = {
    fpsLimit: 60,
    fullScreen: { enable: false },
    interactivity: { events: { onHover: { enable: false }, onClick: { enable: false } } },
    particles: {
      color: { value: '#ffffff' },
      links: { color: '#ffffff', distance: 150, enable: true, opacity: 0.4, width: 0.5 },
      move: { enable: true, outModes: 'out', speed: 1 },
      number: { value: 100, density: { enable: true, width: 800, height: 800 } },
      opacity: { value: { min: 0.2, max: 0.7 } },
      shape: { type: 'circle' },
      size: { value: { min: 1.5, max: 5 } },
    },
  };
}
