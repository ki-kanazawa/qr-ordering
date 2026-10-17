require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const session = require('express-session');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const store = require('./lib/store');

const app = express();
const port = Number(process.env.PORT) || 3000;
const uploadsDirectory = path.join(__dirname, 'data', 'uploads');
const salesReportsDirectory = path.join(__dirname, 'file');
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

function japaneseDate(isoDate) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(isoDate));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function findJapanesePdfFont() {
  const fontPath = process.env.PDF_FONT_PATH || [
    'C:\\Windows\\Fonts\\NotoSansJP-VF.ttf',
    'C:\\Windows\\Fonts\\YuGothR.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansJP-Regular.ttf'
  ].find((candidate) => fs.existsSync(candidate));
  if (!fontPath || !fs.existsSync(fontPath)) {
    throw new Error('日本語PDF用フォントが見つかりません。PDF_FONT_PATH に日本語対応フォントを指定してください。');
  }
  return fontPath;
}

function createSalesPdf({ date, restaurantName, orders }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: { top: 32, bottom: 32, left: 32, right: 32 }
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    try {
      doc.registerFont('Japanese', findJapanesePdfFont());
      doc.font('Japanese').fillColor('#24352e');

      const salesOrders = orders.filter((order) => order.status !== 'cancelled');
      const revenue = salesOrders.reduce((sum, order) => sum + order.total, 0);
      const itemQuantity = salesOrders.reduce((sum, order) =>
        sum + order.items.reduce((orderQuantity, item) => orderQuantity + item.quantity, 0), 0);
      const cancelledCount = orders.length - salesOrders.length;
      const money = (value) => `￥${Math.round(value).toLocaleString('ja-JP')}`;
      const formatDate = date.replaceAll('-', '/');

      doc.fontSize(17).text(`${restaurantName} · 日次売上流水`, { align: 'center' });
      doc.moveDown(0.25);
      doc.fontSize(9).text(`対象日：${formatDate}`, { align: 'center' });
      doc.moveDown(1.1);
      doc.fontSize(11).text('売上集計');
      doc.moveDown(0.45);
      doc.fontSize(9)
        .text(`売上合計（取消を除く）：${money(revenue)}　　有効注文数：${salesOrders.length}件　　販売数量：${itemQuantity}点　　取消注文：${cancelledCount}件`);
      doc.moveDown(1);
      doc.fontSize(11).text('注文流水');
      doc.moveDown(0.4);

      const columns = [
        { title: '時刻', width: 48, value: (order) => new Date(order.createdAt).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }) },
        { title: '注文番号', width: 112, value: (order) => order.number },
        { title: 'テーブル・お名前', width: 105, value: (order) => `${order.tableId}\n${order.customerName}` },
        { title: '商品明細', width: 272, value: (order) => order.items.map((item) => `${item.name} × ${item.quantity}`).join('\n') },
        { title: '状況', width: 96, value: (order) => order.statusLabel },
        { title: '金額', width: 112, value: (order) => `${money(order.total)}${order.status === 'cancelled' ? '\n売上対象外' : ''}`, align: 'right' }
      ];
      const tableX = doc.page.margins.left;
      const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
      const cellPadding = 5;
      const fontSize = 8;
      const lineGap = 2;

      function drawTableHeader() {
        const top = doc.y;
        const height = 23;
        let x = tableX;
        doc.font('Japanese').fontSize(fontSize);
        for (const column of columns) {
          doc.rect(x, top, column.width, height).fillAndStroke('#edf1eb', '#b8c0ba');
          doc.fillColor('#24352e').text(column.title, x + cellPadding, top + 7, {
            width: column.width - cellPadding * 2,
            height: height - 8,
            lineBreak: false
          });
          x += column.width;
        }
        doc.y = top + height;
      }

      drawTableHeader();
      if (!orders.length) {
        doc.font('Japanese').fontSize(9).text('選択した日の注文流水はありません。', tableX, doc.y + 10);
      }

      for (const order of orders) {
        const values = columns.map((column) => column.value(order));
        const rowHeight = Math.max(...values.map((value, index) =>
          doc.heightOfString(value, {
            width: columns[index].width - cellPadding * 2,
            font: 'Japanese',
            fontSize,
            lineGap
          }))) + cellPadding * 2;
        if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
          doc.addPage();
          drawTableHeader();
        }

        const top = doc.y;
        let x = tableX;
        columns.forEach((column, index) => {
          doc.rect(x, top, column.width, rowHeight)
            .fillAndStroke(order.status === 'cancelled' ? '#f4f4f2' : '#ffffff', '#c8ceca');
          doc.fillColor(order.status === 'cancelled' ? '#737a75' : '#24352e')
            .font('Japanese')
            .fontSize(fontSize)
            .text(values[index], x + cellPadding, top + cellPadding, {
              width: column.width - cellPadding * 2,
              height: rowHeight - cellPadding * 2,
              lineGap,
              align: column.align || 'left'
            });
          x += column.width;
        });
        doc.y = top + rowHeight;
      }

      doc.moveDown(0.8);
      doc.font('Japanese').fontSize(10).fillColor('#24352e')
        .text(`売上合計（取消を除く）：${money(revenue)}`, tableX + tableWidth - 220, doc.y, { width: 220, align: 'right' });
      doc.moveDown(0.8);
      doc.fontSize(8).fillColor('#64716a')
        .text(`印刷日時：${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`, { align: 'right' });
      doc.end();
    } catch (error) {
      doc.destroy(error);
    }
  });
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
  const tableId = cleanText(req.query.table, 12);
  const tableSession = data.settings.tableIds.includes(tableId)
    ? store.readPublicTableSession(tableId)
    : null;
  res.json({ settings: data.settings, menu: data.menu.filter((item) => item.available), tableSession });
});

app.get('/api/tables/:tableId/session', (req, res) => {
  const data = store.readStore();
  const tableId = cleanText(req.params.tableId, 12);
  if (!data.settings.tableIds.includes(tableId)) return apiError(res, 404, 'テーブル番号が見つかりません。');
  res.json({ tableSession: store.readPublicTableSession(tableId) });
});

app.post('/api/tables/:tableId/checkout', orderRateLimit, (req, res) => {
  try {
    const tableSession = store.requestTableCheckout(cleanText(req.params.tableId, 12));
    res.json({ tableSession });
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    throw error;
  }
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
  res.json({ orders: data.orders, settings: data.settings, tableSessions: store.readTableSessions() });
});

app.post('/api/admin/tables/:tableId/settle', requireAdmin, (req, res, next) => {
  try {
    res.json({ tableSession: store.settleTable(cleanText(req.params.tableId, 12)) });
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    next(error);
  }
});

app.post('/api/admin/tables/:tableId/resume', requireAdmin, (req, res, next) => {
  try {
    res.json({ tableSession: store.resumeTableOrders(cleanText(req.params.tableId, 12)) });
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    next(error);
  }
});

app.post('/api/admin/tables/:tableId/reopen', requireAdmin, (req, res, next) => {
  try {
    res.json({ tableSession: store.reopenTable(cleanText(req.params.tableId, 12)) });
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    next(error);
  }
});

app.get('/api/admin/sales/:date.pdf', requireAdmin, async (req, res, next) => {
  const { date } = req.params;
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
  if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    return apiError(res, 400, '売上日付の形式が正しくありません。');
  }

  try {
    const data = store.readStore();
    const orders = data.orders
      .filter((order) => japaneseDate(order.createdAt) === date)
      .sort((first, second) => second.createdAt.localeCompare(first.createdAt));
    const fileName = `売上_${date.replaceAll('-', '')}.pdf`;
    const outputPath = path.join(salesReportsDirectory, fileName);
    const temporaryPath = `${outputPath}.${crypto.randomUUID()}.tmp`;
    const pdf = await createSalesPdf({
      date,
      restaurantName: data.settings.restaurantName,
      orders
    });
    await fs.promises.mkdir(salesReportsDirectory, { recursive: true });
    await fs.promises.writeFile(temporaryPath, pdf);
    await fs.promises.rename(temporaryPath, outputPath);
    res.set('Cache-Control', 'private, no-store');
    res.download(outputPath, fileName, (error) => {
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    next(error);
  }
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
