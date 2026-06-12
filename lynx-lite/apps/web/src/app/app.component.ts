import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ParticlesBackgroundComponent } from './particles-background/particles-background.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ParticlesBackgroundComponent],
  template: `<app-particles-background />
    <router-outlet></router-outlet>`,
})
export class AppComponent {}
