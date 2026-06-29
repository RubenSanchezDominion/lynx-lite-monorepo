import { Routes } from '@angular/router';
import { LoginComponent } from './login/login.component';
import { PreInvoiceComponent } from './pre-invoice/pre-invoice.component';
import { OptimizationComponent } from './optimization/optimization.component';
import { AlertsComponent } from './alerts/alerts.component';
import { KpiComponent } from './kpi/kpi.component';
import { CarbonComponent } from './carbon/carbon.component';
import { SolarComponent } from './solar/solar.component';
import { ComparisonComponent } from './comparison/comparison.component';
import { DashboardComponent } from './dashboard/dashboard.component';
import { ReportsComponent } from './reports/reports.component';
import { UsersComponent } from './users/users.component';
import { authGuard } from './auth.guard';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: 'dashboard', component: DashboardComponent, canActivate: [authGuard] },
  { path: 'prefactura', component: PreInvoiceComponent, canActivate: [authGuard] },
  { path: 'optimizacion', component: OptimizationComponent, canActivate: [authGuard] },
  { path: 'alertas', component: AlertsComponent, canActivate: [authGuard] },
  { path: 'kpi', component: KpiComponent, canActivate: [authGuard] },
  { path: 'huella', component: CarbonComponent, canActivate: [authGuard] },
  { path: 'solar', component: SolarComponent, canActivate: [authGuard] },
  { path: 'comparacion', component: ComparisonComponent, canActivate: [authGuard] },
  { path: 'informes', component: ReportsComponent, canActivate: [authGuard] },
  { path: 'usuarios', component: UsersComponent, canActivate: [authGuard] },
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: '**', redirectTo: 'dashboard' },
];
