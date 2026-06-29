# Demo — Comparador de ofertas CNMC (baja tensión)

> ⚠️ **Prueba de concepto. No es importante ni código de producción.** Maqueta desechable,
> fuera del alcance del proyecto. Se conserva solo por si se retoma la idea de un comparador de mercado.

## Qué hace (sin tecnicismos)
Le das los datos de un suministro (código postal, potencia, consumo) y consulta la **API pública de
la CNMC** para mostrarte, ordenadas, las **ofertas reales de las comercializadoras** y cuánto ahorrarías
frente a tu coste actual.

**Solo sirve para baja tensión** (tarifas 2.0TD y 3.0TD: hogares, pymes y comercios). No cubre alta
tensión / industria.

## Cómo abrirla
```bash
cd cnmc-demo
node server.mjs
```
Luego abre **http://localhost:8080** en el navegador. (Necesita Node 18+; no instala nada.)
