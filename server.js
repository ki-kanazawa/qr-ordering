require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const session = require('express-session');
const multer = require('multer');
const QRCode = require('qrcode');
const store = require('./lib/store');

const app = express();
const port = Number(process.env.PORT) || 3000;
const uploadsDirectory = path.join(__dirname, 'data', 'uploads');
const uploadPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return callback(new Error('JPG、PNG、WebP形式の画像を選択してください。'));
    }
    callback(null, true);
  }
});
const orderStatuses = new Set(['pending', 'preparing', 'ready', 'completed', 'cancelled']);
const statusLabels = {
  pending: '受付待ち',
  preparing: '調理中',
  ready: 'お渡し準備完了',
  completed: '受取済み',
  cancelled: 'キャンセル'
};

app.disable('x-powered-by');
if (Number(process.env.TRUST_PROXY_HOPS) > 0) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS));
}
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  if (req.body === null) return apiError(res, 400, 'リクエスト内容が無効です。');
  next();
});
app.use(session({
  name: 'table-order.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

function apiError(res, status, message) {
  return res.status(status).json({ error: message });
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) {
    return apiError(res, 401, '管理画面にログインしてください。');
  }
  next();
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function validPrice(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100000;
}

function rateLimitResponse(message) {
  return (req, res) => apiError(res, 429, message);
}

const orderRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: rateLimitResponse('ご注文が短時間に集中しています。10分ほど待ってからもう一度お試しください。')
});

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: rateLimitResponse('ログイン試行が多すぎます。15分後にもう一度お試しください。')
});

function uploadedImagePath(imageUrl) {
  if (typeof imageUrl !== 'string' || !/^\/uploads\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(imageUrl)) {
    return null;
  }
  return path.join(uploadsDirectory, path.basename(imageUrl));
}

function removeUploadedImage(imageUrl) {
  const imagePath = uploadedImagePath(imageUrl);
  if (imagePath && fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
}

function imageExtension(buffer, mimeType) {
  if (mimeType === 'image/jpeg' && buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (mimeType === 'image/png' && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (mimeType === 'image/webp' && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

app.get('/api/menu', (req, res) => {
  const data = store.readStore();
  res.json({ settings: data.settings, menu: data.menu.filter((item) => item.available) });
});

app.post('/api/orders', orderRateLimit, (req, res) => {
  const idempotencyKey = req.get('Idempotency-Key');
  if (typeof idempotencyKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
    return apiError(res, 400, '注文情報を確認できません。ページを更新してもう一度お試しください。');
  }
  try {
    const result = store.createOrder({
      tableId: cleanText(req.body.tableId, 12),
      customerName: cleanText(req.body.customerName, 40),
      note: cleanText(req.body.note, 300),
      items: req.body.items,
      idempotencyKey
    });
    res.status(result.replayed ? 200 : 201).json({ order: result.order });
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    throw error;
  }
});

app.get('/api/orders/:id', (req, res) => {
  const order = store.readOrder(req.params.id);
  if (!order) return apiError(res, 404, '注文が見つかりません。');
  res.json({ order });
});

app.post('/api/admin/login', loginRateLimit, (req, res) => {
  const submitted = typeof req.body.password === 'string' ? req.body.password : '';
  const expected = process.env.ADMIN_PASSWORD || '246810';
  const submittedHash = crypto.createHash('sha256').update(submitted).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(submittedHash, expectedHash)) {
    return apiError(res, 401, 'パスワードが正しくありません。もう一度お試しください。');
  }
  req.session.regenerate((error) => {
    if (error) return apiError(res, 500, 'ログインできませんでした。もう一度お試しください。');
    req.session.isAdmin = true;
    req.session.save((saveError) => {
      if (saveError) return apiError(res, 500, 'ログイン状態を保存できませんでした。もう一度お試しください。');
      res.json({ ok: true });
    });
  });
});

app.post('/api/admin/logout', requireAdmin, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('table-order.sid');
    res.json({ ok: true });
  });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const data = store.readStore();
  res.json({ orders: data.orders, settings: data.settings });
});

app.patch('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const status = cleanText(req.body.status, 20);
  if (!orderStatuses.has(status)) return apiError(res, 400, '注文ステータスが無効です。');
  if (!store.readOrder(req.params.id)) return apiError(res, 404, '注文が見つかりません。');
  res.json({ order: store.updateOrderStatus(req.params.id, status) });
});

app.get('/api/admin/menu', requireAdmin, (req, res) => {
  res.json({ menu: store.readStore().menu });
});

app.post('/api/admin/menu/:id/photo', requireAdmin, (req, res, next) => {
  uploadPhoto.single('photo')(req, res, (uploadError) => {
    if (uploadError) {
      if (uploadError.code === 'LIMIT_FILE_SIZE') return apiError(res, 413, '画像は5MB以下のファイルを選択してください。');
      if (uploadError.code === 'LIMIT_UNEXPECTED_FILE') return apiError(res, 400, 'アップロードする画像ファイルを1枚選択してください。');
      if (uploadError.message) return apiError(res, 400, uploadError.message);
      return next(uploadError);
    }
    if (!req.file) return apiError(res, 400, 'アップロードする画像を選択してください。');

    const extension = imageExtension(req.file.buffer, req.file.mimetype);
    if (!extension) return apiError(res, 400, '選択したファイルは有効なJPG、PNG、WebP画像ではありません。');

    const currentItem = store.readStore().menu.find((entry) => entry.id === req.params.id);
    if (!currentItem) return apiError(res, 404, 'メニューが見つかりません。');

    fs.mkdirSync(uploadsDirectory, { recursive: true });
    const filename = `${crypto.randomUUID()}.${extension}`;
    const imageUrl = `/uploads/${filename}`;
    const imagePath = path.join(uploadsDirectory, filename);
    try {
      fs.writeFileSync(imagePath, req.file.buffer, { flag: 'wx' });
      store.setMenuPhoto(req.params.id, imageUrl);
    } catch (error) {
      if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
      next(error);
      return;
    }
    try {
      removeUploadedImage(currentItem.imageUrl);
    } catch (error) {
      console.error(error);
    }
    res.status(201).json({ imageUrl });
  });
});

app.post('/api/admin/menu', requireAdmin, (req, res) => {
  const { name, category, description, emoji } = req.body;
  const price = Number(req.body.price);
  const cleanName = cleanText(name, 40);
  const cleanCategory = cleanText(category, 20);
  if (!cleanName || !cleanCategory || !validPrice(price)) {
    return apiError(res, 400, 'メニュー名、カテゴリー、正しい価格を入力してください。');
  }
  const item = {
    id: crypto.randomUUID(),
    name: cleanName,
    category: cleanCategory,
    description: cleanText(description, 120),
    emoji: cleanText(emoji, 4) || '🍽️',
    price: Math.round(price * 100) / 100
  };
  res.status(201).json({ item: store.createMenuItem(item) });
});

app.put('/api/admin/menu/:id', requireAdmin, (req, res) => {
  const existingItem = store.readStore().menu.find((entry) => entry.id === req.params.id);
  if (!existingItem) return apiError(res, 404, 'メニューが見つかりません。');
  const { name, category, description, emoji } = req.body;
  const price = Number(req.body.price);
  const cleanName = cleanText(name, 40);
  const cleanCategory = cleanText(category, 20);
  if (!cleanName || !cleanCategory || !validPrice(price)) {
    return apiError(res, 400, 'メニュー名、カテゴリー、正しい価格を入力してください。');
  }
  const item = store.updateMenuItem(req.params.id, {
    name: cleanName,
    category: cleanCategory,
    description: cleanText(description, 120),
    emoji: cleanText(emoji, 4) || '🍽️',
    price: Math.round(price * 100) / 100,
    available: req.body.available !== false
  });
  res.json({ item });
});

app.delete('/api/admin/menu/:id', requireAdmin, (req, res) => {
  const item = store.deleteMenuItem(req.params.id);
  if (!item) return apiError(res, 404, 'メニューが見つかりません。');
  try {
    removeUploadedImage(item.imageUrl);
  } catch (error) {
    console.error(error);
  }
  res.json({ ok: true });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const restaurantName = cleanText(req.body.restaurantName, 40);
  const announcement = cleanText(req.body.announcement, 120);
  const tableIds = Array.isArray(req.body.tableIds)
    ? [...new Set(req.body.tableIds.map((table) => cleanText(table, 12)).filter(Boolean))]
    : [];
  if (!restaurantName || tableIds.length < 1 || tableIds.length > 100) {
    return apiError(res, 400, '店舗名を入力し、有効なテーブル番号を1つ以上設定してください。');
  }
  res.json({ settings: store.updateSettings({ restaurantName, announcement, tableIds }) });
});

app.get('/api/admin/qr/:tableId', requireAdmin, async (req, res, next) => {
  try {
    const data = store.readStore();
    const tableId = cleanText(req.params.tableId, 12);
    if (!data.settings.tableIds.includes(tableId)) return apiError(res, 404, 'テーブル番号が見つかりません。');
    const baseUrl = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const orderUrl = `${baseUrl}/?table=${encodeURIComponent(tableId)}`;
    const svg = await QRCode.toString(orderUrl, { type: 'svg', margin: 2, width: 256, color: { dark: '#23352f', light: '#ffffff' } });
    res.type('image/svg+xml').send(svg);
  } catch (error) {
    next(error);
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/uploads/:filename', (req, res, next) => {
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(req.params.filename)) {
    return apiError(res, 404, '画像が見つかりません。');
  }
  res.sendFile(req.params.filename, { root: uploadsDirectory, dotfiles: 'deny' }, (error) => {
    if (error) next(error);
  });
});

app.use('/api', (error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'サーバーでエラーが発生しました。しばらくしてからもう一度お試しください。' });
});

store.initializeStore().then(() => {
  app.listen(port, '0.0.0.0', () => {
    console.log(`QRコード注文アプリを起動しました：http://localhost:${port}`);
    console.log(`管理画面：http://localhost:${port}/admin（初期パスワード：${process.env.ADMIN_PASSWORD ? '環境変数で設定済み' : '246810'}）`);
    console.log(`SQLiteデータベース：${store.databaseFile}`);
  });
}).catch((error) => {
  console.error('データベースの初期化に失敗しました。', error);
  process.exitCode = 1;
});
