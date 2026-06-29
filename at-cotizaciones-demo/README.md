# Demo — Comparador de cotizaciones de Alta Tensión (6.xTD)

> ⚠️ **Prueba de concepto. No es importante ni código de producción.** Maqueta desechable,
> fuera del alcance del proyecto. Se conserva solo por si se retoma la idea de un comparador de mercado.

## Qué hace (sin tecnicismos)
Para **industria en alta tensión** (tarifas 6.xTD), donde **no existen precios públicos** que consultar.
Le das varias **cotizaciones de ejemplo** (precio fijo, indexado, híbrido y PPA), y la herramienta:

1. consulta el **precio de mercado real** (REData, de Red Eléctrica),
2. lo cruza con la curva de consumo del cliente,
3. y te dice, para cada cotización, el **coste anual esperado** y su **riesgo** (cuánto puede variar
   si el mercado se dispara).

Así se ve, por ejemplo, que un precio fijo es más caro pero seguro, y un indexado es barato pero
puede dispararse.

**Importante:** solo el **precio de mercado** es real. Las cotizaciones, los peajes y la curva de
consumo son **datos de ejemplo** para enseñar el método; las cifras de coste todavía no son fiables.

## Cómo abrirla
```bash
cd at-cotizaciones-demo
node server.mjs
```
Luego abre **http://localhost:8090** en el navegador. (Necesita Node 18+; no instala nada.)
