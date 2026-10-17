const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-ordering-test-'));
process.env.DATA_DIRECTORY = temporaryDirectory;
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'restaurant.sqlite');
const store = require('../lib/store');

before(async () => {
  fs.writeFileSync(path.join(temporaryDirectory, 'restaurant.json'), JSON.stringify({
    settings: { restaurantName: '移行テスト食堂', announcement: '営業中です。', tableIds: ['T01'] },
    menu: [{
      id: 'legacy-dish',
      name: '移行テスト定食',
      category: '定食',
      price: 800,
      description: '移行したメニュー',
      emoji: '🍱',
      available: true,
      sold: 2
    }],
    orders: [{
      id: 'legacy-order',
      number: 'LEGACY01',
      tableId: 'T01',
      customerName: '移行済みのお客様',
      note: '',
      items: [{ id: 'legacy-dish', name: '移行テスト定食', emoji: '🍱', price: 800, quantity: 1 }],
      total: 800,
      status: 'pending',
      paymentMethod: '店頭払い',
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z'
    }]
  }));
  await store.initializeStore();
});

after(() => {
  store.closeStore();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('imports legacy store data into the SQLite database', () => {
  const data = store.readStore();
  assert.equal(store.databaseFile, path.join(temporaryDirectory, 'restaurant.sqlite'));
  assert.equal(data.settings.restaurantName, '移行テスト食堂');
  assert.equal(data.menu[0].name, '移行テスト定食');
  assert.equal(data.orders[0].id, 'legacy-order');
  assert.equal(data.orders[0].items[0].quantity, 1);
  assert.equal(data.orders[0].paymentStatus, 'unpaid');
  assert.equal(store.readTableSessions()[0].orderCount, 1);
  assert.equal(fs.existsSync(path.join(temporaryDirectory, 'restaurant.sqlite')), true);
});

test('creates an order from database prices and deduplicates retries', () => {
  const key = crypto.randomUUID();
  const request = {
    tableId: 'T01',
    customerName: 'テストのお客様',
    note: '',
    items: [{ id: 'legacy-dish', quantity: 2 }],
    idempotencyKey: key
  };

  const first = store.createOrder(request);
  assert.equal(first.replayed, false);
  assert.equal(first.order.total, 1600);
  assert.equal(first.order.statusLabel, '受付待ち');

  const replay = store.createOrder(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.order.id, first.order.id);
  assert.equal(store.readStore().menu[0].sold, 4);

  assert.throws(() => store.createOrder({
    ...request,
    items: [{ id: 'legacy-dish', quantity: 1 }]
  }), (error) => error.status === 409);
  assert.equal(store.readStore().orders.length, 2);
});

test('requests payment, closes a table session, and opens a clean next session', () => {
  const currentSession = store.readTableSessions()[0];
  assert.equal(currentSession.status, 'open');
  assert.equal(currentSession.orderCount, 2);
  assert.equal(currentSession.total, 2400);

  const checkoutRequest = store.requestTableCheckout('T01');
  assert.equal(checkoutRequest.status, 'checkout_requested');
  assert.equal(checkoutRequest.total, 2400);
  assert.equal(store.requestTableCheckout('T01').status, 'checkout_requested');

  assert.throws(() => store.createOrder({
    tableId: 'T01',
    customerName: '',
    note: '',
    items: [{ id: 'legacy-dish', quantity: 1 }],
    idempotencyKey: crypto.randomUUID()
  }), (error) => error.status === 409);

  const resumedSession = store.resumeTableOrders('T01');
  assert.equal(resumedSession.status, 'open');
  assert.throws(() => store.resumeTableOrders('T01'), (error) => error.status === 409);
  assert.equal(store.requestTableCheckout('T01').status, 'checkout_requested');

  const settledSession = store.settleTable('T01');
  assert.equal(settledSession.status, 'closed');
  assert.ok(settledSession.paidAt);
  assert.equal(store.readOrder('legacy-order').paymentStatus, 'paid');
  assert.equal(store.readTableSessions()[0].status, 'closed');
  assert.throws(() => store.settleTable('T01'), (error) => error.status === 409);

  const nextSession = store.reopenTable('T01');
  assert.equal(nextSession.status, 'open');
  assert.equal(nextSession.orderCount, 0);
  assert.notEqual(nextSession.id, settledSession.id);
  assert.equal(store.readOrder('legacy-order').paymentStatus, 'paid');

  const nextOrder = store.createOrder({
    tableId: 'T01',
    customerName: '次のお客様',
    note: '',
    items: [{ id: 'legacy-dish', quantity: 1 }],
    idempotencyKey: crypto.randomUUID()
  });
  assert.equal(nextOrder.order.tableSessionId, nextSession.id);
  assert.equal(store.readTableSessions()[0].orderCount, 1);
});

test('rejects invalid table numbers, items and excessive quantities', () => {
  const makeRequest = (overrides = {}) => ({
    tableId: 'T01',
    customerName: '',
    note: '',
    items: [{ id: 'legacy-dish', quantity: 1 }],
    idempotencyKey: crypto.randomUUID(),
    ...overrides
  });

  assert.throws(() => store.createOrder(makeRequest({ tableId: 'BAD' })), (error) => error.status === 400);
  assert.throws(() => store.createOrder(makeRequest({ items: [{ id: 'missing', quantity: 1 }] })), (error) => error.status === 400);
  assert.throws(() => store.createOrder(makeRequest({ items: [{ id: 'legacy-dish', quantity: 21 }] })), (error) => error.status === 400);
});

test('persists admin changes and order status across database reload', () => {
  store.updateSettings({ restaurantName: '更新後の食堂', announcement: '新しいお知らせ', tableIds: ['T01', 'T02'] });
  store.updateOrderStatus('legacy-order', 'ready');
  store.closeStore();

  return store.initializeStore().then(() => {
    const data = store.readStore();
    assert.equal(data.settings.restaurantName, '更新後の食堂');
    assert.deepEqual(data.settings.tableIds, ['T01', 'T02']);
    assert.equal(store.readOrder('legacy-order').statusLabel, 'お渡し準備完了');
  });
});
