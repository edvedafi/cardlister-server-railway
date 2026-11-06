import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildSku,
  dollarsToCents,
  extractJsCookies,
  extractLoginCheck,
  groupPullRows,
  isLoginRedirectStub,
  joinOrders,
  parseAutomatedAccessResponse,
  ordersFromPullSheets,
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

describe('extractLoginCheck', () => {
  it('reads the hidden login_check token off the login form', () => {
    expect(extractLoginCheck(fixture('login-page.html'))).toBe('SL1340830Q');
  });

  it('returns undefined when the form has no token', () => {
    expect(extractLoginCheck(fixture('signin-failure.html'))).toBeUndefined();
    expect(extractLoginCheck('')).toBeUndefined();
  });

  it('returns undefined for the Turnstile-era form, which dropped the field', () => {
    expect(extractLoginCheck(fixture('login-page-turnstile.html'))).toBeUndefined();
  });
});

describe('parseAutomatedAccessResponse', () => {
  it('returns the authId on success', () => {
    expect(parseAutomatedAccessResponse({ success: true, authId: 'abc123' })).toBe('abc123');
  });

  it('throws an auth error when the key/secret is rejected', () => {
    expect(() => parseAutomatedAccessResponse({ success: false, message: 'invalid secret' })).toThrow(
      SportlotsAuthError,
    );
    expect(() => parseAutomatedAccessResponse({ success: false, message: 'invalid secret' })).toThrow(/invalid secret/);
  });

  it('throws when success is reported without an authId', () => {
    expect(() => parseAutomatedAccessResponse({ success: true })).toThrow(SportlotsAuthError);
    expect(() => parseAutomatedAccessResponse({ success: true, authId: '' })).toThrow(SportlotsAuthError);
  });

  it('throws on a non-JSON body such as an HTML error page', () => {
    expect(() => parseAutomatedAccessResponse('<html>Not Found</html>')).toThrow(SportlotsAuthError);
    expect(() => parseAutomatedAccessResponse(undefined)).toThrow(SportlotsAuthError);
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

describe('ordersFromPullSheets', () => {
  const report = (...rows: [string, string, string, string, string, string][]) =>
    `<html><body><table><tr><th>Card</th></tr>${rows
      .map(
        ([card, title, qty, amt, bin, order]) =>
          `<tr><td>${card}</td><td>${title}</td><td>NM</td><td>${qty}</td><td>${amt}</td><td>${bin} </td><td>${order}</td></tr>`,
      )
      .join('')}</table></body></html>`;

  const box = report(
    ['79', '2019 Leaf Draft #79 Nick Bosa FB', '1', '$0.18', '1213', 'jb4415442026110521238'],
    ['7', '2025 Score Sack Attack #7 Andrew Van Ginkel FB', '8', '$1.44', '767', 'jb4415442026110521238'],
  );
  const shipped = report(['201', '2015 Panini Prizm #201 Amari Cooper FB', '2', '$1.98', '1826', 'backer812026110217489']);

  it('combines reports into orders keyed by the real order key', () => {
    const orders = ordersFromPullSheets([box, shipped]);
    expect(orders.map((o) => o.id)).toEqual(['jb4415442026110521238', 'backer812026110217489']);
    expect(orders[0].customer).toEqual({ name: 'jb441544', username: 'jb441544', email: 'jb441544@sportlots.com' });
    expect(orders[0].lineItems[1]).toMatchObject({ sku: '767|7', quantity: 8, unit_price: 18 });
    expect(orders[1].lineItems[0]).toMatchObject({ sku: '1826|201', quantity: 2, unit_price: 99 });
  });

  it('ignores the same report passed twice instead of doubling quantities', () => {
    const orders = ordersFromPullSheets([box, box]);
    expect(orders).toHaveLength(1);
    expect(orders[0].lineItems).toHaveLength(2);
  });

  it('rejects an order that appears in two different reports', () => {
    const overlap = report(['1', 'Other', '1', '$0.18', '5', 'jb4415442026110521238']);
    expect(() => ordersFromPullSheets([box, overlap])).toThrow(SportlotsParseError);
  });

  it('allows an empty report alongside a full one', () => {
    expect(ordersFromPullSheets([box, report()])).toHaveLength(1);
  });

  it('rejects a page that is not a pull report', () => {
    expect(() => ordersFromPullSheets(['<html><body>nope</body></html>'])).toThrow(SportlotsParseError);
  });
});
