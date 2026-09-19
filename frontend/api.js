/**
 * BookHaven — Django REST API Integration Layer
 * ================================================
 * SINGLE SOURCE OF TRUTH: This file is the exclusive owner of all book
 * data fetching. window.books, window.trendingBooks, and window.offers
 * are populated ONLY here, always with cache:'no-store' to guarantee
 * every page load reflects the latest state of the live DRF database.
 *
 * DO NOT read from a local static array in script.js as a fallback.
 * If this fetch fails, show an empty/error state — not stale data.
 *
 * Backend: Django REST Framework at http://127.0.0.1:8000
 * Auth: Clerk (https://clerk.com) with simplejwt backend tokens.
 */

(function () {
  'use strict';

  // ─── Config ───────────────────────────────────────────────────────────────────────────
  const getApiBase = () => {
    if (window.BOOKHAVEN_API_BASE) return window.BOOKHAVEN_API_BASE.replace(/\/+$/, '');
    if (window.BOOKHAVEN_API_URL) return window.BOOKHAVEN_API_URL.replace(/\/+$/, '');
    if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
      // Backend runs on port 8000 by default (python manage.py runserver)
      return 'http://127.0.0.1:8000/api';
    }
    return 'https://bookhaven-website.onrender.com/api';
  };

  let API_BASE = getApiBase();
  const CLERK_PUBLISHABLE_KEY = 'pk_test_cmVhZHktc3RhZy0xMDIzLmNsZXJrLmFjY291bnRzLmRldiQ';
  window.wishlist = [];

  // ─── Token helpers ──────────────────────────────────────────────────────────
  // We store the simplejwt token that /api/auth/clerk-sync/ returns.
  // All Django API calls use this token so the backend stays unchanged.
  function getToken() { return localStorage.getItem('bh_access_token'); }
  function setTokens(access, refresh) {
    localStorage.setItem('bh_access_token', access);
    localStorage.setItem('bh_refresh_token', refresh);
  }
  function clearTokens() {
    localStorage.removeItem('bh_access_token');
    localStorage.removeItem('bh_refresh_token');
  }

  // ─── HTTP helpers ───────────────────────────────────────────────────────────
  async function apiRequest(method, path, body = null, auth = false) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) {
      const token = getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    const opts = { method, headers, credentials: 'include' };
    // Never serve stale book data from the browser HTTP cache.
    // Without this, a cached /api/books/ response would outlive an admin
    // update and the book website would keep showing the old price/title.
    if (method === 'GET') opts.cache = 'no-store';
    if (body) opts.body = JSON.stringify(body);

    try {
      const res = await fetch(`${API_BASE}${path}`, opts);
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      console.warn('[BookHaven API] Network error:', err.message);
      return { ok: false, status: 0, data: { detail: 'Could not connect to server.' } };
    }
  }

  // Extract first error message from DRF error response
  function extractError(data) {
    if (!data) return 'Something went wrong.';
    if (typeof data === 'string') return data;
    if (data.error && data.error.message) return data.error.message;
    if (data.detail) return data.detail;
    const vals = Object.values(data);
    if (vals.length === 0) return 'Something went wrong.';
    const first = vals[0];
    return Array.isArray(first) ? first[0] : String(first);
  }

  // ─── Clerk Authentication ────────────────────────────────────────────────────

  /**
   * Called once after Clerk.load() resolves (Clerk JS v5+).
   * In v5, window.Clerk itself is the fully initialized instance —
   * Clerk.load() returns undefined, not a clerk object.
   */
  async function initClerkAuth() {
    const clerk = window.Clerk; // v5: instance lives on window.Clerk
    if (!clerk) return;

    // Optional: wire Google buttons to Clerk OAuth if available
    const googleLoginBtn = document.getElementById('google-login');
    if (googleLoginBtn) {
      googleLoginBtn.addEventListener('click', (e) => {
        e.preventDefault();
        clerk.openSignIn();
      });
    }
    const googleSignupBtn = document.getElementById('google-signup');
    if (googleSignupBtn) {
      googleSignupBtn.addEventListener('click', (e) => {
        e.preventDefault();
        clerk.openSignUp();
      });
    }

    // Listen for Clerk auth state changes (v5 API: window.Clerk.addListener)
    if (typeof clerk.addListener === 'function') {
      clerk.addListener(async ({ user }) => {
        if (user) {
          await onClerkSignIn(user);
        }
      });
    }

    // If there is already an active session in Clerk on page load, sync to Django now
    if (clerk.user) {
      await onClerkSignIn(clerk.user);
    }
  }

  /**
   * Called when Clerk reports a signed-in user.
   * Gets a fresh Clerk JWT → POSTs to /api/auth/clerk-sync/ → gets simplejwt tokens.
   */
  async function onClerkSignIn(clerkUser) {
    const clerk = window.Clerk;
    try {
      // Get a fresh short-lived session token from Clerk
      const clerkToken = await clerk.session.getToken();
      if (!clerkToken) return;

      // Exchange it for a Django simplejwt token pair
      const { ok, data } = await apiRequest('POST', '/auth/clerk-sync/', { clerk_token: clerkToken });

      if (ok) {
        setTokens(data.access, data.refresh);

        // Build a currentUser shape compatible with script.js
        currentUser = {
          ...data.user,
          name: data.user.display_name || clerkUser.fullName || clerkUser.primaryEmailAddress?.emailAddress?.split('@')[0] || 'User',
          email: data.user.email || clerkUser.primaryEmailAddress?.emailAddress || '',
          picture: clerkUser.imageUrl || '',
        };
        localStorage.setItem('currentUser', JSON.stringify(currentUser));

        updateUIForLoggedInUser();

        // Safety net: ensure old modal is closed
        const oldModal = document.getElementById('login-modal');
        if (oldModal) {
          oldModal.classList.remove('active');
          oldModal.setAttribute('aria-hidden', 'true');
          document.body.style.overflow = '';
        }

        showNotification(data.message || `Welcome, ${currentUser.name}! 👋`, 'success');
        await syncCartFromServer();
        await syncWishlistFromServer();
      } else {
        console.warn('[BookHaven] Clerk sync failed:', data);
        showNotification('Sign-in sync failed. Please try again.', 'error');
      }
    } catch (err) {
      console.warn('[BookHaven] onClerkSignIn error:', err);
    }
  }

  /** Called when Clerk reports a signed-out state. */
  function onClerkSignOut() {
    clearTokens();
    localStorage.removeItem('currentUser');
    currentUser = null;
    cart = [];
    window.wishlist = [];
    // Reset UI — reuse script.js helper if available
    if (typeof updateUIForLoggedOutUser === 'function') {
      updateUIForLoggedOutUser();
    } else {
      window.location.reload();
    }
  }

  // Override: handleLogout — sign-out
  window.handleLogout = async function () {
    try {
      // Blacklist the simplejwt refresh token on the Django side (best-effort)
      const refresh = localStorage.getItem('bh_refresh_token');
      if (refresh) {
        await apiRequest('POST', '/auth/logout/', { refresh }, true);
      }
    } catch (_) { /* ignore */ }

    clearTokens();
    localStorage.removeItem('currentUser');
    currentUser = null;
    if (typeof updateUIForLoggedOutUser === 'function') updateUIForLoggedOutUser();

    // Sign out from Clerk if present
    if (window.Clerk && typeof window.Clerk.signOut === 'function') {
      try { await window.Clerk.signOut(); } catch (_) {}
    }

    showNotification('Logged out successfully! 👋', 'success');
  };

  // ─── Boot Clerk ──────────────────────────────────────────────────────────────
  /**
   * Clerk JS v5 loads asynchronously via <script data-clerk-publishable-key>.
   * After the script executes, window.Clerk is available. We call Clerk.load()
   * to fully initialize, then call initClerkAuth().
   *
   * NOTE: In Clerk JS v5, Clerk.load() resolves with undefined — window.Clerk
   * itself is the initialized clerk instance.
   */
  (function bootClerk() {
    // Clear stale pre-Clerk localStorage sessions immediately so they don't
    // flash a phantom avatar before Clerk's auth state is known.
    const cachedUser = (() => { try { return JSON.parse(localStorage.getItem('currentUser') || 'null'); } catch { return null; } })();
    const isLegacySession = cachedUser && !cachedUser.clerk_user_id && !cachedUser.id;
    if (isLegacySession) {
      console.info('[BookHaven] Clearing stale pre-Clerk session from localStorage.');
      clearTokens();
      localStorage.removeItem('currentUser');
    }

    const TIMEOUT = 10000; // 10 s
    const start = Date.now();

    function tryInit() {
      if (window.Clerk) {
        window.Clerk.load({
          appearance: {
            variables: {
              colorPrimary: '#7A263A',
              colorBackground: '#F8F5EF',
              colorText: '#1C1C1A',
              colorInputBackground: '#FFFFFF',
              colorInputText: '#1C1C1A',
              borderRadius: '4px',
            },
          },
        }).then(() => {
          // v5: Clerk.load() resolves with undefined; window.Clerk IS the instance
          console.info('%c[BookHaven] Clerk initialized', 'color:#6366f1;font-weight:bold;');
          initClerkAuth();
        }).catch((err) => {
          console.error('[BookHaven] Clerk.load() failed:', err);
        });
        return;
      }

      if (Date.now() - start > TIMEOUT) {
        console.warn('[BookHaven] Clerk SDK did not load within 10 s. Falling back to legacy auth.');
        return;
      }

      setTimeout(tryInit, 100);
    }

    tryInit();
  })();

  // Clerk auth callbacks
  /** Called when Clerk reports a signed-out state. */
  function onClerkSignOut() {
    clearTokens();
    localStorage.removeItem('currentUser');
    currentUser = null;
    cart = [];
    window.wishlist = [];
    // Reset UI — reuse script.js helper if available
    if (typeof updateUIForLoggedOutUser === 'function') {
      updateUIForLoggedOutUser();
    } else {
      // Fallback: reload to cleanly reset all local state
      window.location.reload();
    }
  }


  // ─── Books override ─────────────────────────────────────────────────────────

  window.BookService = {
    async fetchAll(params = {}) {
      const qs = new URLSearchParams(params).toString();
      const url = `/books/${qs ? '?' + qs : ''}`;
      const { ok, data } = await apiRequest('GET', url);
      const bookList = ok ? (Array.isArray(data) ? data : (data.results || [])) : [];
      return bookList.map(mapApiBook);
    },
    async fetchOne(id) {
      const { ok, data } = await apiRequest('GET', `/books/${id}/`);
      return ok ? mapApiBook(data) : null;
    }
  };

  // Expose so script.js can trigger a live fetch-and-render.
  window.fetchAndRenderBooks = fetchAndRenderBooks;

  async function fetchAndRenderBooks(filter = 'all') {
    const container = document.getElementById('books-container');
    if (!container) return;

    let url = '/books/';
    if (filter === 'eBook') {
      url += '?category=eBook';
    } else if (filter !== 'all') {
      url += `?category=${encodeURIComponent(filter)}`;
    }

    container.innerHTML = '<div style="text-align:center;padding:3rem;color:var(--text-secondary)">\ud83d\udcda Loading books\u2026</div>';

    const params = {};
    if (filter === 'eBook') params.ebook = true;
    else if (filter !== 'all') params.category = filter;

    const books = await window.BookService.fetchAll(params);
    if (filter === 'all') window.books = books;
    if (books && books.length > 0) {
      container.innerHTML = books.map(book => buildBookCard(book)).join('');
      attachCardEvents(container);
      // Keep all other homepage sections in sync with the same fresh data.
      if (typeof renderBestsellers === 'function') renderBestsellers('all');
      if (typeof renderNewArrivals === 'function') renderNewArrivals();
      if (typeof observeBookCards === 'function') observeBookCards();
    } else {
      // API returned empty or error — show a clear message, never fall back to
      // stale static data (which would show wrong prices and missing new books).
      container.innerHTML = '<div style="text-align:center;padding:3rem;color:var(--text-secondary)">\ud83d\udcda Could not load books. Please check your connection and refresh.</div>';
    }
  }

  // Map Django API fields to the shape script.js expects
  function mapApiBook(b) {
    let coverImg = b.image_url;
    if (!coverImg && (b.id === 4 || (b.title && b.title.toLowerCase().includes('harry potter')))) {
      coverImg = 'assets/harry-potter.jpg';
    }
    return {
      id: b.id,
      title: b.title,
      author: b.author,
      price: b.price,
      category: b.category,
      image: coverImg || 'assets/book-1-sapiens.jpg',
      rating: b.user_rating || b.rating,
      reviews: b.total_reviews || b.reviews_count,
      ebook: b.is_ebook,
      badge: b.badge,
    };
  }

  // Patch filter pills to use API
  document.addEventListener('DOMContentLoaded', async () => {
    // Load books first, then trending (trending needs window.books to be set)
    await fetchAndRenderBooks('all');
    await fetchAndRenderTrending();

    // Patch filter pills
    document.querySelectorAll('.filter-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        const cat = pill.dataset.category || 'all';
        fetchAndRenderBooks(cat);
      });
    });

    // Offers from API
    fetchAndRenderOffers();

    // eBooks section from API
    fetchAndRenderEbooks();

    // Restore session from localStorage token
    restoreSession();
  });

  async function fetchAndRenderTrending() {
    const container = document.getElementById('trending-container');
    if (!container) return;
    const { ok, data } = await apiRequest('GET', '/books/trending/');
    if (!ok || !Array.isArray(data) || data.length === 0) return;

    window.trendingBooks = data.map(t => ({
      rank: t.rank,
      bookId: t.book.id,
      weeklyChange: t.weekly_change,
      hot: t.is_hot,
      book: mapApiBook(t.book) // Save the mapped book since we no longer sync to window.books
    }));

    renderTrending();
  }

  async function fetchAndRenderOffers() {
    const container = document.getElementById('offers-container');
    if (!container) return;
    const { ok, data } = await apiRequest('GET', '/books/offers/');
    if (!ok) return;
    const list = data.results || data;
    if (!Array.isArray(list) || list.length === 0) return;

    window.offers = list.map(o => ({
      gradient: o.gradient_class,
      discount: o.discount,
      title: o.title,
      desc: o.description,
      code: o.code,
      expiry: o.expiry_label,
      hours: o.hours_remaining,
    }));

    renderOffers();
  }

  async function fetchAndRenderEbooks() {
    const container = document.getElementById('ebooks-container');
    if (!container) return;
    const { ok, data } = await apiRequest('GET', '/books/ebooks/');
    if (!ok) return;
    const list = data.results || data;
    if (!Array.isArray(list)) return;
    container.innerHTML = list.map(book => buildBookCard(mapApiBook(book))).join('');
    attachCardEvents(container);
  }

  // ─── Wishlist overrides ─────────────────────────────────────────────────────

  window.syncWishlistFromServer = async function syncWishlistFromServer() {
    if (!getToken()) return;
    const { ok, data } = await apiRequest('GET', '/orders/wishlist/', null, true);
    if (ok && data.items) {
      window.wishlist = data.items;
      updateWishlistUI();
    }
  }

  function updateWishlistUI() {
    // Update the heart buttons on book cards
    document.querySelectorAll('.book-wishlist-btn').forEach(btn => {
      const bid = Number(btn.dataset.wishlistBook);
      const isWishlisted = window.wishlist.some(w => (w.book || w.id || w) == bid);
      if (isWishlisted) {
        btn.classList.add('active');
        const svg = btn.querySelector('svg');
        if (svg) svg.setAttribute('fill', 'currentColor');
      } else {
        btn.classList.remove('active');
        const svg = btn.querySelector('svg');
        if (svg) svg.setAttribute('fill', 'none');
      }
    });
    // Update modal wishlist buttons
    document.querySelectorAll('.wishlist-btn').forEach(btn => {
      const bid = Number(btn.dataset.wishlistBook);
      const isWishlisted = window.wishlist.some(w => (w.book || w.id || w) == bid);
      btn.style.color = isWishlisted ? '#ef4444' : 'inherit';
      btn.innerHTML = isWishlisted ? '❤️' : '🤍';
    });
    // Re-render modal if open
    if (window.renderWishlistItems) window.renderWishlistItems();
    
    updateWishlistCount();
  }

  function updateWishlistCount() {
    const countEl = document.getElementById('wishlist-count');
    if (countEl) {
      countEl.textContent = String(window.wishlist.length);
      countEl.classList.remove('bouncing');
      void countEl.offsetWidth; // force reflow
      countEl.classList.add('bouncing');
      countEl.addEventListener('animationend', () => countEl.classList.remove('bouncing'), { once: true });
    }
  }

  window.toggleWishlist = async function (bookId) {
    if (!getToken()) {
      showNotification('Please login to use the wishlist 🔐', 'info');
      openLogin();
      return;
    }
    const { ok, data } = await apiRequest('POST', '/orders/wishlist/toggle/', { book_id: bookId }, true);
    if (ok) {
      window.wishlist = data.wishlist.items;
      updateWishlistUI();
      showNotification(data.message, 'success');
    } else {
      showNotification(extractError(data), 'error');
    }
  };

  // ─── Cart overrides ─────────────────────────────────────────────────────────

  window.syncCartFromServer = async function syncCartFromServer() {
    if (!getToken()) return;
    const { ok, data } = await apiRequest('GET', '/orders/cart/', null, true);
    if (!ok) return;
    // Convert server cart to local cart format with cartId and cover image
    const newItems = (data.items || []).map(item => ({
      _cartItemId: item.id,
      cartId: `${item.book.id}-${item.format || 'physical'}`,
      id: item.book.id,
      title: item.book.title,
      author: item.book.author,
      image: (item.book.id === 4 || (item.book.title && item.book.title.includes('Harry Potter'))) ? 'assets/harry-potter.jpg' : (item.book.image_url || ''),
      price: item.unit_price,
      format: item.format,
      quantity: item.quantity,
    }));
    if (window.cart) {
      window.cart.length = 0;
      window.cart.push(...newItems);
    } else {
      window.cart = newItems;
    }
    updateCartCount();
  };

  // Override: addToCart
  window.addToCart = async function (bookId, format = 'physical', quantity = 1) {
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const cartId = `${bookId}-${format}`;
    let myCart = window.cart || [];
    if (!currentUser || !getToken()) {
      // Not logged in — use API to fetch fresh book details
      const book = await window.BookService.fetchOne(bookId);
      if (!book) return;
      const existing = myCart.find(c => c.cartId === cartId || (c.id == bookId && c.format === format));
      if (existing) {
        existing.quantity = (existing.quantity || 1) + qty;
      } else {
        const cover = (book.id === 4 || (book.title && book.title.includes('Harry Potter'))) ? 'assets/harry-potter.jpg' : (book.image || '');
        myCart.push({
          cartId,
          id: book.id,
          title: book.title,
          author: book.author,
          image: cover,
          price: format === 'ebook' ? Math.round((book.price || 499) * 0.6) : (book.price || 499),
          format,
          quantity: qty
        });
      }
      localStorage.setItem('bookCart', JSON.stringify(myCart));
      updateCartCount();
      showNotification(`${book.title} added to bag! 🛒`, 'success');
      return;
    }
    // Logged in — sync with server
    const { ok, data } = await apiRequest('POST', '/orders/cart/add/', { book_id: bookId, format, quantity: qty }, true);
    if (ok) {
      const newItems = (data.items || []).map(item => ({
        _cartItemId: item.id,
        cartId: `${item.book.id}-${item.format || 'physical'}`,
        id: item.book.id,
        title: item.book.title,
        author: item.book.author,
        image: (item.book.id === 4 || (item.book.title && item.book.title.includes('Harry Potter'))) ? 'assets/harry-potter.jpg' : (item.book.image_url || ''),
        price: item.unit_price,
        format: item.format,
        quantity: item.quantity,
      }));
      if (window.cart) {
        window.cart.length = 0;
        window.cart.push(...newItems);
      } else {
        window.cart = newItems;
      }
      localStorage.setItem('bookCart', JSON.stringify(window.cart));
      updateCartCount();
      const bookName = window.cart.find(c => c.id == bookId)?.title || 'Book';
      showNotification(`${bookName} added to bag! 🛒`, 'success');
    } else {
      showNotification(extractError(data), 'error');
    }
  };

  // Intercept clicks before script.js's delegated or direct listeners
  document.addEventListener('click', (e) => {
    // 1. Intercept Add to Cart
    const addBtn = e.target.closest('[data-add-to-cart]');
    if (addBtn) {
      e.stopPropagation(); // Prevent duplicate handling
      const card = addBtn.closest('.book-card');
      if (!card) return;
      const id = Number(card.getAttribute('data-id'));
      
      const selectedFmtBtn = card.querySelector('.format-btn.selected');
      const fmt = selectedFmtBtn ? selectedFmtBtn.dataset.fmt : 'physical';
      
      window.addToCart(id, fmt, 1);
      
      // Re-trigger the pulsing animation from script.js
      addBtn.classList.remove('pulsing');
      void addBtn.offsetWidth;
      addBtn.classList.add('pulsing');
      addBtn.addEventListener('animationend', () => addBtn.classList.remove('pulsing'), { once: true });
    }
    // 2. Intercept Logout
    else if (e.target.closest('#logout-btn') || e.target.closest('.logout')) {
      e.preventDefault();
      e.stopPropagation();
      window.handleLogout();
    }
  }, true); // Use capture phase to intercept BEFORE script.js's bubbling listener

  // Intercept submits before script.js's direct listeners
  document.addEventListener('submit', (e) => {
    if (e.target.id === 'settings-form') {
      e.preventDefault();
      e.stopPropagation();
      window.handleSettingsSave();
    }
  }, true);

  // Override: executePaymentLogic
  let apiPendingOrderBooks = [];
  window.afterPaymentSuccess = function() {
    closePaymentModal();
    setTimeout(() => openReviewModal(apiPendingOrderBooks), 400);
  };

  window.executePaymentLogic = async function (method) {
    if (!currentUser || !getToken()) {
      showNotification('Please login to checkout 🔐', 'info');
      closePaymentModal();
      openLogin();
      return;
    }

    const { ok, data } = await apiRequest('POST', '/orders/checkout/', {
      coupon_code: '', // Can be extended to support coupons from UI later
      payment_method: method,
      delivery_address: currentUser.address || '',
    }, true);

    if (!ok) {
      showNotification(extractError(data), 'error');
      closePaymentModal();
      return;
    }

    const order = data.order;
    const total = order.total;
    const txnId = order.tracking_id;
    const purchasedBooks = order.items.map(item => ({
       id: item.book,
       title: item.title,
       author: item.author,
       format: item.format
    }));

    // Find eBook items in this purchase
    const ebookItems = purchasedBooks.filter(b => b.format === 'ebook');
    const ebookDownloadsHtml = ebookItems.length > 0 ? `
      <div class="ebook-downloads-section" style="margin-top:1.2rem;">
        <div class="ebook-downloads-title">📱 Your eBooks are ready to download!</div>
        <div class="ebook-download-list">
          ${ebookItems.map(b => `
            <div class="ebook-download-item">
              <span class="ebook-download-name">📚 ${escHtml(b.title.replace(' (eBook)', ''))}</span>
              <button class="ebook-download-btn" id="dl-${b.id}" onclick="downloadEbookPDF(${b.id})">
                ⬇️ Download PDF
              </button>
            </div>`).join('')}
        </div>
      </div>` : '';

    const body = document.getElementById('payment-modal-body');
    if (body) {
      body.innerHTML = `
        <div class="pay-success">
          <div class="pay-success-circle">✓</div>
          <h3>Payment Successful!</h3>
          <p style="font-size:1.1rem;font-weight:800;">₹${total.toLocaleString('en-IN')} paid</p>
          <p>via <strong>${escHtml(method)}</strong></p>
          <div class="txn-id">Txn ID: ${escHtml(txnId)}</div>
          <p style="margin-top:0.8rem;font-size:0.88rem;">Order confirmation sent to <strong>${escHtml(currentUser.email)}</strong></p>
          ${ebookDownloadsHtml}
          <div style="display:flex;gap:0.8rem;margin-top:1.5rem;">
            <button class="submit-btn" style="flex:1;" onclick="closePaymentModal();openTrackingModal('${escHtml(txnId)}')">
              📍 Track Order
            </button>
            <button class="submit-btn" style="flex:1;background:linear-gradient(135deg,#ec4899,#8b5cf6);" onclick="afterPaymentSuccess()">
              ✍️ Rate Books
            </button>
          </div>
        </div>`;
    }

    if (window.cart) window.cart.length = 0;
    else window.cart = [];
    localStorage.removeItem('bookCart');
    updateCartCount();
    apiPendingOrderBooks = purchasedBooks;
    
    // Add to local ordersDB so tracking works immediately
    ordersDB.unshift({
        id: txnId,
        placedAt: new Date(order.created_at).getTime(),
        books: order.items.map(i => {
            const localBook = (window.books || []).find(b => b.id === i.book);
            return {
                id: i.book,
                title: i.title,
                author: i.author,
                image: localBook ? localBook.image : '',
                price: i.unit_price,
                quantity: i.quantity,
                format: i.format
            };
        }),
        total: order.total,
        method: order.payment_method,
        isOnlinePayment: method && (method.toLowerCase().includes('card') || method.toLowerCase().includes('net banking') || method.toLowerCase().includes('wallet') || method.toLowerCase().includes('upi')),
        status: order.status,
        user: currentUser.name
    });
  };

  // ─── Orders override ─────────────────────────────────────────────────────────

  const originalOpenOrdersModal = window.openOrdersModal;
  window.openOrdersModal = async function() {
    if (!getToken()) {
        openLogin();
        return;
    }
    
    // Fetch real orders from the API
    const { ok, data } = await apiRequest('GET', '/orders/', null, true);
    if (ok) {
        const apiOrders = data.results || data;
        // Update the global ordersDB array in script.js by modifying it in place
        ordersDB.length = 0; 
        apiOrders.forEach(o => {
            ordersDB.push({
                id: o.tracking_id,
                placedAt: new Date(o.created_at).getTime(),
                books: o.items.map(i => {
                    const localBook = (window.books || []).find(b => b.id === i.book);
                    return {
                        id: i.book || 0,
                        title: i.title,
                        author: i.author,
                        image: localBook ? localBook.image : '',
                        price: i.unit_price,
                        quantity: i.quantity,
                        format: i.format
                    };
                }),
                total: o.total,
                method: o.payment_method,
                isOnlinePayment: o.payment_method && (o.payment_method.toLowerCase().includes('card') || o.payment_method.toLowerCase().includes('net banking') || o.payment_method.toLowerCase().includes('wallet') || o.payment_method.toLowerCase().includes('upi')),
                status: o.status,
                user: currentUser.name
            });
        });
    }
    
    // Call the original render logic which uses the updated ordersDB
    if (originalOpenOrdersModal) originalOpenOrdersModal();
  };

  // ─── Reviews override ───────────────────────────────────────────────────────

  const originalShowAllReviews = window.showAllReviews;
  window.showAllReviews = async function (bookId) {
      const { ok, data } = await apiRequest('GET', `/reviews/?book=${bookId}`);
      if (ok) {
          reviewsDB[bookId] = data.map(r => ({
              id: r.id,
              user: r.user_name || 'Anonymous',
              rating: r.rating,
              text: r.text,
              date: new Date(r.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
          }));
      }
      if (originalShowAllReviews) originalShowAllReviews(bookId);
  };

  const originalSubmitReview = window.submitReview;
  window.submitReview = async function (bookId) {
      if (!getToken()) {
        showNotification('Please login to leave a review 🔐', 'info');
        openLogin();
        return;
      }
      
      const ta = document.getElementById('review-text');
      const text = ta ? ta.value.trim().slice(0, 500) : ''; 
      const stars = document.querySelectorAll('#star-picker .star.selected');
      const rating = stars.length;
      
      if (rating === 0) { showNotification('Please select a star rating!', 'error'); return; }
      
      const { ok, data } = await apiRequest('POST', '/reviews/create/', {
        book: bookId, rating: rating, text,
      }, true);
      
      if (!ok) {
        showNotification(extractError(data), 'error');
        return;
      }
      
      showNotification('Review submitted! ⭐', 'success');
      
      // Call the original to advance the queue and save locally
      if (originalSubmitReview) originalSubmitReview(bookId);
  };

  // ─── Session restore ─────────────────────────────────────────────────────────
  // Clerk's addListener (set up in initClerkAuth) is the authoritative session
  // source and runs automatically on page load.
  // restoreSession() provides a fast, optimistic UI restore from the localStorage
  // cache so the avatar/name appear instantly — before Clerk's async check completes.
  async function restoreSession() {
    const cachedUser = localStorage.getItem('currentUser');
    if (!cachedUser) {
      if (typeof updateUIForLoggedOutUser === 'function') updateUIForLoggedOutUser();
      return;
    }

    try {
      currentUser = JSON.parse(cachedUser);
      if (currentUser && (currentUser.name || currentUser.email)) {
        if (typeof updateUIForLoggedInUser === 'function') updateUIForLoggedInUser();
        // Automatically sync wishlist and cart to show correct badges and icons on page load
        if (getToken()) {
          if (typeof window.syncCartFromServer === 'function') window.syncCartFromServer();
          if (typeof window.syncWishlistFromServer === 'function') window.syncWishlistFromServer();
        }
      } else {
        clearTokens();
        localStorage.removeItem('currentUser');
        currentUser = null;
        if (typeof updateUIForLoggedOutUser === 'function') updateUIForLoggedOutUser();
      }
    } catch (_) {
      clearTokens();
      localStorage.removeItem('currentUser');
      currentUser = null;
      if (typeof updateUIForLoggedOutUser === 'function') updateUIForLoggedOutUser();
    }
  }

  // tryRefreshToken is kept for backward compat with simplejwt token flow
  async function tryRefreshToken() {
    const refresh = localStorage.getItem('bh_refresh_token');
    if (!refresh) return false;
    try {
      const res = await fetch(`${API_BASE}/auth/token/refresh/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh }),
      });
      if (!res.ok) return false;
      const result = await res.json();
      if (result.access) {
        localStorage.setItem('bh_access_token', result.access);
        // ROTATE_REFRESH_TOKENS=True means the server may issue a new refresh token too
        if (result.refresh) localStorage.setItem('bh_refresh_token', result.refresh);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ─── Helper: attach card events after dynamic render ────────────────────────

  function attachCardEvents(container) {
    // Quick-view buttons
    container.querySelectorAll('[data-quick-view]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = btn.closest('.book-card');
        if (!card) return;
        const bookId = parseInt(card.dataset.id, 10);
        if (window.showQuickView) window.showQuickView(bookId, btn);
        else if (window.openQuickView) window.openQuickView(bookId, btn);
      });
    });
    // Add to cart buttons
    container.querySelectorAll('[data-add-to-cart]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = btn.closest('.book-card');
        if (!card) return;
        const bookId = parseInt(card.dataset.id, 10);
        const fmtBtn = card.querySelector('.format-btn.selected');
        const fmt = fmtBtn ? fmtBtn.dataset.fmt : 'physical';
        window.addToCart(bookId, fmt, 1);
      });
    });
    // Format toggle buttons
    container.querySelectorAll('.format-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = btn.closest('.book-card');
        if (!card) return;
        card.querySelectorAll('.format-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });
    // See-all-reviews buttons
    container.querySelectorAll('[data-see-reviews]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bookId = parseInt(btn.dataset.seeReviews, 10);
        if (window.openReviewModal) window.openReviewModal(bookId, btn);
      });
    });
  }

  // ─── Status indicator ───────────────────────────────────────────────────────

  // Show a subtle badge indicating backend connection status
  async function checkBackendHealth() {
    try {
      const res = await fetch(`${API_BASE}/books/?page_size=1`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        console.info('%c✅ BookHaven Django API connected', 'color: #10b981; font-weight: bold;');
      } else {
        console.warn('%c⚠️ BookHaven Django API responded with error', 'color: #f59e0b;');
      }
    } catch {
      console.warn('%c❌ BookHaven Django API offline — using static data', 'color: #ef4444; font-weight: bold;');
    }
  }

  checkBackendHealth();

})();
