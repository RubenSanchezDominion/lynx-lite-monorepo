import { Routes } from '@angular/router';
import { LoginComponent } from './login/login.component';
import { PreInvoiceComponent } from './pre-invoice/pre-invoice.component';
import { OptimizationComponent } from './optimization/optimization.component';
import { AlertsComponent } from './alerts/alerts.component';
import { KpiComponent } from './kpi/kpi.component';
import { CarbonComponent } from './carbon/carbon.component';
import { authGuard } from './auth.guard';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: 'prefactura', component: PreInvoiceComponent, canActivate: [authGuard] },
  { path: 'optimizacion', component: OptimizationComponent, canActivate: [authGuard] },
  { path: 'alertas', component: AlertsComponent, canActivate: [authGuard] },
  { path: 'kpi', component: KpiComponent, canActivate: [authGuard] },
  { path: 'huella', component: CarbonComponent, canActivate: [authGuard] },
  { path: '', pathMatch: 'full', redirectTo: 'prefactura' },
  { path: '**', redirectTo: 'prefactura' },
];
