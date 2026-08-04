import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildSku,
  dollarsToCents,
  extractJsCookies,
  groupPullRows,
  isLoginRedirectStub,
  joinOrders,
  parseOrdersResponse,
  parsePullSheet,
  SlOrderHeader,
  SlPullRow,
  SportlotsAuthError,
  SportlotsParseError,
  unitPriceCents,
  usernameFromOrderKey,
} from '../sportlots-parse';

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
const json = (name: string) => JSON.parse(fixture(name));

const BOX_ORDERS = 'orders-box.json';
const KABDEALS = 'kabdeals2026080316648';
const CENTER08 = 'Center082026080211533';

describe('dollarsToCents', () => {
  it('handles the shapes SportLots actually emits', () => {
    expect(dollarsToCents('$1.26')).toBe(126);
    expect(dollarsToCents('$0.18')).toBe(18);
    expect(dollarsToCents('$10.00')).toBe(1000);
    expect(dollarsToCents('$1.5')).toBe(150);
    expect(dollarsToCents('$1,234.56')).toBe(123456);
    expect(dollarsToCents(1.44)).toBe(144);
  });

  it('throws rather than silently producing NaN', () => {
    expect(() => dollarsToCents('not money')).toThrow(SportlotsParseError);
  });
});

describe('unitPriceCents', () => {
  it('divides the line total by quantity', () => {
    // Golden regression: the old scrape computed 126/7 = 18 for this exact line.
    expect(unitPriceCents(126, 7)).toBe(18);
    expect(unitPriceCents(18, 1)).toBe(18);
  });

  it('rounds to whole cents and survives a zero quantity', () => {
    expect(unitPriceCents(100, 3)).toBe(33);
    expect(unitPriceCents(150, 0)).toBe(150);
  });
});

describe('buildSku', () => {
  it('joins bin and card number', () => {
    expect(buildSku('116', '193')).toBe('116|193');
  });

  it('passes through a bin that already carries a card number', () => {
    expect(buildSku('116|193', '193')).toBe('116|193');
  });
});

describe('usernameFromOrderKey', () => {
  it('keeps digits that belong to the username', () => {
    expect(usernameFromOrderKey(CENTER08)).toBe('Center08');
    expect(usernameFromOrderKey(KABDEALS)).toBe('kabdeals');
  });

  it('returns the key unchanged when it does not match the pattern', () => {
    expect(usernameFromOrderKey('nonsense')).toBe('nonsense');
  });
});

describe('extractJsCookies', () => {
  it('pulls session cookies out of the onload handler', () => {
    const cookies = extractJsCookies(fixture('signin-success.html'));
    const byName = Object.fromEntries(cookies.map((c) => [c.name, c.value]));

    expect(cookies).toHaveLength(4);
    expect(byName.session_reg).toBe('edvedafi');
    expect(byName.session_type).toBe('1');
    expect(byName.session_noreg).toBe('0');
    expect(byName.xpwd).toMatch(/^[0-9A-F]{64,}$/);
  });

  it('returns nothing for a failed sign-in, which re-renders the login form', () => {
    expect(extractJsCookies(fixture('signin-failure.html'))).toEqual([]);
  });
});

describe('isLoginRedirectStub', () => {
  it('detects the unauthenticated meta-refresh', () => {
    expect(isLoginRedirectStub(fixture('pullcards-login-stub.html'))).toBe(true);
  });

  it('does not fire on a real report', () => {
    expect(isLoginRedirectStub(fixture('pullcards-box.html'))).toBe(false);
  });
});

describe('parseOrdersResponse', () => {
  it('parses order headers', () => {
    const headers = parseOrdersResponse(json(BOX_ORDERS), 'box');
    expect(headers).toHaveLength(2);
    expect(headers[1]).toEqual({
      orderKey: KABDEALS,
      custCd: 'kabdeals',
      buyerName: 'Keith Buschman',
      orderDt: '20260803',
      orderQty: 8,
      orderAmt: 1.44,
    });
  });

  it('accepts an empty order list', () => {
    expect(parseOrdersResponse(json('orders-empty.json'), 'paid')).toEqual([]);
  });

  it('throws SportlotsAuthError when the session is dead', () => {
    expect(() => parseOrdersResponse(json('orders-unauthenticated.json'), 'box')).toThrow(SportlotsAuthError);
  });

  it('warns when the reported totals disagree with the orders', () => {
    const drifted = json(BOX_ORDERS);
    drifted.totals.grandQty = 99;
    const warn = jest.fn();
    parseOrdersResponse(drifted, 'box', warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('grandQty'));
  });
});

describe('parsePullSheet', () => {
  it('parses every column of the report', () => {
    const rows = parsePullSheet(fixture('pullcards-box.html'));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      orderId: KABDEALS,
      cardNumber: '193',
      title: '2021 Panini Absolute (Retail) #193 Penei Sewell FB',
      condition: 'NM',
      quantity: 7,
      lineTotalCents: 126,
      // the raw cell is "116  " — trailing whitespace would corrupt every SKU lookup
      bin: '116',
    });
  });

  it('returns no rows for a report with only its header', () => {
    expect(parsePullSheet(fixture('pullcards-empty.html'))).toEqual([]);
  });

  it('throws SportlotsAuthError on the login redirect stub', () => {
    expect(() => parsePullSheet(fixture('pullcards-login-stub.html'))).toThrow(SportlotsAuthError);
  });

  it('throws rather than reporting an empty sheet when the table is gone', () => {
    expect(() => parsePullSheet('<html><body>maintenance</body></html>')).toThrow(SportlotsParseError);
  });
});

describe('joinOrders', () => {
  const headers = () => parseOrdersResponse(json(BOX_ORDERS), 'box');
  const rows = () => groupPullRows(parsePullSheet(fixture('pullcards-box.html')));

  it('joins headers to their pull sheet rows', () => {
    const orders = joinOrders(headers(), rows());
    expect(orders.map((o) => o.id)).toEqual([CENTER08, KABDEALS]);

    const kabdeals = orders.find((o) => o.id === KABDEALS);
    expect(kabdeals.customer).toEqual({
      name: 'Keith Buschman',
      username: 'kabdeals',
      email: 'kabdeals@sportlots.com',
    });
    expect(kabdeals.lineItems).toHaveLength(2);
    expect(kabdeals.lineItems[0]).toEqual({
      title: '2021 Panini Absolute (Retail) #193 Penei Sewell FB',
      quantity: 7,
      sku: '116|193',
      bin: '116',
      cardNumber: '193',
      unit_price: 18,
    });
  });

  it('never produces an empty username', () => {
    // The old scrape derived the username with slice(0, indexOf('2024')), which returned '' for
    // every order after 2024 and poisoned customer.email and metadata.platform.
    for (const order of joinOrders(headers(), rows())) {
      expect(order.customer.username).not.toBe('');
      expect(order.customer.email).not.toBe('@sportlots.com');
    }
  });

  it('emits an empty order and warns when a header has no pull rows', () => {
    const warn = jest.fn();
    const orders = joinOrders(headers(), new Map<string, SlPullRow[]>(), warn);
    expect(orders).toHaveLength(2);
    expect(orders.every((o) => o.lineItems.length === 0)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no pull sheet rows'));
  });

  it('synthesizes an order rather than dropping unmatched pull rows', () => {
    const warn = jest.fn();
    const orders = joinOrders([] as SlOrderHeader[], rows(), warn);

    expect(orders).toHaveLength(2);
    const center = orders.find((o) => o.id === CENTER08);
    expect(center.customer.username).toBe('Center08');
    expect(center.lineItems).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no matching order header'));
  });

  it('warns when the pull sheet disagrees with the header totals', () => {
    const drifted = headers();
    drifted[1].orderQty = 99;
    const warn = jest.fn();
    joinOrders(drifted, rows(), warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('quantity mismatch'));
  });

  it('agrees with the header totals on the real payloads', () => {
    const warn = jest.fn();
    joinOrders(headers(), rows(), warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
