// Generadores de datos sinteticos realistas para el mock de DATADIS
// Simula patrones industriales/pyme reconocibles con ruido, huecos y estimadas

// ============================================================
// PERFILES DE CLIENTE
// Añade aqui nuevos perfiles segun necesites durante el desarrollo
// ============================================================
const PROFILES = {

  // Industrial 3.0TD con maximetro (50 kW todas las potencias)
  'ES0031000000000001JN': {
    tariff: '3.0TD',
    codeFare: '31',
    contractedPower: [50.0, 50.0, 50.0, 50.0, 50.0, 50.0],
    modePowerControl: 'Maximetro',
    marketer: 'IBERDROLA CLIENTES S.A.U.',
    tension: '1kV-15kV',
    baseLoad: 8,       // kWh consumo base madrugada
    peakLoad: 45,      // kWh pico horario laboral
    weekendFactor: 0.3 // sabado/domingo al 30% del pico
  },

  // Pyme 2.0TD con ICP (9.2 kW)
  'ES0031000000000002JN': {
    tariff: '2.0TD',
    codeFare: '01',
    contractedPower: [9.2, 9.2],
    modePowerControl: 'ICP',
    marketer: 'ENDESA ENERGIA S.A.U.',
    tension: '0-1kV',
    baseLoad: 0.4,
    peakLoad: 6.5,
    weekendFactor: 0.5
  },

  // Industrial 6.1TD potencias asimetricas (punta menos dimensionada)
  'ES0031000000000003JN': {
    tariff: '6.1TD',
    codeFare: '61',
    contractedPower: [120.0, 150.0, 150.0, 200.0, 200.0, 200.0],
    modePowerControl: 'Maximetro',
    marketer: 'NATURGY IBERIA S.A.',
    tension: '>=72.5kV',
    baseLoad: 25,
    peakLoad: 160,
    weekendFactor: 0.2
  },

  // Industrial con autoconsumo solar (excedentes en horas centrales)
  'ES0031000000000004JN': {
    tariff: '3.0TD',
    codeFare: '31',
    contractedPower: [40.0, 40.0, 40.0, 40.0, 40.0, 40.0],
    modePowerControl: 'Maximetro',
    marketer: 'REPSOL ELECTRICIDAD Y GAS S.A.',
    tension: '1kV-15kV',
    selfConsumption: true,
    installedCapacityKW: 80,
    baseLoad: 6,
    peakLoad: 35,
    weekendFactor: 0.25
  }
};

function getSupplyProfile(cups) {
  return PROFILES[cups] || PROFILES['ES0031000000000001JN'];
}

// ============================================================
// CALENDARIO TARIFARIO SIMPLIFICADO
// Devuelve periodo P1-P6 para una fecha y hora dadas
// Simplificacion: no distingue temporadas ni zonas geograficas
// ============================================================
function getPeriod(date, hour, tariff) {
  const day = date.getDay(); // 0=domingo, 6=sabado
  const isWeekend = (day === 0 || day === 6);

  if (tariff === '2.0TD') {
    if (isWeekend) return 'P3';
    if ((hour >= 10 && hour < 14) || (hour >= 18 && hour < 22)) return 'P1';
    if ((hour >= 8 && hour < 10) || (hour >= 14 && hour < 18) || (hour >= 22 && hour < 24)) return 'P2';
    return 'P3'; // madrugada
  }

  // 3.0TD, 6.XTD — simplificacion peninsular invierno
  if (isWeekend) return 'P6';
  if (hour >= 10 && hour < 14) return 'P1';
  if ((hour >= 8 && hour < 10) || (hour >= 18 && hour < 22)) return 'P2';
  if ((hour >= 14 && hour < 18) || (hour >= 22 && hour < 24)) return 'P3';
  if (hour >= 6 && hour < 8) return 'P4';
  if (hour >= 1 && hour < 6) return 'P5';
  return 'P6'; // hora 0
}

// ============================================================
// GENERADOR DE CONSUMO HORARIO
// ============================================================
function generateConsumption(cups, startDate, endDate, measurementType) {
  const profile = getSupplyProfile(cups);
  const isQuarterHour = measurementType === '1' || measurementType === 1;
  const stepMinutes = isQuarterHour ? 15 : 60;

  const [sy, sm] = startDate.split('/').map(Number);
  const [ey, em] = endDate.split('/').map(Number);

  const result = [];
  const current = new Date(sy, sm - 1, 1, 0, 0);
  const end = new Date(ey, em, 0, 23, 59);

  while (current <= end) {
    const hour = current.getHours();
    const minute = current.getMinutes();
    const day = current.getDay();
    const isWeekend = (day === 0 || day === 6);

    // Factor de carga segun franja horaria (0=base, 1=pico)
    let factor;
    if (hour >= 9 && hour < 14)       factor = 1.0;
    else if (hour >= 15 && hour < 19) factor = 0.95;
    else if (hour === 8)               factor = 0.4 + (minute / 60) * 0.6;
    else if (hour === 14)              factor = 0.6 - (minute / 60) * 0.2;
    else if (hour >= 19 && hour < 22) factor = 0.55 - (hour - 19) * 0.15;
    else if (hour === 7)               factor = 0.15 + (minute / 60) * 0.25;
    else                               factor = 0.0; // madrugada

    if (isWeekend) factor *= profile.weekendFactor;

    // Variabilidad aleatoria ±10%
    const noise = 0.9 + Math.random() * 0.2;
    let kWh = (profile.baseLoad + (profile.peakLoad - profile.baseLoad) * factor) * noise;

    // En cuarto-horario, dividir entre 4 (consumo por cuarto de hora)
    if (isQuarterHour) kWh = kWh / 4;

    // Excedentes de autoconsumo solar: horas centrales en dias soleados
    let surplusKWh = 0.0;
    if (profile.selfConsumption) {
      const isSunnyHour = hour >= 10 && hour < 16 && !isWeekend;
      if (isSunnyHour) {
        const solarFactor = Math.sin(((hour - 10) / 6) * Math.PI); // curva gaussiana centrada en h=13
        const solarGen = profile.installedCapacityKW * solarFactor * (0.6 + Math.random() * 0.3);
        const solarKWh = isQuarterHour ? solarGen / 4 : solarGen;
        surplusKWh = Math.max(0, solarKWh - kWh);
        kWh = Math.max(0, kWh - solarKWh); // consumo neto de red
      }
    }

    // Simular hueco ocasional (1%) — util para testear robustez
    const isGap = Math.random() < 0.01;

    if (!isGap) {
      result.push({
        cups,
        date: `${current.getFullYear()}/${String(current.getMonth() + 1).padStart(2, '0')}/${String(current.getDate()).padStart(2, '0')}`,
        time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        consumptionKWh: Number(Math.max(0, kWh).toFixed(3)),
        obtainMethod: Math.random() < 0.95 ? 'Real' : 'Estimada',
        surplusEnergyKWh: Number(surplusKWh.toFixed(3))
      });
    }

    current.setMinutes(current.getMinutes() + stepMinutes);
  }

  return result;
}

// ============================================================
// GENERADOR DE MAXIMETRO
// Un registro por mes y por periodo (la potencia maxima cuarto-horaria)
// ============================================================
function generateMaxPower(cups, startDate, endDate) {
  const profile = getSupplyProfile(cups);
  const [sy, sm] = startDate.split('/').map(Number);
  const [ey, em] = endDate.split('/').map(Number);

  const result = [];
  const numPeriods = profile.tariff === '2.0TD' ? 2 : 6;
  const periods = Array.from({ length: numPeriods }, (_, i) => String(i + 1));

  let year = sy, month = sm;
  while (year < ey || (year === ey && month <= em)) {
    periods.forEach(p => {
      const idx = parseInt(p) - 1;
      const contractedKw = profile.contractedPower[idx] || profile.contractedPower[0];

      // P1 suele estar cerca del limite; periodos valle tienen mas margen
      const utilizationByPeriod = { '1': 0.82 + Math.random() * 0.16, '2': 0.55 + Math.random() * 0.3, '3': 0.4 + Math.random() * 0.35, '4': 0.3 + Math.random() * 0.3, '5': 0.2 + Math.random() * 0.25, '6': 0.1 + Math.random() * 0.2 };
      const factor = utilizationByPeriod[p] || 0.5;
      const maxKw = contractedKw * factor;

      // Fecha aleatoria dentro del mes, en horario laboral
      const day = Math.floor(Math.random() * 25) + 1;
      const hour = Math.floor(Math.random() * 10) + 8;
      const quarterMinutes = ['00', '15', '30', '45'][Math.floor(Math.random() * 4)];

      result.push({
        cups,
        date: `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`,
        time: `${String(hour).padStart(2, '0')}:${quarterMinutes}`,
        maxPower: Number((maxKw * 1000).toFixed(0)), // DATADIS devuelve en W, no en kW
        period: p
      });
    });

    month++;
    if (month > 12) { month = 1; year++; }
  }

  return result;
}

// ============================================================
// GENERADOR DE REACTIVA MENSUAL (get-reactive-data-v2)
// Un registro por mes y por periodo. Solo aplica a 3.0TD (>15 kW).
// Para 2.0TD y 6.1TD (fuera de alcance) devuelve array vacio.
// kVArh ~ fraccion de la activa mensual estimada; P6 con valores bajos.
// ============================================================
function generateReactive(cups, startDate, endDate) {
  const profile = getSupplyProfile(cups);
  if (profile.tariff !== '3.0TD') return []; // solo 3.0TD reporta reactiva V2

  const [sy, sm] = startDate.split('/').map(Number);
  const [ey, em] = endDate.split('/').map(Number);

  // Fraccion de reactiva sobre activa por periodo (P1 cargado, P6 casi nulo).
  const reactiveFractionByPeriod = { '1': 0.42, '2': 0.30, '3': 0.20, '4': 0.15, '5': 0.10, '6': 0.02 };
  // Activa mensual aproximada por periodo (kWh) derivada del perfil.
  const monthlyActiveByPeriod = {
    '1': profile.peakLoad * 60, '2': profile.peakLoad * 70, '3': profile.peakLoad * 80,
    '4': profile.peakLoad * 30, '5': profile.peakLoad * 50, '6': profile.peakLoad * 100,
  };

  const result = [];
  let year = sy, month = sm;
  while (year < ey || (year === ey && month <= em)) {
    for (const p of ['1', '2', '3', '4', '5', '6']) {
      const active = monthlyActiveByPeriod[p];
      const noise = 0.85 + Math.random() * 0.3;
      const kvarh = Number((active * reactiveFractionByPeriod[p] * noise).toFixed(3));
      result.push({
        cups,
        date: `${year}/${String(month).padStart(2, '0')}`,
        period: p,
        kvarh,
      });
    }
    month++;
    if (month > 12) { month = 1; year++; }
  }

  return result;
}

module.exports = { generateConsumption, generateMaxPower, generateReactive, getSupplyProfile };
