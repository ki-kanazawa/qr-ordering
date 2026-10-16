const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const defaultDataDirectory = path.join(__dirname, '..', 'data');
const configuredDataDirectory = path.resolve(process.env.DATA_DIRECTORY || defaultDataDirectory);
const databaseFile = path.resolve(process.env.DATABASE_PATH || path.join(configuredDataDirectory, 'restaurant.sqlite'));
const dataDirectory = path.resolve(process.env.DATA_DIRECTORY || path.dirname(databaseFile));
const legacyFile = path.join(dataDirectory, 'restaurant.json');
const statusLabels = {
  pending: '受付待ち',
  preparing: '調理中',
  ready: 'お渡し準備完了',
  completed: '受取済み',
  cancelled: 'キャンセル'
};
const initialData = {
  settings: {
    restaurantName: 'こまち食堂',
    announcement: 'ご注文をいただいてから、心を込めてお作りします。',
    tableIds: ['A01', 'A02', 'A03', 'A05', 'B01', 'B02', 'B03', 'B05']
  },
  menu: [
    { id: 'dish-01', name: '豚の角煮', category: 'おすすめ', price: 980, description: 'じっくり煮込んだ、とろけるやわらかさ。', emoji: '🍖', available: true, sold: 128 },
    { id: 'dish-02', name: '鶏の照り焼き定食', category: 'ご飯・定食', price: 880, description: '香ばしい鶏肉に、ご飯と季節の野菜を添えて。', emoji: '🍗', available: true, sold: 96 },
    { id: 'dish-03', name: '牛すじトマトうどん', category: '麺類', price: 920, description: 'トマトの旨みが広がるスープと、やわらかな牛すじ。', emoji: '🍜', available: true, sold: 84 },
    { id: 'dish-04', name: '白身魚の南蛮漬け', category: 'おすすめ', price: 1280, description: '揚げたての白身魚を、特製甘酢だれで。', emoji: '🐟', available: true, sold: 72 },
    { id: 'dish-05', name: 'ほうれん草のごま和え', category: '小鉢', price: 380, description: '香ばしいごまの風味を楽しめる定番の小鉢。', emoji: '🥦', available: true, sold: 54 },
    { id: 'dish-06', name: '手包みえび餃子', category: '小鉢', price: 580, description: '毎日手包み。ぷりぷりのえびを薄皮で包みました。', emoji: '🥟', available: true, sold: 61 },
    { id: 'dish-07', name: '自家製梅ソーダ', category: 'ドリンク・デザート', price: 420, description: '梅の甘酸っぱさが広がる、すっきり爽やかな一杯。', emoji: '🥤', available: true, sold: 103 },
    { id: 'dish-08', name: '抹茶白玉パフェ', category: 'ドリンク・デザート', price: 680, description: '抹茶アイスともちもち白玉を楽しむ和風パフェ。', emoji: '🍵', available: true, sold: 48 }
  ],
  orders: []
};

let database;

function statementOne(sql, params = []) {
  const statement = database.prepare(sql);
  try {
    statement.bind(params);
    return statement.step() ? statement.getAsObject() : null;
  } finally {
    statement.free();
  }
}

function statementAll(sql, params = []) {
  const statement = database.prepare(sql);
  try {
    statement.bind(params);
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function persistDatabase() {
  const temporaryFile = `${databaseFile}.tmp`;
  fs.writeFileSync(temporaryFile, Buffer.from(database.export()));
  fs.renameSync(temporaryFile, databaseFile);
}

function inTransaction(callback) {
  database.run('BEGIN IMMEDIATE');
  let transactionOpen = true;
  try {
    const result = callback();
    database.run('COMMIT');
    transactionOpen = false;
    persistDatabase();
    return result;
  } catch (error) {
    if (transactionOpen) database.run('ROLLBACK');
    throw error;
  }
}

function readOrder(id) {
  const row = statementOne('SELECT * FROM orders WHERE id = ?', [id]);
  if (!row) return null;
  const items = statementAll('SELECT menu_item_id, name, emoji, price, quantity FROM order_items WHERE order_id = ? ORDER BY rowid', [id]);
  return {
    id: row.id,
    number: row.order_number,
    tableId: row.table_id,
    customerName: row.customer_name,
    note: row.note,
    items: items.map((item) => ({
      id: item.menu_item_id,
      name: item.name,
      emoji: item.emoji,
      price: item.price,
      quantity: item.quantity
    })),
    total: row.total,
    status: row.status,
    statusLabel: statusLabels[row.status],
    paymentMethod: row.payment_method,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function readStore() {
  const settings = statementOne('SELECT restaurant_name, announcement, table_ids FROM restaurant_settings WHERE id = 1');
  return {
    settings: {
      restaurantName: settings.restaurant_name,
      announcement: settings.announcement,
      tableIds: JSON.parse(settings.table_ids)
    },
    menu: statementAll('SELECT id, name, category, price, description, emoji, image_url, available, sold FROM menu ORDER BY rowid').map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      price: item.price,
      description: item.description,
      emoji: item.emoji,
      imageUrl: item.image_url,
      available: item.available === 1,
      sold: item.sold
    })),
    orders: statementAll('SELECT id FROM orders ORDER BY created_at DESC, rowid DESC').map((order) => readOrder(order.id))
  };
}

function importLegacyData(data) {
  database.run(
    'INSERT INTO restaurant_settings (id, restaurant_name, announcement, table_ids) VALUES (1, ?, ?, ?)',
    [data.settings.restaurantName, data.settings.announcement || '', JSON.stringify(data.settings.tableIds)]
  );
  const addMenu = database.prepare('INSERT OR IGNORE INTO menu (id, name, category, price, description, emoji, image_url, available, sold) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  try {
    for (const item of data.menu || []) {
      addMenu.run([item.id, item.name, item.category, item.price, item.description || '', item.emoji || '🍽️', item.imageUrl || null, item.available === false ? 0 : 1, item.sold || 0]);
    }
  } finally {
    addMenu.free();
  }

  const addOrder = database.prepare('INSERT OR IGNORE INTO orders (id, order_number, table_id, customer_name, note, total, status, payment_method, created_at, updated_at, idempotency_key, request_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const addItem = database.prepare('INSERT INTO order_items (order_id, menu_item_id, name, emoji, price, quantity) VALUES (?, ?, ?, ?, ?, ?)');
  try {
    for (const order of data.orders || []) {
      const createdAt = order.createdAt || new Date().toISOString();
      const idempotencyKey = order.idempotencyKey || crypto.randomUUID();
      const requestHash = order.requestHash || crypto.createHash('sha256').update(JSON.stringify(order.items || [])).digest('hex');
      addOrder.run([order.id, order.number, order.tableId, order.customerName || 'お客様', order.note || '', order.total, order.status, order.paymentMethod || '店頭払い', createdAt, order.updatedAt || createdAt, idempotencyKey, requestHash]);
      for (const item of order.items || []) {
        addItem.run([order.id, item.id, item.name, item.emoji || '🍽️', item.price, item.quantity]);
      }
    }
  } finally {
    addOrder.free();
    addItem.free();
  }
}

async function initializeStore() {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const initSqlJs = require('sql.js');
  const wasmDirectory = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (file) => path.join(wasmDirectory, file) });
  database = fs.existsSync(databaseFile)
    ? new SQL.Database(new Uint8Array(fs.readFileSync(databaseFile)))
    : new SQL.Database();
  database.run('PRAGMA foreign_keys = ON');
  database.run('CREATE TABLE IF NOT EXISTS restaurant_settings (id INTEGER PRIMARY KEY CHECK (id = 1), restaurant_name TEXT NOT NULL, announcement TEXT NOT NULL DEFAULT \'\', table_ids TEXT NOT NULL)');
  database.run('CREATE TABLE IF NOT EXISTS menu (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, price REAL NOT NULL CHECK (price >= 0), description TEXT NOT NULL DEFAULT \'\', emoji TEXT NOT NULL, image_url TEXT, available INTEGER NOT NULL DEFAULT 1, sold INTEGER NOT NULL DEFAULT 0)');
  database.run('CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, order_number TEXT NOT NULL UNIQUE, table_id TEXT NOT NULL, customer_name TEXT NOT NULL, note TEXT NOT NULL DEFAULT \'\', total REAL NOT NULL CHECK (total >= 0), status TEXT NOT NULL, payment_method TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL)');
  database.run('CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, menu_item_id TEXT NOT NULL, name TEXT NOT NULL, emoji TEXT NOT NULL, price REAL NOT NULL CHECK (price >= 0), quantity INTEGER NOT NULL CHECK (quantity > 0))');
  database.run('CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC)');
  database.run('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');

  if (!statementOne('SELECT id FROM restaurant_settings WHERE id = 1')) {
    const data = fs.existsSync(legacyFile) ? JSON.parse(fs.readFileSync(legacyFile, 'utf8')) : initialData;
    inTransaction(() => importLegacyData(data));
  } else if (!fs.existsSync(databaseFile)) {
    persistDatabase();
  }
}

function createOrder({ tableId, customerName, note, items, idempotencyKey }) {
  const cleanName = customerName || 'お客様';
  const requestedItems = Array.isArray(items) ? items : [];
  const fingerprint = JSON.stringify({
    tableId,
    customerName: cleanName,
    note,
    items: requestedItems.map((item) => ({
      id: item && typeof item.id === 'string' ? item.id : '',
      quantity: item?.quantity
    }))
  });
  const requestHash = crypto.createHash('sha256').update(fingerprint).digest('hex');

  return inTransaction(() => {
    const existing = statementOne('SELECT id, request_hash FROM orders WHERE idempotency_key = ?', [idempotencyKey]);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        const error = new Error('この注文キーは別の注文です。ページを更新してもう一度お試しください。');
        error.status = 409;
        throw error;
      }
      return { order: readOrder(existing.id), replayed: true };
    }

    const settingsRow = statementOne('SELECT table_ids FROM restaurant_settings WHERE id = 1');
    const tableIds = JSON.parse(settingsRow.table_ids);
    if (!tableIds.includes(tableId)) {
      const error = new Error('テーブル番号が無効です。テーブルのQRコードを読み取り直してください。');
      error.status = 400;
      throw error;
    }
    if (requestedItems.length === 0 || requestedItems.length > 30) {
      const error = new Error('メニューを選択してから注文してください。');
      error.status = 400;
      throw error;
    }

    const quantities = new Map();
    for (const requested of requestedItems) {
      if (!requested || typeof requested.id !== 'string') {
        const error = new Error('無効なメニューまたは数量が含まれています。メニューを更新してもう一度お試しください。');
        error.status = 400;
        throw error;
      }
      const menuItem = statementOne('SELECT id, name, emoji, price, available FROM menu WHERE id = ?', [requested.id]);
      const quantity = Number(requested.quantity);
      if (!menuItem || menuItem.available !== 1 || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
        const error = new Error('無効なメニューまたは数量が含まれています。メニューを更新してもう一度お試しください。');
        error.status = 400;
        throw error;
      }
      const combined = (quantities.get(menuItem.id)?.quantity || 0) + quantity;
      if (combined > 20) {
        const error = new Error('1品につき20個まで注文できます。');
        error.status = 400;
        throw error;
      }
      quantities.set(menuItem.id, { ...menuItem, quantity: combined });
    }

    const orderItems = [...quantities.values()];
    const totalQuantity = orderItems.reduce((sum, item) => sum + item.quantity, 0);
    if (totalQuantity > 50) {
      const error = new Error('1回のご注文は合計50品までです。');
      error.status = 400;
      throw error;
    }
    const total = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const orderNumber = `M${Date.now().toString().slice(-8)}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    database.run(
      'INSERT INTO orders (id, order_number, table_id, customer_name, note, total, status, payment_method, created_at, updated_at, idempotency_key, request_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, orderNumber, tableId, cleanName, note, total, 'pending', '店頭払い', createdAt, createdAt, idempotencyKey, requestHash]
    );
    for (const item of orderItems) {
      database.run(
        'INSERT INTO order_items (order_id, menu_item_id, name, emoji, price, quantity) VALUES (?, ?, ?, ?, ?, ?)',
        [id, item.id, item.name, item.emoji, item.price, item.quantity]
      );
      database.run('UPDATE menu SET sold = sold + ? WHERE id = ?', [item.quantity, item.id]);
    }
    return { order: readOrder(id), replayed: false };
  });
}

function updateOrderStatus(id, status) {
  return inTransaction(() => {
    const updatedAt = new Date().toISOString();
    database.run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [status, updatedAt, id]);
    return readOrder(id);
  });
}

function createMenuItem(item) {
  inTransaction(() => {
    database.run(
      'INSERT INTO menu (id, name, category, price, description, emoji, available, sold) VALUES (?, ?, ?, ?, ?, ?, 1, 0)',
      [item.id, item.name, item.category, item.price, item.description, item.emoji]
    );
  });
  return readStore().menu.find((entry) => entry.id === item.id);
}

function updateMenuItem(id, item) {
  return inTransaction(() => {
    database.run(
      'UPDATE menu SET name = ?, category = ?, price = ?, description = ?, emoji = ?, available = ? WHERE id = ?',
      [item.name, item.category, item.price, item.description, item.emoji, item.available ? 1 : 0, id]
    );
    return readStore().menu.find((entry) => entry.id === id) || null;
  });
}

function setMenuPhoto(id, imageUrl) {
  return inTransaction(() => {
    database.run('UPDATE menu SET image_url = ? WHERE id = ?', [imageUrl, id]);
    return readStore().menu.find((entry) => entry.id === id) || null;
  });
}

function deleteMenuItem(id) {
  return inTransaction(() => {
    const item = readStore().menu.find((entry) => entry.id === id);
    if (!item) return null;
    database.run('DELETE FROM menu WHERE id = ?', [id]);
    return item;
  });
}

function updateSettings(settings) {
  inTransaction(() => {
    database.run(
      'UPDATE restaurant_settings SET restaurant_name = ?, announcement = ?, table_ids = ? WHERE id = 1',
      [settings.restaurantName, settings.announcement, JSON.stringify(settings.tableIds)]
    );
  });
  return readStore().settings;
}

function closeStore() {
  if (database) {
    database.close();
    database = null;
  }
}

module.exports = {
  databaseFile,
  initializeStore,
  readStore,
  readOrder,
  createOrder,
  updateOrderStatus,
  createMenuItem,
  updateMenuItem,
  setMenuPhoto,
  deleteMenuItem,
  updateSettings,
  closeStore
};
