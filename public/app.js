const appRoot = document.querySelector('#app');
const toastRoot = document.querySelector('#toast');
const state = {
  menu: [],
  settings: null,
  category: 'すべて',
  search: '',
  cart: loadCart(),
  tableId: new URLSearchParams(location.search).get('table') || '',
  trackedOrderId: localStorage.getItem('table-order:last-order') || '',
  pendingOrder: null,
  toastTimer: null,
  pollTimer: null
};

function loadCart() {
  try {
    const saved = JSON.parse(localStorage.getItem('table-order:cart') || '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

function loadOrderHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem('table-order:order-history') || '[]');
    return Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function saveCart() {
  localStorage.setItem('table-order:cart', JSON.stringify(state.cart));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function money(amount) {
  return `￥${new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 }).format(Number(amount))}`;
}

function showToast(message) {
  toastRoot.textContent = message;
  toastRoot.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toastRoot.classList.remove('show'), 2600);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(payload?.error || 'リクエストに失敗しました。しばらくしてからもう一度お試しください。');
  return payload;
}

function cartQuantity() {
  return Object.values(state.cart).reduce((sum, quantity) => sum + quantity, 0);
}

function cartTotal() {
  return state.menu.reduce((sum, item) => sum + item.price * (state.cart[item.id] || 0), 0);
}

async function boot() {
  if (location.pathname === '/admin') {
    await renderAdmin();
    return;
  }
  try {
    const data = await api('/api/menu');
    state.menu = data.menu;
    state.settings = data.settings;
    if (!state.tableId || !state.settings.tableIds.includes(state.tableId)) {
      state.tableId = state.settings.tableIds[0] || '';
      if (new URLSearchParams(location.search).has('table')) {
        showToast('テーブル番号が無効なため、初期テーブルに切り替えました。');
      }
    }
    renderCustomer();
    if (state.trackedOrderId) {
      trackOrder(state.trackedOrderId, false);
      startOrderPolling();
    }
  } catch (error) {
    appRoot.innerHTML = `<main class="page-width empty-state"><h2>メニューを読み込めません</h2><p>${escapeHtml(error.message)}</p><button class="primary-button" onclick="location.reload()">再読み込み</button></main>`;
  }
}

function renderCustomer() {
  document.title = `${state.settings.restaurantName} · QRコード注文`;
  const categories = ['すべて', ...new Set(state.menu.map((item) => item.category))];
  const filteredMenu = state.menu.filter((item) => {
    const categoryMatches = state.category === 'すべて' || item.category === state.category;
    const query = state.search.trim().toLowerCase();
    return categoryMatches && (!query || `${item.name} ${item.category} ${item.description}`.toLowerCase().includes(query));
  });
  const tableLabel = state.tableId ? `テーブル ${state.tableId}` : 'テーブルを選択';

  appRoot.innerHTML = `
    <main class="page-width">
      <header class="topbar">
        <a class="brand" href="/" aria-label="${escapeHtml(state.settings.restaurantName)} トップ"><span class="brand-mark">こ</span>${escapeHtml(state.settings.restaurantName)}</a>
        <div class="top-actions">
          <span class="table-pill">▦ ${escapeHtml(tableLabel)}</span>
          <button class="quiet-button" data-action="history">注文履歴</button>
        </div>
      </header>
      <section class="hero">
        <div class="hero-copy">
          <p class="eyebrow">GOOD FOOD, GOOD MOOD</p>
          <h1>今日のごはんを、<br>ゆっくり楽しもう。</h1>
          <p>${escapeHtml(state.settings.announcement || 'お好きなメニューをお選びください。')}</p>
        </div>
        <div class="hero-stamp" aria-hidden="true">☘</div>
      </section>
      <section aria-label="メニュー">
        <div class="menu-heading">
          <div><h2>メニュー</h2><p>旬の食材を、できたてで。</p></div>
          <label class="search-box"><span>⌕</span><input id="menu-search" placeholder="メニューを検索" value="${escapeHtml(state.search)}" aria-label="メニューを検索"></label>
        </div>
        <nav class="category-list" aria-label="カテゴリー">
          ${categories.map((category) => `<button class="category-button ${category === state.category ? 'active' : ''}" data-action="category" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join('')}
        </nav>
        <div class="menu-grid">
          ${filteredMenu.length ? filteredMenu.map((item) => `
            <article class="dish-card">
              <div class="dish-art" aria-hidden="true">${escapeHtml(item.emoji)}${item.imageUrl ? `<img data-photo src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy">` : ''}</div>
              <div class="dish-info">
                <div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.description)}</p></div>
                <div class="dish-bottom">
                  <span class="price">${money(item.price)}</span>
                  ${(state.cart[item.id] || 0) ? `
                    <div class="quantity-control menu-quantity-control" aria-label="${escapeHtml(item.name)}の注文数">
                      <button data-action="change-quantity" data-id="${escapeHtml(item.id)}" data-change="-1" aria-label="${escapeHtml(item.name)}の数量を減らす">−</button>
                      <span aria-live="polite">${state.cart[item.id]}</span>
                      <button data-action="change-quantity" data-id="${escapeHtml(item.id)}" data-change="1" aria-label="${escapeHtml(item.name)}の数量を増やす">+</button>
                    </div>` : `<button class="add-button" data-action="add" data-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.name)}を追加">+</button>`}
                </div>
              </div>
            </article>`).join('') : '<div class="empty-state">該当するメニューがありません。別のキーワードでお試しください。</div>'}
        </div>
      </section>
      <footer class="footer"><span>おいしい料理を、心を込めて。 · ${escapeHtml(state.settings.restaurantName)}</span><a href="/admin">スタッフログイン ↗</a></footer>
    </main>
    ${cartQuantity() ? `
      <div class="cart-bar"><button class="cart-button" data-action="open-cart">
        <span class="cart-icon">🛍<span class="cart-count">${cartQuantity()}</span></span>
        <span>カートを見る</span>
        <span class="cart-total"><strong>${money(cartTotal())}</strong><small>小計</small></span>
        <span class="cart-cta">注文へ →</span>
      </button></div>` : ''}
    <div class="overlay" id="customer-overlay" hidden></div>`;
  bindCustomerEvents();
  handlePhotoErrors(appRoot);
}

function handlePhotoErrors(root) {
  root.querySelectorAll('img[data-photo]').forEach((image) => {
    image.addEventListener('error', () => image.remove(), { once: true });
  });
}

function bindCustomerEvents() {
  appRoot.querySelector('#menu-search')?.addEventListener('input', (event) => {
    state.search = event.target.value;
    const position = event.target.selectionStart;
    renderCustomer();
    const input = appRoot.querySelector('#menu-search');
    input.focus();
    input.setSelectionRange(position, position);
  });
}

function createIdempotencyKey() {
  const bytes = new Uint8Array(16);
  if (window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function customerClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) {
    if (event.target.id === 'customer-overlay') closeCustomerOverlay();
    return;
  }
  const action = button.dataset.action;
  if (action === 'category') {
    state.category = button.dataset.category;
    renderCustomer();
  } else if (action === 'add') {
    state.cart[button.dataset.id] = (state.cart[button.dataset.id] || 0) + 1;
    saveCart();
    renderCustomer();
    showToast('カートに追加しました');
  } else if (action === 'open-cart') {
    renderCartOverlay();
  } else if (action === 'close-overlay') {
    closeCustomerOverlay();
  } else if (action === 'change-quantity') {
    const id = button.dataset.id;
    const change = Number(button.dataset.change);
    state.cart[id] = (state.cart[id] || 0) + change;
    if (state.cart[id] <= 0) delete state.cart[id];
    saveCart();
    if (button.closest('.cart-line')) renderCartOverlay();
    else renderCustomer();
  } else if (action === 'submit-order') {
    submitOrder();
  } else if (action === 'history') {
    showOrderHistory();
  } else if (action === 'track-order') {
    trackOrder(button.dataset.id);
  }
}

function closeCustomerOverlay() {
  const overlay = appRoot.querySelector('#customer-overlay');
  if (overlay) {
    overlay.hidden = true;
    overlay.innerHTML = '';
  }
}

function renderCartOverlay() {
  const overlay = appRoot.querySelector('#customer-overlay');
  const items = state.menu.filter((item) => state.cart[item.id]);
  overlay.hidden = false;
  if (!items.length) {
    overlay.innerHTML = `<section class="drawer"><div class="drawer-head"><div><h2>カート</h2><p>メニューがまだ選択されていません</p></div><button class="icon-button" data-action="close-overlay" aria-label="閉じる">×</button></div><button class="primary-button" data-action="close-overlay">メニューを見る</button></section>`;
    return;
  }
  overlay.innerHTML = `
    <section class="drawer" role="dialog" aria-modal="true" aria-labelledby="cart-title">
      <div class="drawer-head"><div><h2 id="cart-title">ご注文内容</h2><p>数量をご確認ください</p></div><button class="icon-button" data-action="close-overlay" aria-label="閉じる">×</button></div>
      <div class="cart-lines">
        ${items.map((item) => `<div class="cart-line">
          <span class="cart-line-emoji">${escapeHtml(item.emoji)}</span>
          <div><h3>${escapeHtml(item.name)}</h3><p>${money(item.price * state.cart[item.id])}</p></div>
          <div class="quantity-control"><button data-action="change-quantity" data-id="${escapeHtml(item.id)}" data-change="-1" aria-label="数量を減らす">−</button><span>${state.cart[item.id]}</span><button data-action="change-quantity" data-id="${escapeHtml(item.id)}" data-change="1" aria-label="数量を増やす">+</button></div>
        </div>`).join('')}
      </div>
      <div class="checkout-fields">
        <div class="field"><label for="checkout-table">テーブル番号</label><select id="checkout-table">${state.settings.tableIds.map((table) => `<option value="${escapeHtml(table)}" ${table === state.tableId ? 'selected' : ''}>テーブル ${escapeHtml(table)}</option>`).join('')}</select></div>
        <div class="field"><label for="customer-name">お名前（任意）</label><input id="customer-name" maxlength="40" placeholder="お呼びするお名前"></div>
        <div class="field full"><label for="order-note">ご要望（任意）</label><textarea id="order-note" maxlength="300" placeholder="例：辛さ控えめ、ねぎ抜き"></textarea></div>
      </div>
      <div class="payment-note">💳 お支払い方法：<strong>店頭払い</strong><br>ご注文後、店頭でお支払いください。オンライン決済には対応していません。</div>
      <button class="primary-button checkout-submit" data-action="submit-order">注文を確定 · ${money(cartTotal())}</button>
    </section>`;
}

async function submitOrder() {
  const button = appRoot.querySelector('[data-action="submit-order"]');
  if (!button) return;
  button.disabled = true;
  button.textContent = '送信中…';
  const orderPayload = {
    tableId: appRoot.querySelector('#checkout-table').value,
    customerName: appRoot.querySelector('#customer-name').value,
    note: appRoot.querySelector('#order-note').value,
    items: state.menu.filter((item) => state.cart[item.id]).map((item) => ({ id: item.id, quantity: state.cart[item.id] }))
  };
  const fingerprint = JSON.stringify(orderPayload);
  if (!state.pendingOrder || state.pendingOrder.fingerprint !== fingerprint) {
    state.pendingOrder = { fingerprint, key: createIdempotencyKey() };
  }
  try {
    const result = await api('/api/orders', {
      method: 'POST',
      headers: { 'Idempotency-Key': state.pendingOrder.key },
      body: JSON.stringify(orderPayload)
    });
    state.pendingOrder = null;
    state.cart = {};
    saveCart();
    state.tableId = result.order.tableId;
    state.trackedOrderId = result.order.id;
    localStorage.setItem('table-order:last-order', result.order.id);
    const orderIds = loadOrderHistory();
    localStorage.setItem('table-order:order-history', JSON.stringify([result.order.id, ...orderIds.filter((id) => id !== result.order.id)].slice(0, 10)));
    renderCustomer();
    renderOrderStatus(result.order);
    startOrderPolling();
  } catch (error) {
    button.disabled = false;
    button.textContent = `注文を確定 · ${money(cartTotal())}`;
    showToast(error.message);
  }
}

function renderOrderStatus(order) {
  const overlay = appRoot.querySelector('#customer-overlay');
  const sequence = ['pending', 'preparing', 'ready', 'completed'];
  const currentIndex = sequence.indexOf(order.status);
  const steps = [
    ['pending', '注文受付'],
    ['preparing', '調理中'],
    ['ready', 'お渡し準備完了'],
    ['completed', '受取済み']
  ];
  const statusMessage = order.status === 'cancelled' ? 'この注文はキャンセルされました。ご不明な点はスタッフまでお声がけください。' : `テーブル ${escapeHtml(order.tableId)} · ${escapeHtml(order.statusLabel)}`;
  overlay.hidden = false;
  overlay.innerHTML = `
    <section class="drawer" role="dialog" aria-modal="true" aria-labelledby="order-title">
      <div class="drawer-head"><span></span><button class="icon-button" data-action="close-overlay" aria-label="閉じる">×</button></div>
      <div class="order-panel">
        <span class="order-success">${order.status === 'cancelled' ? '!' : '✓'}</span>
        <div class="order-number"><h2 id="order-title">${order.status === 'cancelled' ? '注文はキャンセルされました' : 'ご注文ありがとうございます'}</h2><p>${statusMessage}</p><p>注文番号 ${escapeHtml(order.number)}</p></div>
        ${order.status !== 'cancelled' ? `<div class="status-track">${steps.map(([status, label], index) => `<div class="status-step ${currentIndex >= index ? 'done' : ''}">${label}</div>`).join('')}</div>` : ''}
        <div class="order-summary">
          ${order.items.map((item) => `<div class="order-summary-row"><span>${escapeHtml(item.emoji)} ${escapeHtml(item.name)} × ${item.quantity}</span><span>${money(item.price * item.quantity)}</span></div>`).join('')}
          <div class="order-summary-row total"><span>店頭払い</span><span>${money(order.total)}</span></div>
        </div>
        <button class="primary-button checkout-submit" data-action="close-overlay">メニューに戻る</button>
      </div>
    </section>`;
}

async function trackOrder(orderId, open = true) {
  try {
    const { order } = await api(`/api/orders/${encodeURIComponent(orderId)}`);
    state.trackedOrderId = order.id;
    localStorage.setItem('table-order:last-order', order.id);
    if (open) renderOrderStatus(order);
  } catch (error) {
    showToast(error.message);
  }
}

function startOrderPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (!state.trackedOrderId) return;
    try {
      const { order } = await api(`/api/orders/${encodeURIComponent(state.trackedOrderId)}`);
      const overlay = appRoot.querySelector('#customer-overlay');
      if (!overlay.hidden && overlay.querySelector('.order-panel')) renderOrderStatus(order);
      if (['completed', 'cancelled'].includes(order.status)) clearInterval(state.pollTimer);
    } catch (error) {
      clearInterval(state.pollTimer);
      showToast(error.message);
    }
  }, 6000);
}

async function showOrderHistory() {
  const ids = loadOrderHistory();
  const overlay = appRoot.querySelector('#customer-overlay');
  overlay.hidden = false;
  if (!ids.length) {
    overlay.innerHTML = `<section class="drawer"><div class="drawer-head"><div><h2>注文履歴</h2><p>最近の注文をここで確認できます</p></div><button class="icon-button" data-action="close-overlay" aria-label="閉じる">×</button></div><div class="empty-state">注文履歴はありません。</div><button class="primary-button" data-action="close-overlay">メニューを見る</button></section>`;
    return;
  }
  overlay.innerHTML = `<section class="drawer"><div class="drawer-head"><div><h2>注文履歴</h2><p>注文を選択して進行状況を確認できます</p></div><button class="icon-button" data-action="close-overlay" aria-label="閉じる">×</button></div><div class="admin-order-list" id="history-list">注文履歴を読み込んでいます…</div></section>`;
  const history = await Promise.all(ids.slice(0, 10).map(async (id) => {
    try { return (await api(`/api/orders/${encodeURIComponent(id)}`)).order; } catch { return null; }
  }));
  const list = overlay.querySelector('#history-list');
  if (!list) return;
  const orders = history.filter(Boolean);
  list.innerHTML = orders.length ? orders.map((order) => `
    <button class="admin-order" data-action="track-order" data-id="${escapeHtml(order.id)}" style="width:100%;background:white;text-align:left">
      <span><strong>${escapeHtml(order.number)}</strong><p>テーブル ${escapeHtml(order.tableId)} · ${new Date(order.createdAt).toLocaleString('ja-JP')}<br>${order.items.map((item) => `${escapeHtml(item.name)} × ${item.quantity}`).join('、')}</p></span>
      <span class="admin-order-side"><strong>${money(order.total)}</strong><span class="tag">${escapeHtml(order.statusLabel)}</span></span>
    </button>`).join('') : '<div class="empty-state">注文履歴が見つかりません。</div>';
}

async function renderAdmin() {
  document.title = '店舗管理 · こまち食堂';
  appRoot.innerHTML = `<div class="admin-page"><div class="admin-shell"><header class="admin-header"><a class="admin-title" href="/"><span class="brand-mark">こ</span><span><h1>店舗管理</h1><p>QRコード注文 · スタッフ用</p></span></a><a class="quiet-button" href="/">注文ページへ ↗</a></header><main class="admin-main" id="admin-main"><div class="loading-screen">管理画面に接続しています…</div></main></div></div>`;
  try {
    const data = await api('/api/admin/orders');
    renderDashboard(data);
    startAdminPolling();
  } catch (error) {
    renderAdminLogin();
  }
}

function renderAdminLogin(message = '') {
  const main = document.querySelector('#admin-main');
  main.innerHTML = `<div class="login-wrap"><form class="login-card" id="login-form">
    <span class="brand-mark">こ</span><h2>おかえりなさい</h2><p>管理パスワードを入力してください。</p>
    ${message ? `<div class="inline-alert">${escapeHtml(message)}</div>` : ''}
    <div class="field"><label for="admin-password">管理パスワード</label><input id="admin-password" type="password" required autocomplete="current-password" placeholder="パスワードを入力"></div>
    <button class="primary-button" type="submit">ログイン</button>
    <div class="login-hint">初期パスワードは 246810 です。公開前に .env の ADMIN_PASSWORD を変更してください。</div>
  </form></div>`;
  main.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('button');
    submit.disabled = true;
    try {
      await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: main.querySelector('#admin-password').value }) });
      await renderAdmin();
    } catch (error) {
      renderAdminLogin(error.message);
    }
  });
}

let adminState = { orders: [], menu: [], settings: null, tab: 'orders', orderFilter: 'all', editingId: '' };
let adminTimer = null;

function renderDashboard(data) {
  adminState.orders = data.orders;
  adminState.settings = data.settings;
  if (adminState.tab === 'menu' && !adminState.menu.length) loadAdminMenu();
  const main = document.querySelector('#admin-main');
  if (!main) return;
  main.innerHTML = `
    <nav class="admin-tabs">
      ${[['orders', '📋 注文管理'], ['menu', '🍽 メニュー管理'], ['tables', '▦ テーブル・QRコード']].map(([tab, label]) => `<button class="admin-tab ${adminState.tab === tab ? 'active' : ''}" data-action="admin-tab" data-tab="${tab}">${label}</button>`).join('')}
      <button class="admin-tab" style="margin-left:auto" data-action="logout">ログアウト</button>
    </nav>
    <section id="admin-panel"></section>`;
  main.querySelector('.admin-tabs').addEventListener('click', adminClick);
  renderAdminPanel();
}

function renderAdminPanel() {
  const panel = document.querySelector('#admin-panel');
  if (!panel) return;
  if (adminState.tab === 'orders') renderOrdersPanel(panel);
  if (adminState.tab === 'menu') renderMenuPanel(panel);
  if (adminState.tab === 'tables') renderTablesPanel(panel);
}

function renderOrdersPanel(panel) {
  const now = new Date().toLocaleDateString('en-CA');
  const todaysOrders = adminState.orders.filter((order) => order.createdAt.slice(0, 10) === now && order.status !== 'cancelled');
  const revenue = todaysOrders.filter((order) => order.status !== 'cancelled').reduce((sum, order) => sum + order.total, 0);
  const pending = adminState.orders.filter((order) => order.status === 'pending').length;
  const visibleOrders = adminState.orders.filter((order) => adminState.orderFilter === 'all' || order.status === adminState.orderFilter);
  panel.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><span>本日の注文数</span><strong>${todaysOrders.length}</strong></div>
      <div class="stat-card"><span>受付待ち</span><strong>${pending}</strong></div>
      <div class="stat-card"><span>本日の売上</span><strong>${money(revenue)}</strong></div>
    </div>
    <div class="admin-panel">
      <div class="section-title-row"><div><h2>注文一覧</h2><p>注文状況の変更はお客様の画面にも自動で反映されます。</p></div>
        <select id="order-filter" aria-label="注文を絞り込む">
          ${[['all', 'すべて'], ['pending', '受付待ち'], ['preparing', '調理中'], ['ready', 'お渡し準備完了'], ['completed', '受取済み'], ['cancelled', 'キャンセル']].map(([value, label]) => `<option value="${value}" ${adminState.orderFilter === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>
      <div class="admin-order-list">${visibleOrders.length ? visibleOrders.map((order) => renderAdminOrder(order)).join('') : '<div class="empty-state">該当する注文はありません。</div>'}</div>
    </div>`;
  panel.querySelector('#order-filter').addEventListener('change', (event) => {
    adminState.orderFilter = event.target.value;
    renderAdminPanel();
  });
  panel.querySelectorAll('[data-action="set-order-status"]').forEach((select) => {
    select.addEventListener('change', async (event) => {
      try {
        await api(`/api/admin/orders/${encodeURIComponent(event.target.dataset.id)}`, { method: 'PATCH', body: JSON.stringify({ status: event.target.value }) });
        await refreshAdmin();
        showToast('注文状況を更新しました');
      } catch (error) { showToast(error.message); }
    });
  });
}

function renderAdminOrder(order) {
  const date = new Date(order.createdAt).toLocaleString('ja-JP');
  const statuses = [['pending', '受付待ち'], ['preparing', '調理中'], ['ready', 'お渡し準備完了'], ['completed', '受取済み'], ['cancelled', 'キャンセル']];
  return `<article class="admin-order">
    <div><h3>${escapeHtml(order.number)} <span class="tag">${escapeHtml(order.statusLabel)}</span></h3>
      <p>テーブル ${escapeHtml(order.tableId)} · ${escapeHtml(order.customerName)} · ${date}<br>
      ${order.items.map((item) => `${escapeHtml(item.emoji)} ${escapeHtml(item.name)} × ${item.quantity}`).join('、')}
      ${order.note ? `<br>ご要望：${escapeHtml(order.note)}` : ''}</p></div>
    <div class="admin-order-side"><strong>${money(order.total)}</strong>
      <select data-action="set-order-status" data-id="${escapeHtml(order.id)}" aria-label="注文状況を更新">
        ${statuses.map(([value, label]) => `<option value="${value}" ${order.status === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </div>
  </article>`;
}

async function loadAdminMenu() {
  try {
    adminState.menu = (await api('/api/admin/menu')).menu;
    renderAdminPanel();
  } catch (error) { showToast(error.message); }
}

let photoPreviewUrl = '';

function renderMenuPanel(panel) {
  if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
  photoPreviewUrl = '';
  panel.innerHTML = `<div class="admin-panel">
    <div class="section-title-row"><div><h2>メニュー管理</h2><p>メニューのカテゴリー、価格、販売状況を管理します。</p></div><button class="primary-button" data-action="new-menu-item">＋ メニューを追加</button></div>
    <form class="menu-form" id="menu-form" hidden>
      <div class="field"><label for="dish-name">メニュー名</label><input id="dish-name" name="name" maxlength="40" required></div>
      <div class="field"><label for="dish-category">カテゴリー</label><input id="dish-category" name="category" maxlength="20" list="categories" required><datalist id="categories">${[...new Set(adminState.menu.map((item) => item.category))].map((category) => `<option value="${escapeHtml(category)}">`).join('')}</datalist></div>
      <div class="field"><label for="dish-price">価格（円）</label><input id="dish-price" name="price" type="number" min="0" step="1" required></div>
      <div class="field"><label for="dish-emoji">アイコン</label><input id="dish-emoji" name="emoji" maxlength="4" value="🍽️"></div>
      <div class="field description-field"><label for="dish-description">説明</label><input id="dish-description" name="description" maxlength="120"></div>
      <div class="field photo-field"><label for="dish-photo">メニュー写真（JPG・PNG・WebP、5MBまで）</label><input id="dish-photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp"><div id="photo-preview" class="photo-preview" aria-live="polite">写真を選択するとプレビューが表示されます</div></div>
      <div class="menu-form-actions"><button type="button" class="small-button" data-action="cancel-menu-edit">キャンセル</button><button type="submit" class="primary-button">保存</button></div>
    </form>
    <div class="admin-menu-list">${adminState.menu.length ? adminState.menu.map((item) => `
      <article class="admin-menu-row"><span class="admin-menu-emoji">${escapeHtml(item.emoji)}${item.imageUrl ? `<img data-photo src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy">` : ''}</span>
        <div><h3>${escapeHtml(item.name)} <span class="tag ${item.available ? '' : 'offline'}">${item.available ? '販売中' : '販売停止'}</span></h3><p>${escapeHtml(item.category)} · ${money(item.price)} · 販売数 ${item.sold || 0}</p></div>
        <div class="admin-actions"><button class="small-button" data-action="edit-menu-item" data-id="${escapeHtml(item.id)}">編集</button><button class="small-button" data-action="toggle-menu-item" data-id="${escapeHtml(item.id)}">${item.available ? '販売停止' : '販売開始'}</button><button class="small-button danger" data-action="delete-menu-item" data-id="${escapeHtml(item.id)}">削除</button></div>
      </article>`).join('') : '<div class="empty-state">メニューがありません。「メニューを追加」から登録してください。</div>'}</div>
  </div>`;
  panel.querySelector('[data-action="new-menu-item"]').addEventListener('click', () => openMenuForm());
  panel.querySelector('[data-action="cancel-menu-edit"]').addEventListener('click', () => openMenuForm(null, false));
  panel.querySelector('#menu-form').addEventListener('submit', saveMenuItem);
  panel.querySelector('#dish-photo').addEventListener('change', previewMenuPhoto);
  panel.querySelectorAll('[data-action="edit-menu-item"]').forEach((button) => button.addEventListener('click', () => openMenuForm(button.dataset.id)));
  panel.querySelectorAll('[data-action="toggle-menu-item"]').forEach((button) => button.addEventListener('click', () => toggleMenuItem(button.dataset.id)));
  panel.querySelectorAll('[data-action="delete-menu-item"]').forEach((button) => button.addEventListener('click', () => deleteMenuItem(button.dataset.id)));
  handlePhotoErrors(panel);
}

function openMenuForm(id = null, show = true) {
  const form = document.querySelector('#menu-form');
  if (!form) return;
  form.hidden = !show;
  adminState.editingId = id || '';
  form.reset();
  if (id) {
    const item = adminState.menu.find((entry) => entry.id === id);
    if (!item) return;
    for (const key of ['name', 'category', 'price', 'emoji', 'description']) form.elements[key].value = item[key];
    if (item.imageUrl) {
      form.querySelector('#photo-preview').innerHTML = `<img src="${escapeHtml(item.imageUrl)}" alt="現在のメニュー写真">`;
      handlePhotoErrors(form);
    } else {
      form.querySelector('#photo-preview').textContent = '写真を選択するとプレビューが表示されます';
    }
  } else {
    form.querySelector('#photo-preview').textContent = '写真を選択するとプレビューが表示されます';
  }
  if (show) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function previewMenuPhoto(event) {
  const file = event.currentTarget.files[0];
  const preview = document.querySelector('#photo-preview');
  if (!preview) return;
  if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
  photoPreviewUrl = '';
  if (!file) {
    preview.textContent = '写真を選択するとプレビューが表示されます';
    return;
  }
  photoPreviewUrl = URL.createObjectURL(file);
  preview.innerHTML = `<img src="${photoPreviewUrl}" alt="選択したメニュー写真のプレビュー">`;
}

async function saveMenuItem(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const photo = form.elements.photo.files[0];
  const data = Object.fromEntries(new FormData(form).entries());
  delete data.photo;
  data.price = Number(data.price);
  const id = adminState.editingId;
  let savedId = id;
  try {
    const saved = await api(id ? `/api/admin/menu/${encodeURIComponent(id)}` : '/api/admin/menu', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify({ ...data, available: id ? adminState.menu.find((item) => item.id === id).available : true })
    });
    savedId = savedId || saved.item.id;
    if (photo) {
      const formData = new FormData();
      formData.append('photo', photo);
      await api(`/api/admin/menu/${encodeURIComponent(savedId)}/photo`, { method: 'POST', body: formData });
    }
    adminState.menu = (await api('/api/admin/menu')).menu;
    adminState.editingId = '';
    renderAdminPanel();
    showToast(photo ? 'メニューと写真を保存しました' : 'メニューを保存しました');
  } catch (error) {
    if (savedId) {
      try {
        adminState.menu = (await api('/api/admin/menu')).menu;
        adminState.editingId = '';
        renderAdminPanel();
        showToast(`メニューは保存されましたが、写真をアップロードできませんでした：${error.message}`);
      } catch (refreshError) {
        showToast(`メニューは保存されましたが、写真をアップロードできませんでした：${error.message} メニューの再読み込みにも失敗しました：${refreshError.message}`);
      }
    } else {
      showToast(error.message);
    }
  }
}

async function toggleMenuItem(id) {
  const item = adminState.menu.find((entry) => entry.id === id);
  if (!item) return;
  try {
    await api(`/api/admin/menu/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ ...item, available: !item.available }) });
    adminState.menu = (await api('/api/admin/menu')).menu;
    renderAdminPanel();
    showToast(item.available ? '販売を停止しました' : '販売を開始しました');
  } catch (error) { showToast(error.message); }
}

async function deleteMenuItem(id) {
  const item = adminState.menu.find((entry) => entry.id === id);
  if (!item || !confirm(`「${item.name}」を削除しますか？`)) return;
  try {
    await api(`/api/admin/menu/${encodeURIComponent(id)}`, { method: 'DELETE' });
    adminState.menu = (await api('/api/admin/menu')).menu;
    renderAdminPanel();
    showToast('メニューを削除しました');
  } catch (error) { showToast(error.message); }
}

function renderTablesPanel(panel) {
  const settings = adminState.settings;
  panel.innerHTML = `<div class="admin-panel">
    <h2>店舗・テーブル設定</h2><p>店舗情報とテーブル番号を設定し、QRコードをダウンロードまたは印刷できます。</p>
    <form id="settings-form">
      <div class="table-settings">
        <div class="field"><label for="restaurant-name">店舗名</label><input id="restaurant-name" maxlength="40" required value="${escapeHtml(settings.restaurantName)}"></div>
        <div class="field"><label for="restaurant-announcement">お知らせ</label><input id="restaurant-announcement" maxlength="120" value="${escapeHtml(settings.announcement || '')}"></div>
      </div>
      <div class="field"><label for="table-ids">テーブル番号（カンマまたは改行で区切る）</label><textarea id="table-ids" required>${escapeHtml(settings.tableIds.join(', '))}</textarea></div>
      <div class="menu-form-actions" style="margin-top:12px"><button class="primary-button" type="submit">設定を保存</button></div>
    </form>
    <div class="section-title-row" style="margin-top:28px"><div><h2>テーブル別QRコード</h2><p>読み取るとテーブル番号が自動入力されます。お客様の端末からアクセスできるURLを設定してください。</p></div><button class="small-button" data-action="print-qrs">QRコードを印刷</button></div>
    <div class="qr-grid">${settings.tableIds.map((table) => `<article class="qr-card"><img src="/api/admin/qr/${encodeURIComponent(table)}" alt="テーブル ${escapeHtml(table)} の注文用QRコード"><strong>テーブル ${escapeHtml(table)}</strong><a class="small-button" href="/api/admin/qr/${encodeURIComponent(table)}" download="${escapeHtml(table)}-qr.svg">SVGをダウンロード</a></article>`).join('')}</div>
  </div>`;
  panel.querySelector('#settings-form').addEventListener('submit', saveSettings);
  panel.querySelector('[data-action="print-qrs"]').addEventListener('click', () => window.print());
}

async function saveSettings(event) {
  event.preventDefault();
  const tableIds = document.querySelector('#table-ids').value.split(/[,\n，]+/).map((table) => table.trim()).filter(Boolean);
  try {
    const result = await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({
        restaurantName: document.querySelector('#restaurant-name').value,
        announcement: document.querySelector('#restaurant-announcement').value,
        tableIds
      })
    });
    adminState.settings = result.settings;
    renderAdminPanel();
    showToast('店舗設定を保存しました');
  } catch (error) { showToast(error.message); }
}

function adminClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'admin-tab') {
    adminState.tab = button.dataset.tab;
    renderAdminPanel();
    if (adminState.tab === 'menu') loadAdminMenu();
  } else if (button.dataset.action === 'logout') {
    api('/api/admin/logout', { method: 'POST' }).then(() => {
      clearInterval(adminTimer);
      adminState = { orders: [], menu: [], settings: null, tab: 'orders', orderFilter: 'all', editingId: '' };
      renderAdminLogin();
    }).catch((error) => showToast(error.message));
  }
}

async function refreshAdmin() {
  try {
    const data = await api('/api/admin/orders');
    adminState.orders = data.orders;
    adminState.settings = data.settings;
    if (adminState.tab === 'orders') renderAdminPanel();
  } catch (error) {
    clearInterval(adminTimer);
    renderAdminLogin(error.message);
  }
}

function startAdminPolling() {
  clearInterval(adminTimer);
  adminTimer = setInterval(refreshAdmin, 10000);
}

appRoot.addEventListener('click', customerClick);
boot();
