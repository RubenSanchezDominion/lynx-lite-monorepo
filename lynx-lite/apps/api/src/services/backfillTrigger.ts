// Seam de disparo de backfill. Arquitectura (SPECS §1.5): api y worker son procesos
// separados que coordinan vía PostgreSQL. createSupply deja el Supply con
// backfillStatus=PENDING y el worker lo recoge por polling.
//
// Esta función existe como punto de inyección para tests (spy) y para una futura
// integración con cola de mensajes. En producción es un no-op: la verdad está en
// el campo backfillStatus de PostgreSQL.
export async function enqueueBackfill(supplyId: string): Promise<void> {
  // Intencionadamente vacío: el worker hace polling de supplies PENDING.
  void supplyId;
}
