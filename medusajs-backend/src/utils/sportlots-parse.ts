import { JSDOM } from 'jsdom';
import type { SystemOrder } from '../strategies/AbstractSalesStrategy';

/**
 * Pure parsing helpers for the SportLots order API. No network, no medusa runtime imports —
 * everything here is unit testable against saved fixtures.
 *
 * SportLots exposes orders across two streams that we treat identically:
 *   box  -> orders we ship to the SportLots box  (/s/node/orders/box,  pullcards.tpl?OType=Box)
 *   paid -> orders we ship direct to the buyer   (/s/node/orders/paid, pullcards.tpl?OType=Buyer)
 *
 * The JSON endpoints return order *headers only*. Line items come from the HTML "pull sheet",
 * which returns every pending row across every order at once, tagged with an Order_id column.
 */

export type SlStream = 'box' | 'paid';

export class SportlotsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SportlotsAuthError';
  }
}

export class SportlotsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SportlotsParseError';
  }
}

export type SlOrderHeader = {
  orderKey: string;
  custCd: string;
  buyerName: string;
  orderDt: string;
  orderQty: number;
  orderAmt: number;
};

export type SlPullRow = {
  orderId: string;
  cardNumber: string;
  title: string;
  condition: string;
  quantity: number;
  lineTotalCents: number;
  bin: string;
};

export type WarnFn = (message: string) => void;

/**
 * SportLots sets its session cookies from JavaScript in an onload handler rather than via
 * Set-Cookie headers, so a cookie jar sees nothing after a successful login. Pull the
 * assignments out of the response body so the caller can inject them into the jar.
 */
export function extractJsCookies(html: string): { name: string; value: string }[] {
  const cookies: { name: string; value: string }[] = [];
  const pattern = /document\.cookie\s*=\s*["']([^"'=;]+)=([^;"']*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html || '')) !== null) {
    const name = match[1].trim();
    if (name) {
      cookies.push({ name, value: match[2].trim() });
    }
  }
  return cookies;
}

/** An unauthenticated .tpl request answers with a tiny meta-refresh back to the login page. */
export function isLoginRedirectStub(html: string): boolean {
  return /http-equiv\s*=\s*["']?Refresh/i.test(html || '') && /login\.tpl/i.test(html || '');
}

export function dollarsToCents(value: string | number): number {
  const numeric = typeof value === 'number' ? value : parseFloat(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(numeric)) {
    throw new SportlotsParseError(`Unparseable currency value: ${JSON.stringify(value)}`);
  }
  return Math.round(numeric * 100);
}

/** SportLots reports the line *total*; medusa wants integer cents per unit. */
export function unitPriceCents(lineTotalCents: number, quantity: number): number {
  if (!quantity || quantity < 1) return lineTotalCents;
  return Math.round(lineTotalCents / quantity);
}

export function buildSku(bin: string, cardNumber: string): string {
  return bin.includes('|') ? bin : `${bin}|${cardNumber}`;
}

/**
 * Fallback only, for pull rows with no matching order header. Order keys are
 * <username><YYYYMMDD><time>, e.g. Center082026080211533 -> Center08. The prefix match must be
 * greedy so a username that itself ends in digits keeps them.
 */
export function usernameFromOrderKey(orderKey: string): string {
  const match = /^(.*)(20\d{6})(\d{3,6})$/.exec(orderKey);
  return match?.[1] || orderKey;
}

export function parseOrdersResponse(body: unknown, stream: SlStream, onWarn?: WarnFn): SlOrderHeader[] {
  if (!body || typeof body !== 'object') {
    throw new SportlotsParseError(`Unexpected ${stream} orders response: ${JSON.stringify(body)?.slice(0, 200)}`);
  }

  const payload = body as { success?: boolean; message?: string; orders?: unknown; totals?: { grandQty?: number } };

  if (payload.success !== true) {
    // e.g. {"success":false,"message":"Seller not logged in."}
    throw new SportlotsAuthError(`SportLots ${stream} orders rejected: ${payload.message || 'unknown error'}`);
  }
  if (!Array.isArray(payload.orders)) {
    throw new SportlotsParseError(`SportLots ${stream} orders response had no orders array`);
  }

  const headers = payload.orders.map((raw: Record<string, unknown>) => ({
    orderKey: String(raw.orderKey ?? '').trim(),
    custCd: String(raw.custCd ?? '').trim(),
    buyerName: String(raw.buyerName ?? '').trim(),
    orderDt: String(raw.orderDt ?? '').trim(),
    orderQty: Number(raw.orderQty ?? 0),
    orderAmt: Number(raw.orderAmt ?? 0),
  }));

  const missingKey = headers.filter((h) => !h.orderKey);
  if (missingKey.length > 0) {
    throw new SportlotsParseError(`SportLots ${stream} returned ${missingKey.length} order(s) with no orderKey`);
  }

  // Free tripwire for payload drift: the site tells us its own totals.
  const grandQty = payload.totals?.grandQty;
  if (typeof grandQty === 'number') {
    const summed = headers.reduce((sum, h) => sum + h.orderQty, 0);
    if (summed !== grandQty) {
      onWarn?.(`order quantities sum to ${summed} but totals.grandQty is ${grandQty}`);
    }
  }

  return headers;
}

const PULL_SHEET_COLUMNS = 7;

/**
 * Parses the "Dealer Pull Cards Report". Columns are:
 *   Card | Description | Cond | Qty | Amt | Sku/Bin | Order_id
 * The bin cell carries trailing whitespace and the description is wrapped in a <font> tag with an
 * embedded newline, so every cell goes through textContent.trim().
 */
export function parsePullSheet(html: string): SlPullRow[] {
  if (isLoginRedirectStub(html)) {
    throw new SportlotsAuthError('SportLots pull sheet redirected to the login page');
  }

  const dom = new JSDOM(html);
  const table = dom.window.document.querySelector('table');
  if (!table) {
    // An empty sheet still renders the table with just its header row. No table at all means we
    // got something other than the report — a site change or a bounced session.
    throw new SportlotsParseError('SportLots pull sheet contained no table');
  }

  const rows: SlPullRow[] = [];
  table.querySelectorAll('tr').forEach((tr) => {
    if (tr.querySelector('th')) return;
    const cells = Array.from(tr.querySelectorAll('td'));
    if (cells.length !== PULL_SHEET_COLUMNS) return;

    const [card, description, cond, qty, amt, bin, orderId] = cells.map((td) => (td.textContent || '').trim());
    if (!orderId) return;

    rows.push({
      orderId,
      cardNumber: card || 'NNO',
      title: description,
      condition: cond,
      quantity: parseInt(qty, 10) || 0,
      lineTotalCents: dollarsToCents(amt),
      bin,
    });
  });

  return rows;
}

export function groupPullRows(rows: SlPullRow[]): Map<string, SlPullRow[]> {
  const grouped = new Map<string, SlPullRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.orderId);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.orderId, [row]);
    }
  }
  return grouped;
}

function toLineItems(rows: SlPullRow[]): SystemOrder['lineItems'] {
  return rows.map((row) => ({
    title: row.title,
    quantity: row.quantity,
    sku: buildSku(row.bin, row.cardNumber),
    bin: row.bin,
    cardNumber: row.cardNumber,
    unit_price: unitPriceCents(row.lineTotalCents, row.quantity),
  }));
}

/**
 * Left joins order headers onto their pull rows, then sweeps up any pull rows whose order has no
 * header. Both mismatch directions are reported rather than silently dropped — an unmatched pull
 * row is a card we would ship without recording the sale.
 */
export function joinOrders(
  headers: SlOrderHeader[],
  rowsByOrder: Map<string, SlPullRow[]>,
  onWarn?: WarnFn,
): SystemOrder[] {
  const orders: SystemOrder[] = [];
  const claimed = new Set<string>();

  for (const header of headers) {
    const rows = rowsByOrder.get(header.orderKey) || [];
    claimed.add(header.orderKey);

    if (rows.length === 0) {
      // Typically an order that has already been pulled. processJob drops empty orders; don't
      // invent line items for it.
      onWarn?.(`order ${header.orderKey} has no pull sheet rows`);
    } else {
      const qty = rows.reduce((sum, r) => sum + r.quantity, 0);
      const cents = rows.reduce((sum, r) => sum + r.lineTotalCents, 0);
      if (qty !== header.orderQty) {
        onWarn?.(`order ${header.orderKey} quantity mismatch: pull sheet ${qty} vs header ${header.orderQty}`);
      }
      if (cents !== dollarsToCents(header.orderAmt)) {
        onWarn?.(
          `order ${header.orderKey} amount mismatch: pull sheet ${cents} vs header ${dollarsToCents(header.orderAmt)}`,
        );
      }
    }

    orders.push({
      id: header.orderKey,
      customer: {
        name: header.buyerName || header.custCd,
        username: header.custCd,
        email: `${header.custCd}@sportlots.com`,
      },
      lineItems: toLineItems(rows),
    });
  }

  for (const [orderId, rows] of rowsByOrder) {
    if (claimed.has(orderId)) continue;
    const username = usernameFromOrderKey(orderId);
    onWarn?.(`pull sheet order ${orderId} has no matching order header; synthesizing from the order key`);
    orders.push({
      id: orderId,
      customer: {
        name: username,
        username,
        email: `${username}@sportlots.com`,
      },
      lineItems: toLineItems(rows),
    });
  }

  return orders;
}
