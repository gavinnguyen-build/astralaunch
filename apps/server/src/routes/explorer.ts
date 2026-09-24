/**
 * Explorer route — GET /api/explorer
 *
 * Returns all active Astralaunch x402 services on Monad with aggregate metrics.
 */
import { Hono } from 'hono';
import { eq, and, gte, sql, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { services, tokens, gatewayRequests } from '../db/schema.js';

const app = new Hono();

app.get('/', async (c) => {
  const since30 = new Date(Date.now() - 30 * 86_400_000);

  // All active services
  const allServices = await db.select().from(services).where(eq(services.active, true));

  // Aggregate calls + revenue per service for last 30d
  const statsRows = await db
    .select({
      serviceId: gatewayRequests.serviceId,
      calls:     sql<number>`COUNT(*)`.as('calls'),
      settled:   sql<number>`COUNT(*) FILTER (WHERE ${gatewayRequests.settled})`.as('settled'),
      revenue:   sql<string>`COALESCE(SUM(CASE WHEN ${gatewayRequests.settled} THEN CAST(${gatewayRequests.amountUsdc} AS NUMERIC) ELSE 0 END), 0)`.as('revenue'),
      payers:    sql<number>`COUNT(DISTINCT ${gatewayRequests.payer}) FILTER (WHERE ${gatewayRequests.settled})`.as('payers'),
    })
    .from(gatewayRequests)
    .where(gte(gatewayRequests.createdAt, since30))
    .groupBy(gatewayRequests.serviceId);

  const statsMap = new Map(statsRows.map(r => [r.serviceId, r]));

  // Totals
  const totalCalls    = statsRows.reduce((s, r) => s + r.calls, 0);
  const totalRevenue  = statsRows.reduce((s, r) => s + BigInt(r.revenue), 0n);
  const totalPayers   = new Set(
    (await db.select({ payer: gatewayRequests.payer })
      .from(gatewayRequests)
      .where(and(eq(gatewayRequests.settled, true), gte(gatewayRequests.createdAt, since30)))
    ).map(r => r.payer)
  ).size;

  // Recent settled payments (last 20 across all services)
  const recentPayments = await db.select({
    asset:     gatewayRequests.asset,
    payer:     gatewayRequests.payer,
    amount:    gatewayRequests.amountUsdc,
    txHash:    gatewayRequests.settleTxHash,
    createdAt: gatewayRequests.createdAt,
  })
    .from(gatewayRequests)
    .where(eq(gatewayRequests.settled, true))
    .orderBy(desc(gatewayRequests.createdAt))
    .limit(20);

  // Build service list
  const result = await Promise.all(allServices.map(async (svc) => {
    const token = await db.query.tokens.findFirst({ where: (t, { eq: eqOp }) => eqOp(t.asset, svc.asset) });
    const stats = statsMap.get(svc.id);
    return {
      id:          svc.id,
      slug:        svc.slug,
      name:        svc.name,
      description: svc.description,
      asset:       svc.asset,
      router:      svc.router,
      priceUsdc:   svc.priceUsdc,
      endpoint:    `/s/${svc.slug}`,
      token: token ? { name: token.name, symbol: token.symbol, imageUrl: token.imageUrl } : null,
      stats30d: {
        calls:    stats?.calls    ?? 0,
        settled:  stats?.settled  ?? 0,
        revenue:  stats?.revenue  ?? '0',
        payers:   stats?.payers   ?? 0,
      },
    };
  }));

  // Sort by revenue desc
  result.sort((a, b) => {
    const diff = BigInt(b.stats30d.revenue) - BigInt(a.stats30d.revenue);
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  });

  return c.json({
    services: result,
    totals30d: {
      calls:   totalCalls,
      revenue: totalRevenue.toString(),
      payers:  totalPayers,
    },
    recentPayments,
  });
});

export default app;
