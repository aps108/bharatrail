(() => {
  let workspace = null;
  let activeTab = 'qr';
  let savedQrs = [];
  let proofRows = [];
  let proofRefreshTimer = null;
  let approvalCountTimer = null;
  let supportCounts = {};
  let supportHistory = [];
  let ticketDraft = freshDraft();

  const ASSET_BASE = new URL('.', window.location.href).href;
  const LOGO_IR = new URL('assets/ir-emblem.png', ASSET_BASE).href;
  const LOGO_IRCTC = new URL('assets/irctc-logo.png', ASSET_BASE).href;

  /* ------------------------------------------------------------------ *
   * Self-contained QR encoder (byte mode, ECC level M, mask 0).
   * Renders straight to a PNG data URL so the code is baked into the
   * document and survives printing, PDF export and saved HTML files.
   * ------------------------------------------------------------------ */

  const QR_TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466];
  const QR_EC = {
    1: { ec: 10, groups: [[1, 16]] },
    2: { ec: 16, groups: [[1, 28]] },
    3: { ec: 26, groups: [[1, 44]] },
    4: { ec: 18, groups: [[2, 32]] },
    5: { ec: 24, groups: [[2, 43]] },
    6: { ec: 16, groups: [[4, 27]] },
    7: { ec: 18, groups: [[4, 31]] },
    8: { ec: 22, groups: [[2, 38], [2, 39]] },
    9: { ec: 22, groups: [[3, 36], [2, 37]] },
    10: { ec: 26, groups: [[4, 43], [1, 44]] },
    11: { ec: 30, groups: [[1, 50], [4, 51]] },
    12: { ec: 22, groups: [[6, 36], [2, 37]] }
  };
  const QR_ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    11: [6, 30, 54], 12: [6, 32, 58]
  };

  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();
  const gfMul = (a, b) => (a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0);

  function rsEncode(block, ecCount) {
    let gen = [1];
    for (let i = 0; i < ecCount; i++) {
      const next = new Array(gen.length + 1).fill(0);
      for (let k = 0; k < next.length; k++) {
        let value = 0;
        if (k > 0) value ^= gen[k - 1];
        if (k < gen.length) value ^= gfMul(gen[k], GF_EXP[i]);
        next[k] = value;
      }
      gen = next;
    }
    const remainder = new Array(ecCount).fill(0);
    for (const byte of block) {
      const factor = byte ^ remainder[0];
      remainder.shift();
      remainder.push(0);
      if (factor) for (let i = 0; i < ecCount; i++) remainder[i] ^= gfMul(gen[i + 1], factor);
    }
    return remainder;
  }

  function qrMatrix(text) {
    const bytes = new TextEncoder().encode(text);
    let version = 0;
    for (let v = 1; v <= 12; v++) {
      const spec = QR_EC[v];
      const blockCount = spec.groups.reduce((sum, g) => sum + g[0], 0);
      const dataCodewords = QR_TOTAL_CODEWORDS[v] - spec.ec * blockCount;
      const headerBits = 4 + (v < 10 ? 8 : 16);
      if (dataCodewords * 8 - headerBits >= bytes.length * 8) { version = v; break; }
    }
    if (!version) throw new Error('QR payload too long');
    const spec = QR_EC[version];
    const blockCount = spec.groups.reduce((sum, g) => sum + g[0], 0);
    const dataCodewords = QR_TOTAL_CODEWORDS[version] - spec.ec * blockCount;

    const bits = [];
    const pushBits = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    pushBits(0b0100, 4);
    pushBits(bytes.length, version < 10 ? 8 : 16);
    for (const byte of bytes) pushBits(byte, 8);
    const capacity = dataCodewords * 8;
    pushBits(0, Math.min(4, Math.max(0, capacity - bits.length)));
    while (bits.length % 8) bits.push(0);

    const dataBytes = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      dataBytes.push(byte);
    }
    let padIndex = 0;
    while (dataBytes.length < dataCodewords) { dataBytes.push(padIndex % 2 === 0 ? 0xec : 0x11); padIndex++; }

    const blocks = [];
    let offset = 0;
    for (const [count, length] of spec.groups) {
      for (let i = 0; i < count; i++) {
        const block = dataBytes.slice(offset, offset + length);
        offset += length;
        blocks.push({ data: block, ec: rsEncode(block, spec.ec) });
      }
    }

    const finalBytes = [];
    const longest = Math.max(...blocks.map(b => b.data.length));
    for (let i = 0; i < longest; i++) for (const block of blocks) if (i < block.data.length) finalBytes.push(block.data[i]);
    for (let i = 0; i < spec.ec; i++) for (const block of blocks) finalBytes.push(block.ec[i]);

    const dataBits = [];
    for (const byte of finalBytes) for (let i = 7; i >= 0; i--) dataBits.push((byte >>> i) & 1);

    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFunction = (x, y, dark) => {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      modules[y][x] = !!dark;
      isFunction[y][x] = true;
    };

    for (let i = 0; i < size; i++) { setFunction(6, i, i % 2 === 0); setFunction(i, 6, i % 2 === 0); }

    const placeFinder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(cx + dx, cy + dy, distance !== 2 && distance !== 4);
      }
    };
    placeFinder(3, 3);
    placeFinder(size - 4, 3);
    placeFinder(3, size - 4);

    const centers = QR_ALIGN[version] || [];
    for (let i = 0; i < centers.length; i++) for (let j = 0; j < centers.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === centers.length - 1) || (i === centers.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        setFunction(centers[j] + dx, centers[i] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }

    for (let i = 0; i <= 8; i++) { setFunction(8, i, false); setFunction(i, 8, false); }
    for (let i = 0; i < 8; i++) { setFunction(8, size - 1 - i, false); setFunction(size - 1 - i, 8, false); }

    if (version >= 7) {
      let remainder = version;
      for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
      const versionBits = (version << 12) | remainder;
      for (let i = 0; i < 18; i++) {
        const bit = ((versionBits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFunction(a, b, bit);
        setFunction(b, a, bit);
      }
    }

    let index = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < size; vertical++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vertical : vertical;
          if (!isFunction[y][x] && index < dataBits.length) {
            modules[y][x] = dataBits[index] === 1;
            index++;
          }
        }
      }
    }

    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (!isFunction[y][x] && (x + y) % 2 === 0) modules[y][x] = !modules[y][x];
    }

    let formatRemainder = 0;
    for (let i = 0; i < 10; i++) formatRemainder = (formatRemainder << 1) ^ ((formatRemainder >>> 9) * 0x537);
    const formatBits = formatRemainder ^ 0x5412;
    const formatBit = i => ((formatBits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) setFunction(8, i, formatBit(i));
    setFunction(8, 7, formatBit(6));
    setFunction(8, 8, formatBit(7));
    setFunction(7, 8, formatBit(8));
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, formatBit(i));
    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, formatBit(i));
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, formatBit(i));
    setFunction(8, size - 8, true);

    return { size, modules };
  }

  function qrDataUrl(text, targetPixels = 444) {
    const { size, modules } = qrMatrix(text);
    const quietZone = 4;
    const total = size + quietZone * 2;
    const scale = Math.max(1, Math.floor(targetPixels / total));
    const dimension = total * scale;
    const canvas = document.createElement('canvas');
    canvas.width = dimension;
    canvas.height = dimension;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, dimension, dimension);
    context.fillStyle = '#000000';
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (modules[y][x]) context.fillRect((x + quietZone) * scale, (y + quietZone) * scale, scale, scale);
    }
    return canvas.toDataURL('image/png');
  }

  // Class code -> coach prefix used on Indian Railways coaches.
  const COACH_PREFIX = {
    SL: 'S', '3A': 'B', '2A': 'A', '2S': 'D', CC: 'C', EC: 'C', '1A': 'H', '3E': 'M', '3A-E': 'M', 'EA': 'M'
  };

  // Berth position inside an 8-berth bay, keyed by berth number % 8.
  const BERTH_LABELS = {
    1: ['WINDOW SIDE', 'LOWER'],
    2: ['MIDDLE'],
    3: ['UPPER'],
    4: ['WINDOW SIDE', 'LOWER'],
    5: ['MIDDLE'],
    6: ['UPPER'],
    7: ['SIDE LOWER', 'SIDE MIDDLE'],
    8: ['SIDE UPPER', 'SIDE MIDDLE']
  };

  function coachPrefixFor(classCode) {
    const code = String(classCode || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!code) return 'S';
    if (COACH_PREFIX[code]) return COACH_PREFIX[code];
    if (code.startsWith('1A')) return 'H';
    if (code.startsWith('2A')) return 'A';
    if (code.startsWith('3E')) return 'M';
    if (code.startsWith('3A')) return 'B';
    if (code.startsWith('SL')) return 'S';
    if (code.startsWith('2S')) return 'D';
    if (code.startsWith('CC') || code.startsWith('EC')) return 'C';
    return 'S';
  }

  function randomBerthStatus(classCode) {
    const prefix = coachPrefixFor(classCode);
    const coachNumber = 1 + Math.floor(Math.random() * 9);
    const berthNumber = 10 + Math.floor(Math.random() * 63);
    const slot = ((berthNumber - 1) % 8) + 1;
    const options = BERTH_LABELS[slot] || ['LOWER'];
    const berth = options[Math.floor(Math.random() * options.length)];
    return `CNF/${prefix}${coachNumber}/${berthNumber}/${berth}`;
  }

  function freshDraft() {
    return {
      reference: String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000000000).padStart(10, '0'),
      phone: '', email: '', trainNumber: '', trainName: '', from: '', to: '',
      journeyDate: '', departure: '', arrival: '', classCode: '', fare: '', quota: '', distance: '',
      transactionRef: '', passengers: [{ name: '', age: '', gender: '', status: 'CNF', currentStatus: 'CNF' }]
    };
  }

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  function closeWorkspace() {
    clearInterval(proofRefreshTimer);
    proofRefreshTimer = null;
    clearInterval(approvalCountTimer);
    approvalCountTimer = null;
    adminToken = null;
    sessionStorage.removeItem('bharatrailAdminToken');
    sessionStorage.removeItem('bharatrailReceiptAccess');
    workspace?.remove();
    workspace = null;
    document.body.style.overflow = '';
  }

  function renderLogin(error = '') {
    workspace.className = 'admin-workspace-overlay admin-login-screen';
    workspace.innerHTML = `
      <main class="admin-login-panel">
        <button class="admin-close" type="button" data-admin-action="close" aria-label="Close admin">×</button>
        <div class="admin-login-mark"><i class="fas fa-train" aria-hidden="true"></i></div>
        <p class="admin-eyebrow">BHARATRAIL · OPERATOR ACCESS</p>
        <h1>Admin sign in</h1>
        <p class="admin-muted">Manage payment QR codes, review proof submissions, and prepare customer receipts.</p>
        <form id="admin-login-form" class="admin-login-form">
          <label for="admin-password">Password</label>
          <input id="admin-password" type="password" inputmode="text" autocomplete="current-password" required autofocus>
          <p class="admin-error" role="alert">${esc(error)}</p>
          <button class="admin-primary" type="submit">Sign in <span aria-hidden="true">→</span></button>
        </form>
      </main>`;
    workspace.querySelector('#admin-password').focus();
  }

  function openPanel() {
    closeWorkspace();
    workspace = document.createElement('div');
    workspace.className = 'admin-workspace-overlay admin-login-screen';
    document.body.appendChild(workspace);
    document.body.style.overflow = 'hidden';
    adminToken = null;
    sessionStorage.removeItem('bharatrailAdminToken');
    sessionStorage.removeItem('bharatrailReceiptAccess');
    renderLogin();
  }

  function renderShell() {
    workspace.className = 'admin-workspace-overlay';
    workspace.innerHTML = `
      <header class="admin-topbar">
        <div class="admin-brand"><span class="admin-brand-icon"><i class="fas fa-train"></i></span><span><strong>Bharatrail</strong><small>Admin workspace</small></span></div>
        <div class="admin-top-actions"><span class="admin-session-label"><i></i> Signed in</span><button type="button" class="admin-logout" data-admin-action="logout">Sign out</button><button type="button" class="admin-close" data-admin-action="close" aria-label="Close admin">×</button></div>
      </header>
      <div class="admin-layout">
        <aside class="admin-sidebar" aria-label="Admin sections">
          <p class="admin-side-label">WORKSPACE</p>
          <button type="button" class="admin-tab" data-tab="qr"><i class="fas fa-qrcode"></i><span>Payment QR</span></button>
          <button type="button" class="admin-tab" data-tab="support"><i class="fas fa-headset"></i><span>Customer Support</span></button>
          <button type="button" class="admin-tab" data-tab="approvals"><i class="fas fa-receipt"></i><span>Payment approvals</span><b id="admin-approval-nav-count" class="admin-approval-nav-count" hidden></b></button>
          <button type="button" class="admin-tab" data-tab="visitors"><i class="fas fa-user-shield"></i><span>Banned customers</span></button>
          <button type="button" class="admin-tab" data-tab="proofs"><i class="fas fa-users"></i><span>Person Details</span></button>
          <button type="button" class="admin-tab" data-tab="ticket"><i class="fas fa-file-lines"></i><span>Receipt maker</span></button>
          <div class="admin-sidebar-foot"><span class="admin-status-dot"></span> Local operator tools</div>
        </aside>
        <main class="admin-main"><div class="admin-page" id="admin-page"></div></main>
      </div>`;
    workspace.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
      syncTicketDraft();
      activeTab = button.dataset.tab;
      renderAdminPage();
    }));
    workspace.querySelector('[data-admin-action="close"]').addEventListener('click', closeWorkspace);
    workspace.querySelector('[data-admin-action="logout"]').addEventListener('click', () => {
      clearInterval(approvalCountTimer);
      approvalCountTimer = null;
      clearInterval(proofRefreshTimer);
      proofRefreshTimer = null;
      adminToken = null;
      sessionStorage.removeItem('bharatrailAdminToken');
      sessionStorage.removeItem('bharatrailReceiptAccess');
      renderLogin();
    });
    renderAdminPage();
    refreshApprovalCount();
    clearInterval(approvalCountTimer);
    approvalCountTimer = setInterval(refreshApprovalCount, 12000);
  }

  async function refreshApprovalCount() {
    const badge = workspace?.querySelector('#admin-approval-nav-count');
    if (!badge) return;
    try {
      const result = await adminApi('/api/admin/payment-proofs');
      const count = (result.proofs || []).filter(proof => proof.status === 'PENDING_REVIEW').length;
      badge.textContent = String(count);
      badge.hidden = count === 0;
      badge.title = `${count} payment proof${count === 1 ? '' : 's'} waiting for review`;
    } catch { /* The current admin page will show authentication or service errors. */ }
  }

  function renderAdminPage() {
    if (!workspace?.querySelector('#admin-page')) return;
    if (activeTab !== 'proofs') {
      clearInterval(proofRefreshTimer);
      proofRefreshTimer = null;
    }
    workspace.querySelectorAll('[data-tab]').forEach(button => {
      button.classList.toggle('active', button.dataset.tab === activeTab);
      button.setAttribute('aria-current', button.dataset.tab === activeTab ? 'page' : 'false');
    });
    const page = workspace.querySelector('#admin-page');
    if (activeTab === 'qr') renderQrPage(page);
    else if (activeTab === 'support') renderSupportPage(page);
    else if (activeTab === 'visitors') renderVisitorsPage(page);
    else if (activeTab === 'approvals') renderApprovalPage(page);
    else if (activeTab === 'proofs') renderProofPage(page);
    else if (sessionStorage.getItem('bharatrailReceiptAccess') !== '1') renderReceiptLock(page);
    else renderTicketPage(page);
  }

  function renderReceiptLock(page) {
    page.innerHTML = `<div class="admin-page-heading"><div><p class="admin-eyebrow">PROTECTED TOOL</p><h1>Receipt maker</h1><p class="admin-muted">Enter the receipt maker password to continue.</p></div></div><form id="admin-receipt-unlock" class="admin-login-form admin-receipt-unlock"><label for="admin-receipt-password">Receipt maker password</label><input id="admin-receipt-password" type="password" autocomplete="current-password" required><p class="admin-error" role="alert"></p><button class="admin-primary" type="submit">Unlock receipt maker</button></form>`;
    page.querySelector('#admin-receipt-unlock').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('[type="submit"]');
      const error = form.querySelector('.admin-error');
      button.disabled = true;
      try {
        await adminApi('/api/admin/receipt-auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: form.querySelector('#admin-receipt-password').value }) });
        sessionStorage.setItem('bharatrailReceiptAccess', '1');
        renderAdminPage();
      } catch (failure) {
        error.textContent = failure.message;
        button.disabled = false;
      }
    });
  }

  async function renderSupportPage(page) {
    let whatsappNumbers = [];
    let callNumbers = [];
    page.innerHTML = '<p class="admin-muted">Loading support contacts…</p>';
    try {
        const result = await adminApi('/api/admin/support-settings');
        const whatsappContacts = result.whatsappContacts || [];
        const callContacts = result.callContacts || [];
        supportCounts = Object.fromEntries([...whatsappContacts, ...callContacts].map(item => [item.number, item]));
        supportHistory = result.recentContacts || [];
        whatsappNumbers = whatsappContacts.map(item => item.number);
        callNumbers = callContacts.map(item => item.number);
    }
    catch (error) { page.innerHTML = `<p class="admin-error">${esc(error.message)}</p>`; return; }
    if (!whatsappNumbers.length) whatsappNumbers = [''];
    if (!callNumbers.length) callNumbers = [''];
    const renderNumbers = (channel, title, numbers) => `<section class="admin-support-channel"><h2>${title}</h2><div id="admin-${channel}-numbers">${numbers.map((number, index) => { const count = supportCounts[number] || {}; return `<label class="admin-support-row">${title} number ${index + 1}<input type="tel" inputmode="numeric" autocomplete="tel" maxlength="15" value="${esc(number)}" placeholder="e.g. 919876543210"><small>WhatsApp clicks: ${Number(count.whatsappClicks) || 0} · Call clicks: ${Number(count.callClicks) || 0}</small></label>`; }).join('')}</div><button type="button" class="admin-secondary admin-add-support-number" data-channel="${channel}">Add ${title} number</button></section>`;
    page.innerHTML = `<div class="admin-page-heading"><div><p class="admin-eyebrow">CUSTOMER SUPPORT</p><h1>WhatsApp &amp; call routing</h1><p class="admin-muted">Manage separate rotating number lists for each channel. Add up to 100 numbers per channel.</p></div><span class="admin-page-icon"><i class="fas fa-headset"></i></span></div>
      <section class="admin-support-settings"><p class="admin-muted">Counts track clicks to open WhatsApp or place a call. Contact history records the customer number entered and the agent number assigned; it cannot confirm a WhatsApp message was sent or answered.</p>${renderNumbers('whatsapp', 'WhatsApp', whatsappNumbers)}${renderNumbers('call', 'Call', callNumbers)}
      <div class="admin-support-history"><h2>Recent support contacts</h2>${supportHistory.length ? `<div class="admin-support-history-list">${supportHistory.map(item => `<div><strong>${esc(item.customerPhone)}</strong><span>→ ${esc(item.supportNumber)} · ${esc(item.channel)}</span><time>${esc(new Date(item.contactedAt).toLocaleString())}</time></div>`).join('')}</div>` : '<p class="admin-muted">No support contacts yet.</p>'}</div>
      <div class="admin-panel-actions"><button type="button" class="admin-primary" id="admin-save-support">Save support numbers</button></div><p id="admin-support-message" class="admin-inline-status" role="status"></p></section>`;
    page.querySelectorAll('.admin-add-support-number').forEach(button => button.addEventListener('click', () => {
      const channel = button.dataset.channel;
      const selector = `#admin-${channel}-numbers .admin-support-row input`;
      const values = [...page.querySelectorAll(selector)].map(input => input.value);
      if (values.length >= 100) return;
      values.push('');
      if (channel === 'whatsapp') whatsappNumbers = values; else callNumbers = values;
      page.querySelector(`#admin-${channel}-numbers`).insertAdjacentHTML('beforeend', `<label class="admin-support-row">${channel} number ${values.length}<input type="tel" inputmode="numeric" autocomplete="tel" maxlength="15" placeholder="e.g. 919876543210"><small>WhatsApp and call click counts appear after saving.</small></label>`);
    }));
    page.querySelector('#admin-save-support').addEventListener('click', async event => {
      const button = event.currentTarget;
      const status = page.querySelector('#admin-support-message');
      whatsappNumbers = [...page.querySelectorAll('#admin-whatsapp-numbers input')].map(input => input.value.trim()).filter(Boolean);
      callNumbers = [...page.querySelectorAll('#admin-call-numbers input')].map(input => input.value.trim()).filter(Boolean);
      button.disabled = true;
      try {
        await adminApi('/api/admin/support-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ whatsappNumbers, callNumbers }) });
        status.textContent = 'WhatsApp and call support numbers saved.';
        const savedMessage = status.textContent;
        await renderSupportPage(page);
        page.querySelector('#admin-support-message').textContent = savedMessage;
      } catch (error) {
        button.disabled = false;
        status.textContent = error.message;
      }
    });
  }

  function renderQrPage(page) {
    page.innerHTML = `<div class="admin-page-heading"><div><p class="admin-eyebrow">PAYMENT CONFIGURATION</p><h1>Payment QR accounts</h1><p class="admin-muted">Add up to 10 accounts. Customers can switch accounts when one does not work. A QR is hidden after three switch reports; uploading a replacement resets its count.</p></div><span class="admin-page-icon"><i class="fas fa-qrcode"></i></span></div><div class="admin-qr-slots">${Array.from({ length: 10 }, (_, index) => { const slot = savedQrs[index] || {}; return `<section class="admin-qr-slot"><h2>QR account ${index + 1}</h2>${slot.qrCode ? `<img class="admin-qr-slot-image" src="${slot.qrCode}" alt="Saved QR account ${index + 1}">` : '<div class="admin-muted">No QR uploaded</div>'}<p class="admin-muted">${slot.disabled ? 'Disabled after 3 customer reports' : `Active · ${Number(slot.changeCount) || 0} change reports`}</p><label class="admin-upload-control" for="admin-qr-file-${index}">Upload or replace QR</label><input class="admin-file-input admin-qr-file" id="admin-qr-file-${index}" type="file" accept="image/png,image/jpeg,image/webp" data-index="${index}"><button class="admin-primary admin-save-qr-slot" type="button" data-index="${index}" disabled>Save account ${index + 1}</button><p class="admin-inline-status" role="status"></p></section>`; }).join('')}</div>`;
    page.querySelectorAll('.admin-qr-slot').forEach(slotElement => {
      let qrData = '';
      const input = slotElement.querySelector('.admin-qr-file');
      const save = slotElement.querySelector('.admin-save-qr-slot');
      const status = slotElement.querySelector('.admin-inline-status');
      input.addEventListener('change', () => {
        const file = input.files?.[0]; qrData = ''; save.disabled = true;
        if (!file) return;
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 3 * 1024 * 1024) { status.textContent = 'Choose a PNG, JPG, or WebP image under 3 MB.'; return; }
        const reader = new FileReader();
        reader.onload = () => { qrData = String(reader.result || ''); save.disabled = !qrData; status.textContent = file.name; };
        reader.readAsDataURL(file);
      });
      save.addEventListener('click', async () => {
        if (!qrData) return;
        save.disabled = true; status.textContent = 'Saving…';
        try {
          await adminApi('/api/admin/payment-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: Number(save.dataset.index), qrCode: qrData }) });
          const settings = await adminApi('/api/admin/payment-settings'); savedQrs = settings.qrs || []; renderQrPage(page);
        } catch (error) { status.textContent = error.message; save.disabled = false; }
      });
    });
  }

  function renderProofPage(page) {
    page.innerHTML = `
      <div class="admin-page-heading"><div><p class="admin-eyebrow">BOOKING SUBMISSIONS</p><h1>Person Details</h1><p class="admin-muted">Search or choose a mobile number to see the person’s saved ticketing details and payment proof.</p></div><span class="admin-page-icon"><i class="fas fa-users"></i></span></div>
      <section class="admin-approval-queue"><div class="admin-approval-heading"><div><h2>Payment approvals</h2><p class="admin-muted">New payment proofs appear here automatically.</p></div><span id="admin-pending-count" class="admin-proof-state">Loading</span></div><div id="admin-proof-approvals" aria-live="polite"><p class="admin-muted">Loading payment proofs…</p></div></section>
      <form id="admin-proof-search" class="admin-search-row"><label class="sr-only" for="admin-proof-mobile">Search phone</label><i class="fas fa-search"></i><input id="admin-proof-mobile" type="search" inputmode="numeric" placeholder="Search by mobile number"><button class="admin-primary" type="submit">Search mobile</button></form>
      <div id="admin-proof-results" class="admin-proof-results" aria-live="polite"><p class="admin-muted">Loading mobile numbers…</p></div>`;
    page.querySelector('#admin-proof-search').addEventListener('submit', event => {
      event.preventDefault();
      loadProofs(page, page.querySelector('#admin-proof-mobile').value.trim());
    });
    loadProofs(page);
    clearInterval(proofRefreshTimer);
    proofRefreshTimer = setInterval(() => loadProofs(page, page.querySelector('#admin-proof-mobile')?.value.trim() || ''), 12000);
  }

  function renderApprovalPage(page) {
    page.innerHTML = `<div class="admin-page-heading"><div><p class="admin-eyebrow">PAYMENT REVIEW</p><h1>Payment approvals</h1><p class="admin-muted">Review each uploaded payment proof and approve or decline it. This list refreshes automatically.</p></div><span class="admin-page-icon"><i class="fas fa-receipt"></i></span></div><section class="admin-approval-queue"><div class="admin-approval-heading"><div><h2>Waiting for review</h2><p class="admin-muted">Open a proof to inspect the payment screenshot.</p></div><span id="admin-pending-count" class="admin-proof-state">Loading</span></div><div id="admin-proof-approvals" aria-live="polite"><p class="admin-muted">Loading payment proofs…</p></div></section><div id="admin-proof-results" hidden></div>`;
    loadProofs(page);
    clearInterval(proofRefreshTimer);
    proofRefreshTimer = setInterval(() => loadProofs(page), 12000);
  }

  async function renderVisitorsPage(page) {
    page.innerHTML = `<div class="admin-page-heading"><div><p class="admin-eyebrow">VISITOR ACCESS</p><h1>Banned customers</h1><p class="admin-muted">Visitor records include server-observed IP addresses and phone numbers entered for booking or support. Bans remain until removed here.</p></div><span class="admin-page-icon"><i class="fas fa-user-shield"></i></span></div><form id="admin-ban-form" class="admin-search-row"><label for="admin-ban-type">Ban by</label><select id="admin-ban-type"><option value="mobile">Mobile number</option><option value="ip">IP address</option></select><input id="admin-ban-value" required placeholder="10 digit mobile or IP address"><input id="admin-ban-reason" maxlength="200" placeholder="Reason (optional)"><button class="admin-primary" type="submit">Block permanently</button></form><p class="admin-error" id="admin-ban-error" role="alert"></p><section class="admin-approval-queue"><h2>Blocked customers</h2><div id="admin-ban-list" aria-live="polite"><p class="admin-muted">Loading blocked customers…</p></div></section><section class="admin-approval-queue"><h2>Recent visitors</h2><p class="admin-muted">IP is recorded when the home page is visited. A phone is added only when someone enters it for booking or support.</p><div id="admin-visitor-list"><p class="admin-muted">Loading visitor records…</p></div></section>`;
    const form = page.querySelector('#admin-ban-form');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('[type="submit"]');
      const error = page.querySelector('#admin-ban-error');
      button.disabled = true;
      error.textContent = '';
      try {
        await adminApi('/api/admin/customer-bans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: form.querySelector('#admin-ban-type').value, value: form.querySelector('#admin-ban-value').value, reason: form.querySelector('#admin-ban-reason').value }) });
        form.reset();
        await loadVisitorRegister(page);
      } catch (problem) { error.textContent = problem.message; }
      finally { button.disabled = false; }
    });
    await loadVisitorRegister(page);
  }

  async function loadVisitorRegister(page) {
    try {
      const result = await adminApi('/api/admin/visitor-register');
      const banList = page.querySelector('#admin-ban-list');
      const visitorList = page.querySelector('#admin-visitor-list');
      if (!banList || !visitorList) return;
      banList.innerHTML = result.bans.length ? result.bans.map(ban => `<article class="admin-visitor-row"><div><strong>${ban.type === 'ip' ? 'IP address' : 'Mobile'}: ${esc(ban.value)}</strong><p>${esc(ban.reason || 'No reason recorded')} · Blocked ${esc(ban.createdAt ? new Date(ban.createdAt).toLocaleString() : '')}</p></div><button type="button" class="admin-secondary" data-unban-type="${esc(ban.type)}" data-unban-value="${esc(ban.value)}">Unblock</button></article>`).join('') : '<p class="admin-muted">No customers are currently blocked.</p>';
      visitorList.innerHTML = result.visitors.length ? result.visitors.slice(0, 300).map(visitor => {
        const mobileBan = result.bans.some(ban => ban.type === 'mobile' && ban.value === visitor.mobile);
        const ipBan = result.bans.some(ban => ban.type === 'ip' && ban.value === visitor.ip);
        return `<article class="admin-visitor-row"><div><strong>${esc(visitor.mobile || 'Phone not provided')} · IP ${esc(visitor.ip)}</strong><p>${Number(visitor.visits) || 0} visits · Last seen ${esc(visitor.lastSeen ? new Date(visitor.lastSeen).toLocaleString() : 'Unknown')}</p></div><div class="admin-proof-actions">${visitor.mobile && !mobileBan ? `<button type="button" class="admin-secondary" data-ban-type="mobile" data-ban-value="${esc(visitor.mobile)}">Block mobile</button>` : ''}${!ipBan ? `<button type="button" class="admin-secondary" data-ban-type="ip" data-ban-value="${esc(visitor.ip)}">Block IP</button>` : ''}</div></article>`;
      }).join('') : '<p class="admin-muted">No visitor records yet.</p>';
      banList.querySelectorAll('[data-unban-type]').forEach(button => button.addEventListener('click', async () => {
        await adminApi('/api/admin/customer-bans', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: button.dataset.unbanType, value: button.dataset.unbanValue }) });
        await loadVisitorRegister(page);
      }));
      visitorList.querySelectorAll('[data-ban-type]').forEach(button => button.addEventListener('click', async () => {
        await adminApi('/api/admin/customer-bans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: button.dataset.banType, value: button.dataset.banValue, reason: 'Blocked from visitor register' }) });
        await loadVisitorRegister(page);
      }));
    } catch (error) {
      const list = page.querySelector('#admin-visitor-list');
      if (list) list.innerHTML = `<p class="admin-error" role="alert">${esc(error.message)}</p>`;
    }
  }

  async function loadProofs(page, mobile = '') {
    const list = page.querySelector('#admin-proof-results');
    if (!list) return;
    const selectedMobile = list.querySelector('[data-person-mobile].active')?.dataset.personMobile || '';
    list.innerHTML = '<p class="admin-muted">Loading mobile numbers…</p>';
    try {
      const query = new URLSearchParams();
      if (mobile) query.set('mobile', mobile);
      const result = await adminApi(`/api/admin/payment-proofs?${query}`);
      proofRows = result.proofs || [];
      renderPaymentApprovalQueue(page);
      if (!proofRows.length) {
        list.innerHTML = '<div class="admin-empty-state"><i class="fas fa-inbox"></i><h2>No matching people</h2><p>Submitted mobile numbers will appear here.</p></div>';
        return;
      }

      const mobileGroups = new Map();
      proofRows.forEach(proof => {
        const number = String(proof.mobile || 'Phone not provided');
        mobileGroups.set(number, (mobileGroups.get(number) || 0) + 1);
      });
      list.innerHTML = `<h2 class="admin-person-list-title">Mobile numbers</h2><div class="admin-person-list">${Array.from(mobileGroups, ([number, count]) => `<button type="button" class="admin-secondary admin-person-mobile" data-person-mobile="${esc(number)}"><i class="fas fa-phone"></i><span>${esc(number)}</span><small>${count} submission${count === 1 ? '' : 's'}</small></button>`).join('')}</div><div id="admin-person-detail" class="admin-person-detail"><p class="admin-muted">Select a mobile number to view its details.</p></div>`;
      list.querySelectorAll('[data-person-mobile]').forEach(button => button.addEventListener('click', () => {
        list.querySelectorAll('[data-person-mobile]').forEach(item => item.classList.toggle('active', item === button));
        renderPersonDetails(page, button.dataset.personMobile);
      }));
      if (selectedMobile) {
        const selected = Array.from(list.querySelectorAll('[data-person-mobile]')).find(button => button.dataset.personMobile === selectedMobile);
        if (selected) {
          selected.classList.add('active');
          renderPersonDetails(page, selectedMobile);
        }
      }
    } catch (error) {
      list.innerHTML = `<p class="admin-error" role="alert">${esc(error.message)}</p>`;
    }
  }

  function renderPaymentApprovalQueue(page) {
    const queue = page.querySelector('#admin-proof-approvals');
    const count = page.querySelector('#admin-pending-count');
    if (!queue || !count) return;
    const pending = proofRows.map((proof, index) => ({ proof, index })).filter(item => item.proof.status === 'PENDING_REVIEW');
    count.textContent = `${pending.length} pending`;
    if (!pending.length) {
      queue.innerHTML = '<p class="admin-muted">No payment approvals are waiting.</p>';
      return;
    }
    queue.innerHTML = pending.map(({ proof, index }) => {
      const amount = proof.amount !== null && proof.amount !== '' && Number.isFinite(Number(proof.amount)) ? `₹${Number(proof.amount).toFixed(2)}` : 'Not recorded';
      const submitted = proof.receivedAt && !Number.isNaN(Date.parse(proof.receivedAt)) ? new Date(proof.receivedAt).toLocaleString() : 'Timestamp unavailable';
      return `<article class="admin-proof-row"><div class="admin-proof-main"><span class="admin-proof-state">PENDING REVIEW</span><h3>${esc(proof.mobile || 'Phone not provided')}</h3><p>${esc(proof.trainNumber || '')} ${esc(proof.trainName || 'Train not provided')} · ${esc(proof.classCode || 'Class unavailable')}</p><p>${esc(proof.fromStation || 'Origin unavailable')} → ${esc(proof.toStation || 'Destination unavailable')} · ${esc(proof.journeyDate || 'Date unavailable')}</p><p>Payment: ${esc(amount)} · Reference: ${esc(proof.transactionRef || 'Not provided')}</p><p class="admin-proof-meta">Submitted: ${esc(submitted)}</p></div><div class="admin-proof-actions">${proof.fileName ? `<button type="button" class="admin-secondary" data-queue-view="${index}">View payment proof</button>` : '<span class="admin-proof-meta">Proof file unavailable</span>'}<button type="button" class="admin-primary" data-queue-review="APPROVED" data-queue-index="${index}">Approve</button><button type="button" class="admin-secondary" data-queue-review="DECLINED" data-queue-index="${index}">Decline</button></div></article>`;
    }).join('');
    queue.querySelectorAll('[data-queue-view]').forEach(button => button.addEventListener('click', () => viewProof(proofRows[Number(button.dataset.queueView)])));
    queue.querySelectorAll('[data-queue-review]').forEach(button => button.addEventListener('click', async () => {
      const proof = proofRows[Number(button.dataset.queueIndex)];
      if (!proof) return;
      queue.querySelectorAll('button').forEach(item => { item.disabled = true; });
      try {
        await adminApi('/api/admin/payment-proof-status', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ referenceId: proof.referenceId, status: button.dataset.queueReview }) });
        await loadProofs(page, page.querySelector('#admin-proof-mobile')?.value.trim() || '');
      } catch (error) {
        alert(error.message);
        queue.querySelectorAll('button').forEach(item => { item.disabled = false; });
      }
    }));
  }

  function renderPersonDetails(page, mobile) {
    const detail = page.querySelector('#admin-person-detail');
    if (!detail) return;
    const records = proofRows.filter(proof => String(proof.mobile || 'Phone not provided') === mobile);
    detail.innerHTML = records.map(proof => {
      const index = proofRows.indexOf(proof);
      let passengers = [];
      try { passengers = Array.isArray(proof.travellers) ? proof.travellers : JSON.parse(proof.travellers || '[]'); } catch { /* keep passenger details empty */ }
      const people = passengers.map((person, passengerIndex) => `${passengerIndex + 1}. ${esc(person.name || 'Name not provided')}, ${esc(person.age || 'Age not provided')}, ${esc(person.gender || 'Gender not provided')}`).join('<br>') || 'Passenger details not recorded';
      const receivedAt = proof.receivedAt && !Number.isNaN(Date.parse(proof.receivedAt)) ? new Date(proof.receivedAt).toLocaleString() : 'Timestamp unavailable';
      const amount = proof.amount !== null && proof.amount !== '' && Number.isFinite(Number(proof.amount)) ? `₹${Number(proof.amount).toFixed(2)}` : 'Not recorded';
      const proofFileAction = proof.fileName ? `<button type="button" class="admin-secondary" data-proof-view="${index}">View payment screenshot</button>` : '<p class="admin-proof-meta">Payment proof file was deleted after 10 days.</p>';
      const approved = String(proof.status || '').toUpperCase() === 'APPROVED';
      const receiptPreview = approved ? `<section class="admin-person-receipt"><h3>Generated customer receipt</h3><iframe class="admin-receipt-preview-frame" title="Customer receipt" srcdoc="${esc(receiptDocument(receiptDraftFromProof(proof)))}"></iframe></section>` : '';
      return `<article class="admin-proof-row"><div class="admin-proof-main"><span class="admin-proof-state">${esc(proof.status || 'PENDING REVIEW')}</span><h2>${esc(proof.mobile || 'Phone not provided')}</h2><p class="admin-proof-meta">Submitted: ${esc(receivedAt)}</p><p>Email: ${esc(proof.email || 'Not provided')}</p><p>Train: ${esc(proof.trainNumber || '')} ${esc(proof.trainName || 'Not provided')} · Class: ${esc(proof.classCode || 'Not provided')}</p><p>Route: ${esc(proof.fromStation || 'Origin unavailable')} → ${esc(proof.toStation || 'Destination unavailable')}</p><p>Journey: ${esc(proof.journeyDate || 'Date unavailable')} · Departure: ${esc(proof.departure || 'Not provided')} · Arrival: ${esc(proof.arrival || 'Not provided')}</p><p>Amount: ${esc(amount)} · Payment reference: ${esc(proof.transactionRef || 'Not provided')}</p><p>Passengers:<br>${people}</p>${receiptPreview}</div><div class="admin-proof-actions">${proofFileAction}${proof.status === 'PENDING_REVIEW' ? `<button type="button" class="admin-primary" data-proof-review="APPROVED" data-proof-index="${index}">Approve</button><button type="button" class="admin-secondary" data-proof-review="DECLINED" data-proof-index="${index}">Decline</button>` : ''}${approved ? `<button type="button" class="admin-primary" data-proof-print-receipt="${index}">Print / Save receipt PDF</button>` : '<span class="admin-proof-meta">Receipt is available after payment approval.</span>'}<button type="button" class="admin-primary" data-proof-use="${index}">Create receipt</button></div></article>`;
    }).join('');
    detail.querySelectorAll('[data-proof-use]').forEach(button => button.addEventListener('click', () => useProof(proofRows[Number(button.dataset.proofUse)])));
    detail.querySelectorAll('[data-proof-print-receipt]').forEach(button => button.addEventListener('click', () => printPersonReceipt(proofRows[Number(button.dataset.proofPrintReceipt)])));
    detail.querySelectorAll('[data-proof-view]').forEach(button => button.addEventListener('click', () => viewProof(proofRows[Number(button.dataset.proofView)])));
    detail.querySelectorAll('[data-proof-review]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await adminApi('/api/admin/payment-proof-status', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ referenceId: proofRows[Number(button.dataset.proofIndex)].referenceId, status: button.dataset.proofReview }) });
        await loadProofs(page, mobile);
        renderPersonDetails(page, mobile);
      } catch (error) { button.disabled = false; alert(error.message); }
    }));
  }

  function receiptDraftFromProof(proof) {
    let passengers = [];
    try { passengers = Array.isArray(proof.travellers) ? proof.travellers : JSON.parse(proof.travellers || '[]'); } catch { /* missing passenger details */ }
    return {
      ...freshDraft(), reference: proof.referenceId || proof.transactionRef || 'Receipt',
      phone: proof.mobile || '', email: proof.email || '', trainNumber: proof.trainNumber || '', trainName: proof.trainName || '',
      from: proof.fromStation || '', to: proof.toStation || '', journeyDate: proof.journeyDate || '', departure: proof.departure || '',
      arrival: proof.arrival || '', classCode: proof.classCode || '', fare: proof.amount || '', transactionRef: proof.transactionRef || '',
      distance: proof.distance || '', quota: proof.quota || '',
      passengers: passengers.map(person => ({ name: person.name || '', age: person.age || '', gender: person.gender || '' }))
    };
  }

  function printPersonReceipt(proof) {
    if (String(proof.status || '').toUpperCase() !== 'APPROVED') return alert('Approve this payment proof before printing its receipt.');
    const receiptWindow = window.open('', '_blank');
    if (!receiptWindow) return alert('Allow pop-ups to print or save this receipt as a PDF.');
    receiptWindow.document.open();
    receiptWindow.document.write(receiptDocument(receiptDraftFromProof(proof)));
    receiptWindow.document.close();
    setTimeout(() => { if (!receiptWindow.closed) { receiptWindow.focus(); receiptWindow.print(); } }, 250);
  }
  async function viewProof(record) {
    const viewer = window.open('', '_blank');
    if (!viewer) return alert('Allow pop-ups to view the payment proof.');
    viewer.document.write('<title>Loading payment proof</title><p>Loading secure proof…</p>');
    try {
      const headers = new Headers({ Authorization: `Bearer ${adminToken}` });
      const response = await fetch(apiUrl(`/api/admin/payment-proof-file?referenceId=${encodeURIComponent(record.referenceId)}`), { headers });
      if (!response.ok) throw new Error('Payment proof could not be opened.');
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      viewer.location.href = objectUrl;
      viewer.addEventListener('beforeunload', () => URL.revokeObjectURL(objectUrl), { once: true });
    } catch (error) {
      viewer.close();
      alert(error.message);
    }
  }

  function syncTicketDraft() {
    const form = workspace?.querySelector('#admin-ticket-form');
    if (!form) return;
    form.querySelectorAll('[data-ticket-field]').forEach(input => {
      ticketDraft[input.dataset.ticketField] = input.value;
    });
    ticketDraft.passengers = Array.from(form.querySelectorAll('.admin-passenger-row')).map(row => ({
      name: row.querySelector('[data-passenger="name"]').value,
      age: row.querySelector('[data-passenger="age"]').value,
      gender: row.querySelector('[data-passenger="gender"]').value,
      status: row.querySelector('[data-passenger="status"]').value || 'CNF',
      currentStatus: row.querySelector('[data-passenger="currentStatus"]').value || 'CNF'
    }));
  }

  function renderTicketPage(page) {
    const draft = ticketDraft;
    page.innerHTML = `
      <div class="admin-page-heading"><div><p class="admin-eyebrow">CUSTOMER DOCUMENTS</p><h1>Receipt maker</h1><p class="admin-muted">Prepare a customer receipt from a reviewed payment proof or enter journey details manually.</p></div><span class="admin-page-icon"><i class="fas fa-file-lines"></i></span></div>
      <form id="admin-ticket-form" class="admin-ticket-form">
        <section class="admin-form-section"><div class="admin-section-title"><span>01</span><div><h2>Customer and journey</h2><p>Enter the route and train information for this receipt.</p></div></div>
          <div class="admin-form-grid">
            <label>PNR NUMBER<input data-ticket-field="reference" value="${esc(draft.reference)}" readonly></label>
            <label>Customer mobile<input data-ticket-field="phone" inputmode="tel" value="${esc(draft.phone)}" placeholder="10-digit number"></label>
            <label>Email<input data-ticket-field="email" type="email" value="${esc(draft.email)}" placeholder="name@example.com"></label>
            <label>Train number<input data-ticket-field="trainNumber" value="${esc(draft.trainNumber)}" placeholder="Train number"></label>
            <label>Train name<input data-ticket-field="trainName" value="${esc(draft.trainName)}" placeholder="Train name"></label>
            <label>From city / station<input data-ticket-field="from" value="${esc(draft.from)}" placeholder="Origin"></label>
            <label>To city / station<input data-ticket-field="to" value="${esc(draft.to)}" placeholder="Destination"></label>
            <label>Journey date<input data-ticket-field="journeyDate" type="date" value="${esc(draft.journeyDate)}"></label>
            <label>Departure time<input data-ticket-field="departure" type="time" value="${esc(draft.departure)}"></label>
            <label>Arrival time<input data-ticket-field="arrival" type="time" value="${esc(draft.arrival)}"></label>
            <label>Class<input data-ticket-field="classCode" value="${esc(draft.classCode)}" placeholder="e.g. 3A, SL, 2S, CC, 1A"></label>
            <label>Quota<input data-ticket-field="quota" value="${esc(draft.quota)}" placeholder="e.g. GN"></label>
            <label>Distance (km)<input data-ticket-field="distance" type="number" min="0" value="${esc(draft.distance)}" placeholder="Optional"></label>
            <label>Fare / amount received (₹)<input data-ticket-field="fare" type="number" min="0" step="0.01" value="${esc(draft.fare)}" placeholder="Optional; enter verified amount"></label>
            <label class="admin-span-2">Payment transaction reference<input data-ticket-field="transactionRef" value="${esc(draft.transactionRef)}" placeholder="Reference supplied with payment proof"></label>
          </div>
        </section>
        <section class="admin-form-section"><div class="admin-section-title"><span>02</span><div><h2>Passengers</h2><p>Add, remove, or edit every traveler included in this receipt. Status format: CNF/coach/berth/berth position.</p></div></div>
          <div id="admin-passenger-list">${draft.passengers.map((person, index) => passengerMarkup(person, index)).join('')}</div>
          <div class="admin-passenger-tools" style="display:flex;flex-wrap:wrap;gap:8px">
            <button type="button" class="admin-secondary admin-add-passenger" id="admin-add-passenger"><i class="fas fa-plus"></i> Add passenger</button>
            <button type="button" class="admin-secondary" id="admin-autofill-status"><i class="fas fa-shuffle"></i> Auto-fill coach &amp; berth</button>
          </div>
        </section>
        <div class="admin-ticket-actions"><button type="button" id="admin-new-draft" class="admin-secondary">New receipt</button><button type="button" id="admin-download-html" class="admin-secondary"><i class="fas fa-download"></i> Download editable HTML</button><button type="button" id="admin-print-receipt" class="admin-primary"><i class="fas fa-print"></i> Print / Save as PDF</button></div>
        <p id="admin-ticket-message" class="admin-inline-status" role="status"></p>
      </form>`;
    const form = page.querySelector('#admin-ticket-form');
    form.addEventListener('input', syncTicketDraft);
    page.querySelector('#admin-add-passenger').addEventListener('click', () => {
      syncTicketDraft();
      const generated = ticketDraft.classCode ? randomBerthStatus(ticketDraft.classCode) : 'CNF';
      ticketDraft.passengers.push({ name: '', age: '', gender: '', status: generated, currentStatus: generated });
      renderTicketPage(page);
    });
    page.querySelector('#admin-autofill-status').addEventListener('click', () => {
      const classCode = form.querySelector('[data-ticket-field="classCode"]').value;
      form.querySelectorAll('.admin-passenger-row').forEach(row => {
        const generated = randomBerthStatus(classCode);
        row.querySelector('[data-passenger="status"]').value = generated;
        row.querySelector('[data-passenger="currentStatus"]').value = generated;
      });
      syncTicketDraft();
      page.querySelector('#admin-ticket-message').textContent = classCode
        ? `Coach and berth status generated for ${String(classCode).toUpperCase()}.`
        : 'No class entered, so sleeper coach prefixes were used. Enter a class and regenerate for a matching coach.';
    });
    page.querySelectorAll('[data-remove-passenger]').forEach(button => button.addEventListener('click', () => {
      syncTicketDraft();
      if (ticketDraft.passengers.length > 1) ticketDraft.passengers.splice(Number(button.dataset.removePassenger), 1);
      renderTicketPage(page);
    }));
    page.querySelector('#admin-new-draft').addEventListener('click', () => {
      ticketDraft = freshDraft();
      renderTicketPage(page);
    });
    page.querySelector('#admin-print-receipt').addEventListener('click', () => {
      syncTicketDraft();
      if (!validateDraft(page)) return;
      printReceipt(ticketDraft);
    });
    page.querySelector('#admin-download-html').addEventListener('click', () => {
      syncTicketDraft();
      if (!validateDraft(page)) return;
      const blob = new Blob([renderBharatrailReceipt(ticketDraft)], { type: 'text/html;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${ticketDraft.reference}-receipt.html`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });
  }

  function passengerMarkup(person, index) {
    return `<div class="admin-passenger-row" style="flex-wrap:wrap"><span class="admin-passenger-number">${index + 1}</span><label>Name<input data-passenger="name" value="${esc(person.name)}" placeholder="Passenger name"></label><label>Age<input data-passenger="age" type="number" min="1" max="120" value="${esc(person.age)}" placeholder="Age"></label><label>Gender<select data-passenger="gender"><option value="" ${person.gender ? '' : 'selected'}>Select</option><option ${person.gender === 'Female' ? 'selected' : ''}>Female</option><option ${person.gender === 'Male' ? 'selected' : ''}>Male</option><option ${person.gender === 'Other' ? 'selected' : ''}>Other</option></select></label><label>Booking status<input data-passenger="status" value="${esc(person.status || 'CNF')}" placeholder="CNF/D8/61/WINDOW SIDE"></label><label>Current status<input data-passenger="currentStatus" value="${esc(person.currentStatus || 'CNF')}" placeholder="CNF/D8/61/WINDOW SIDE"></label><button type="button" class="admin-remove-passenger" data-remove-passenger="${index}" aria-label="Remove passenger" ${index === 0 ? 'disabled' : ''}>×</button></div>`;
  }

  function validateDraft(page) {
    syncTicketDraft();
    const d = ticketDraft;
    if (!d.trainName || !d.from || !d.to || !d.journeyDate || d.passengers.some(p => !p.name || !p.age || !p.gender)) {
      page.querySelector('#admin-ticket-message').textContent = 'Enter the train, route, journey date, and each passenger’s name, age, and gender.';
      return false;
    }
    page.querySelector('#admin-ticket-message').textContent = '';
    return true;
  }

  function receiptDocument(draft) {
    const passengers = draft.passengers.map((person, index) => `<tr><td>${index + 1}</td><td>${esc(person.name)}</td><td>${esc(person.age)}</td><td>${esc(person.gender)}</td></tr>`).join('');
    const amount = draft.fare ? `₹${Number(draft.fare).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : 'Not entered';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(draft.reference)} · Bharatrail receipt</title><style>
      *{box-sizing:border-box}body{margin:0;background:#edf3f6;color:#183044;font:14px Arial,sans-serif}.sheet{max-width:850px;margin:28px auto;background:#fff;border:1px solid #cbd8e1;padding:30px 34px}.top{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #126c62;padding-bottom:18px}.brand{font-size:26px;font-weight:700;color:#126c62}.tag{font-size:11px;letter-spacing:1px;color:#51697b}.notice{margin:18px 0;padding:12px;background:#fff4e5;border-left:5px solid #df8a1d;font-weight:700;color:#744a15}.meta{display:flex;justify-content:space-between;gap:15px;margin:18px 0}.meta div{flex:1}.label{display:block;color:#63798a;font-size:11px;text-transform:uppercase;margin-bottom:5px}.route{display:grid;grid-template-columns:1fr 80px 1fr;align-items:center;gap:12px;padding:18px 0;border-top:1px solid #dce5eb;border-bottom:1px solid #dce5eb}.route strong{display:block;font-size:17px}.route .arrow{text-align:center;color:#168579}.section{margin-top:24px}.section h2{font-size:15px;border-bottom:1px solid #cbd8e1;padding-bottom:8px}.ref{font-size:21px;color:#236696;font-weight:700}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #dce5eb;padding:10px}th{color:#5b7182;font-size:11px;text-transform:uppercase}.status{padding:12px;background:#eef7f5;margin-top:20px;color:#31574f}.footer{margin-top:30px;padding-top:12px;border-top:1px solid #dce5eb;color:#63798a;font-size:11px}@media print{body{background:#fff}.sheet{margin:0 auto;border:0;padding:12mm;max-width:none}}
      </style></head><body><article class="sheet"><header class="top"><div class="brand">Bharatrail</div><div class="tag">CUSTOMER PAYMENT & JOURNEY RECEIPT</div></header><div class="notice">NOT A RAILWAY TICKET · NO RAILWAY PNR OR CONFIRMED SEAT</div><div class="meta"><div><span class="label">RECEIPT REFERENCE</span><span class="ref">${esc(draft.reference)}</span></div><div><span class="label">Journey date</span><strong>${esc(draft.journeyDate)}</strong></div><div><span class="label">Class requested</span><strong>${esc(draft.classCode || 'Not specified')}</strong></div></div><section class="route"><div><span class="label">From</span><strong>${esc(draft.from)}</strong><span>${esc(draft.departure || '')}</span></div><div class="arrow">→</div><div><span class="label">To</span><strong>${esc(draft.to)}</strong><span>${esc(draft.arrival || '')}</span></div></section><div class="meta"><div><span class="label">Train</span><strong>${esc(draft.trainNumber)} ${esc(draft.trainName)}</strong></div><div><span class="label">Distance</span><strong>${draft.distance ? `${esc(draft.distance)} km` : 'Not recorded'}</strong></div><div><span class="label">Customer contact</span><strong>${esc(draft.phone)}</strong><br>${esc(draft.email)}</div><div><span class="label">Amount recorded</span><strong>${amount}</strong></div></div><section class="section"><h2>Passenger details</h2><table><thead><tr><th>#</th><th>Name</th><th>Age</th><th>Gender</th></tr></thead><tbody>${passengers}</tbody></table></section><div class="meta"><div><span class="label">Payment transaction reference</span><strong>${esc(draft.transactionRef || 'Not provided')}</strong></div><div><span class="label">Payment status</span><strong>${esc(draft.paymentStatus || 'Submitted for manual review')}</strong></div></div><p class="status">This document records details entered by Bharatrail. It does not confirm payment, a railway reservation, seat availability, or travel authorization. Verify any reservation directly with an authorized railway ticketing provider.</p><footer class="footer">Bharatrail internal customer receipt · Keep this receipt with your payment records.</footer></article></body></html>`;
  }

  function renderBharatrailReceipt(draft) {
    const money = value => (value === '' || value === null || value === undefined || Number.isNaN(Number(value)))
      ? '0.00'
      : Number(value).toFixed(2);
    const journeyDate = esc(draft.journeyDate || '—');
    const pnr = esc(draft.reference);
    const invoice = esc(`PS${String(draft.reference || '').replace(/[^A-Za-z0-9]/g, '')}`);
    const bookedOn = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    const fare = money(draft.fare);

    // Ticket transport GST varies by class; applicable service charges carry 18% GST.
    const classUpper = String(draft.classCode || '').trim().toUpperCase();
    const isAcClass = /^(1A|FC|2A|3A|3E|CC|EC|EA|EV|VC)$/.test(classUpper);
    const ticketGstRate = isAcClass ? 0.05 : 0;
    const ticketGst = Number((Number(fare) * ticketGstRate).toFixed(2));
    const ticketCgst = Number((ticketGst / 2).toFixed(2));
    const ticketSgst = Number((ticketGst - ticketCgst).toFixed(2));
    const convenienceBase = isAcClass ? 20 : 10;
    const insuranceBase = 0.75;
    const convenienceFee = convenienceBase * 1.18;
    const insuranceFee = 0.90;
    const chargesCgst = Number(((convenienceBase + insuranceBase) * 0.09).toFixed(2));
    const chargesSgst = chargesCgst;
    const totalGst = Number((ticketGst + chargesCgst + chargesSgst).toFixed(2));
    const totalFare = Number((Number(fare) + ticketGst + convenienceFee + insuranceFee).toFixed(2));

    const passengers = draft.passengers.map((person, index) => `<tr>
        <td>${index + 1}.</td>
        <td>${esc(person.name)}</td>
        <td>${esc(person.age)}</td>
        <td>${esc((person.gender || '').charAt(0))}</td>
        <td>${esc(person.status || 'CNF')}</td>
        <td>${esc(person.currentStatus || 'CNF')}</td>
      </tr>`).join('');

    // Keep the scan result readable and limit it to basic, non-contact receipt details.
    const qrField = (value, limit) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
    const qrPayload = [
      'Bharatrail receipt',
      `Ref: ${qrField(draft.reference, 36)}`,
      `Train: ${qrField(draft.trainNumber, 8)} ${qrField(draft.trainName, 24)}`.trim(),
      `Route: ${qrField(draft.from, 20)} -> ${qrField(draft.to, 20)}`,
      `Date: ${qrField(draft.journeyDate, 10)} | Class: ${qrField(draft.classCode, 5)}`,
      `Passengers: ${draft.passengers.length} | Total: INR ${money(totalFare)}`,
      'Not a railway ticket or confirmed reservation.'
    ].join('\n');
    let qrSource = '';
    try {
      qrSource = qrDataUrl(qrPayload, 444);
    } catch {
      const fallbackPayload = [
        'Bharatrail receipt', `Ref: ${qrField(draft.reference, 36)}`,
        `Date: ${qrField(draft.journeyDate, 10)}`, `Total: INR ${money(totalFare)}`,
        'Not a railway ticket.'
      ].join('\n');
      try { qrSource = qrDataUrl(fallbackPayload, 444); } catch { /* Keep the receipt usable if QR generation is unavailable. */ }
    }

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${pnr} · IRCTC ERS</title><style>
      *{box-sizing:border-box}
      html,body{margin:0;padding:0;background:#e9e9e9}
      body{font:12px Arial,Helvetica,sans-serif;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .sheet{width:794px;min-height:1123px;margin:14px auto;background:#fff;padding:8px;box-shadow:0 2px 14px rgba(0,0,0,.25)}
      .frame{border:2px solid #000;padding:10px 12px 16px}
      .head{display:flex;align-items:flex-start;justify-content:space-between}
      .head .logo{width:100px;flex:0 0 64px}
      .head .logo img{display:block;width:100%;height:auto}
      .head .logo--big{width:150px;flex:0 0 96px}
      .titlebox{flex:1;text-align:center;padding-top:2px}
      .title{font-size:16.5px;font-weight:700;text-decoration:underline}
      .title small{font-size:13px;font-weight:700;text-decoration:none}
      .booking{display:flex;align-items:flex-start;margin-top:12px}
      .booking .col{flex:1;text-align:center}
      .booking .lbl{font-weight:700;font-size:13px}
      .booking .val{font-size:13.5px;margin-top:6px}
      .booking .sub{font-size:13.5px;margin-top:3px}
      .arrow-wrap{flex:1.05;text-align:center}
      .arrow{margin:0 auto;width:100%;background:#4a8ec2;clip-path:polygon(0 0,87% 0,100% 50%,87% 100%,0 100%);color:#fff;font-weight:700;font-size:14px;padding:4px 0 5px}
      .grid3{display:flex;border-top:1px solid #000;margin-top:12px;padding-top:8px}
      .grid3 .cell{flex:1;text-align:center;padding:2px 4px}
      .grid3 .lbl{font-weight:700;font-size:13px}
      .grid3 .blue{color:#17568c;font-weight:700;font-size:14px;margin-top:5px;overflow-wrap:anywhere}
      .grid3 .plain{font-size:12.5px;margin-top:5px;overflow-wrap:anywhere}
      .grid3+.grid3{border-top:0;padding-top:2px;margin-top:0}
      .section{border-top:1px solid #000;margin-top:8px;padding-top:4px}
      .h2{font-size:14px;font-weight:700;text-decoration:underline;margin:0}
      table.pax{width:100%;border-collapse:collapse;margin-top:4px}
      table.pax th{font-size:12.5px;text-align:left;font-weight:700;padding:2px 0}
      table.pax td{font-size:12.5px;padding:2px 0;vertical-align:top}
      table.pax .c1{width:26px}table.pax .c2{width:170px}table.pax .c3{width:44px}table.pax .c4{width:64px}table.pax .c5{width:200px}
      .acr{display:flex;justify-content:space-between;font-size:7.5px;margin-top:10px}
      .txn{margin-top:10px;font-size:12.5px}
      .txn b{font-weight:700}
      .pay{margin-top:8px}
      .pay-row{display:flex;align-items:flex-start;gap:24px;margin-top:4px}
      .pay-left{flex:1 1 auto;min-width:0;padding-right:18px}
      .pay-qr{flex:0 0 148px;width:148px;text-align:right;margin-left:auto;padding-bottom:8px}
      table.pay-t{width:100%;border-collapse:collapse}
      table.pay-t td{font-size:12.5px;padding:4px 0}
      table.pay-t td.lbl{width:60%}
      table.pay-t td.amt{width:40%;text-align:left;padding-left:16px;white-space:nowrap}
      .pg{font-size:11px;margin-top:8px}
      #receipt-qrcode img{display:block;width:148px;height:148px;margin-left:auto}
      .pay-qr-caption{display:block;margin-top:4px;color:#333;font-size:9px}
      .notes{margin-top:20px;font-size:12px;line-height:1.45}
      .notes ul{margin:0;padding-left:16px}
      .notes li{margin-bottom:5px}
      .notes .b{font-weight:700}
      .notes .block2{border-top:1px solid #000;margin-top:12px;padding-top:8px}
      .gst{margin-top:18px;font-size:12px}
      .gst .hd{font-weight:700}
      .gst table{width:100%;border-collapse:collapse;margin-top:8px}
      .gst td{padding:4px 0;font-size:12px;vertical-align:top}
      .gst .k{width:165px}.gst .v{width:130px}.gst .k2{width:150px}
      .gst .hd2{font-weight:700;padding-top:12px}
      @page{size:A4;margin:6mm}
      @media print{body{background:#fff}.sheet{margin:0;box-shadow:none;width:auto;min-height:auto;padding:0}}
      </style></head><body>
      <article class="sheet"><div class="frame">

        <div class="head">
          <div class="logo"><img src="${LOGO_IR}" alt="Indian Railways"></div>
          <div class="titlebox"><div class="title">Electronic Reservation Slip (ERS)<small>-Normal User</small></div></div>
          <div class="logo logo--big"><img src="${LOGO_IRCTC}" alt="IRCTC"></div>
        </div>

        <div class="booking">
          <div class="col"><div class="lbl">Booked from</div><div class="val">${esc(draft.from)}</div><div class="sub"><b>Start Date*</b> ${journeyDate}</div></div>
          <div class="arrow-wrap"><div class="arrow">Boarding At</div><div class="val" style="font-weight:700;margin-top:8px">${esc(draft.from)}</div><div class="sub"><b>Departure*</b> ${esc(draft.departure || '—')} ${journeyDate}</div></div>
          <div class="col"><div class="lbl">To</div><div class="val">${esc(draft.to)}</div><div class="sub"><b>Arrival*</b> ${esc(draft.arrival || '—')} ${journeyDate}</div></div>
        </div>

        <div class="grid3">
          <div class="cell"><div class="lbl">PNR</div><div class="blue">${pnr}</div></div>
          <div class="cell"><div class="lbl">Train No./Name</div><div class="blue">${esc(draft.trainNumber)}/${esc(draft.trainName)}</div></div>
          <div class="cell"><div class="lbl">Class</div><div class="blue">${esc(draft.classCode || 'NOT SPECIFIED')}</div></div>
        </div>

        <div class="grid3">
          <div class="cell"><div class="lbl">Quota</div><div class="plain">${esc(draft.quota || 'GENERAL (GN)')}</div></div>
          <div class="cell"><div class="lbl">Distance</div><div class="plain">${draft.distance ? `${esc(draft.distance)} KM` : '—'}</div></div>
          <div class="cell"><div class="lbl">Booking Date</div><div class="plain">${esc(bookedOn)}</div></div>
        </div>

        <div class="section">
          <div class="h2">Passenger Details</div>
          <table class="pax">
            <tr><th class="c1">#</th><th class="c2">Name</th><th class="c3">Age</th><th class="c4">Gender</th><th class="c5">Booking Status</th><th>Current Status</th></tr>
            ${passengers}
          </table>
          <div class="acr"><span>Acronyms:</span><span>RLWL: REMOTE LOCATION WAITLIST</span><span>PQWL: POOLED QUOTA WAITLIST</span><span>RSWL: ROAD-SIDE WAITLIST</span></div>
        </div>

        <div class="pay">
          <div class="txn">Transaction ID: <b>${esc(draft.transactionRef || 'NOT PROVIDED')}</b></div>
          <div class="txn" style="margin-top:4px">IR recovers only 57% of cost of travel on an average.</div>
          <div class="pay-row">
            <div class="pay-left">
              <div class="h2">Payment Details</div>
              <table class="pay-t">
                <tr><td class="lbl">Ticket Fare</td><td class="amt">₹ ${fare}</td></tr>
                <tr><td class="lbl">Ticket GST (${isAcClass ? '5%' : '0%'}${isAcClass ? ' · CGST 2.5% + SGST 2.5%' : ' · non-AC class exempt'})</td><td class="amt">₹ ${money(ticketGst)}</td></tr>
                <tr><td class="lbl">IRCTC Convenience Fee (Incl. of GST)</td><td class="amt">₹ ${money(convenienceFee)}</td></tr>
                <tr><td class="lbl">Travel Insurance Premium (Incl. of GST)</td><td class="amt">₹ ${money(insuranceFee)}</td></tr>
                <tr><td class="lbl">Total Fare (all inclusive)</td><td class="amt">₹ ${money(totalFare)}</td></tr>
              </table>
              <div class="pg">PG Charges as applicable (Additional)</div>
            </div>
            <div class="pay-qr"><div id="receipt-qrcode">${qrSource ? `<img src="${qrSource}" alt="Receipt QR code">` : ''}</div><small class="pay-qr-caption">Scan for basic receipt details</small></div>
          </div>
        </div>

        <div class="notes">
          <ul><li><span class="b">Beware of fraudulent customer care number. For any assistance, use only the IRCTC e-ticketing Customer care number:14646.</span></li></ul>
          <div style="margin-top:2px">IRCTC Convenience Fee is charged per e-ticket irrespective of number of passengers on the ticket.</div>
          <div style="margin-top:8px"><b>* The printed Departure and Arrival Times are liable to change. Please Check correct departure, arrival from Railway Station Enquiry or Dial 139 or SMS RAIL to 139.</b></div>
          <div class="block2"><ul><li>This ticket is booked on a personal User ID, its sale/purchase is an offence u/s 143 of the Railways Act,1989.</li><li>Prescribed original ID proof is required while travelling along with SMS/ VRM/ ERS otherwise will be treated as without ticket and penalized as per Railway Rules.</li></ul></div>
        </div>

        <div class="gst">
          <div class="hd">Indian Railways GST Details:</div>
          <table><tr><td class="k">Invoice Number:</td><td class="v">${invoice}</td><td class="k2">Address:</td><td>Indian Railways New Delhi</td></tr></table>
          <div class="hd2">Supplier Information:</div>
          <table><tr><td class="k">SAC Code:</td><td class="v">996421</td><td class="k2">GSTIN:</td><td>07AAAGM0289C1ZL</td></tr></table>
          <div class="hd2">GST Breakup</div>
          <table>
            <tr><td class="k">Ticket GST on ${isAcClass ? 'AC/First Class fare' : 'non-AC fare (exempt)'}</td><td class="v">₹ ${money(ticketGst)}</td><td class="k2">Ticket CGST / SGST</td><td>${isAcClass ? '2.5% / 2.5%' : '0% / 0%'}</td></tr>
            <tr><td class="k">Convenience + insurance charge GST</td><td class="v">₹ ${money(chargesCgst + chargesSgst)}</td><td class="k2">CGST / SGST</td><td>9% / 9%</td></tr>
            <tr><td class="k">Total GST</td><td class="v">₹ ${money(totalGst)}</td><td class="k2">Invoice Total</td><td>₹ ${money(totalFare)}</td></tr>
          </table>
          <div class="hd2">Recipient Information:</div>
        </div>

      </div></article>
      </body></html>`;
  }

  function printReceipt(draft) {
    let receiptHtml;
    try { receiptHtml = renderBharatrailReceipt(draft); }
    catch (error) { return alert(`Receipt QR could not be generated: ${error.message}`); }
    const printWindow = window.open('', '_blank');
    if (!printWindow) return alert('Allow pop-ups to print or save the receipt as PDF.');

    let exported = false;
    const runExport = () => {
      if (exported || printWindow.closed) return;
      exported = true;
      const doc = printWindow.document;
      const sheet = doc.querySelector('.sheet');
      const qrImage = doc.querySelector('#receipt-qrcode img');
      if (!sheet || !qrImage || !qrImage.complete || !qrImage.naturalWidth) {
        alert('The receipt QR image did not load, so the PDF was not saved. Please try again.');
        printWindow.close();
        exported = true;
        return;
      }
      if (typeof printWindow.html2pdf !== 'function') {
        try { printWindow.focus(); printWindow.print(); } catch { /* window already closed */ }
        return;
      }
      printWindow.html2pdf().set({
        margin: [6, 6, 6, 6],
        filename: `${draft.reference}-receipt.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 3, useCORS: true, allowTaint: false, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'] }
      }).from(sheet).save();
    };

    const whenReady = () => {
      if (printWindow.closed) return;
      let waited = 0;
      const poll = () => {
        if (printWindow.closed) return;
        const doc = printWindow.document;
        const qrImage = doc.querySelector('#receipt-qrcode img');
        const qrReady = !!qrImage && qrImage.complete && qrImage.naturalWidth > 0;
        const logosReady = Array.from(doc.images).every(img => img.complete && img.naturalWidth > 0);
        if (qrReady && logosReady) {
          setTimeout(runExport, 180);
          return;
        }
        if (waited >= 8000) {
          alert('Receipt QR or PDF tools did not finish loading. No incomplete PDF was created. Please try again.');
          exported = true;
          printWindow.close();
          return;
        }
        waited += 100;
        setTimeout(poll, 100);
      };
      poll();
    };

    printWindow.document.open();
    printWindow.document.write(receiptHtml);
    printWindow.document.close();

    if (printWindow.document.readyState === 'complete') whenReady();
    else printWindow.addEventListener('load', whenReady, { once: true });

  }

  function useProof(proof) {
    let passengers = [];
    try { passengers = Array.isArray(proof.travellers) ? proof.travellers : JSON.parse(proof.travellers || '[]'); } catch { /* enter passengers manually */ }
    ticketDraft = {
      ...freshDraft(), phone: proof.mobile || '', email: proof.email || '', trainNumber: proof.trainNumber || '',
      trainName: proof.trainName || '', from: proof.fromStation || '', to: proof.toStation || '',
      journeyDate: proof.journeyDate || '', departure: proof.departure || '', arrival: proof.arrival || '',
      classCode: proof.classCode || '', fare: proof.amount || '', transactionRef: proof.transactionRef || '',
      quota: proof.quota || '', distance: proof.distance || '',
      passengers: passengers.length
        ? passengers.map(person => ({ name: person.name || '', age: person.age || '', gender: person.gender || '', status: person.status || 'CNF', currentStatus: person.currentStatus || 'CNF' }))
        : [{ name: '', age: '', gender: '', status: 'CNF', currentStatus: 'CNF' }]
    };
    activeTab = 'ticket';
    renderAdminPage();
  }

  async function handleLogin(event) {
    if (event.target.id !== 'admin-login-form') return;
    event.preventDefault();
    const form = event.target;
    const submit = form.querySelector('[type="submit"]');
    const password = form.querySelector('#admin-password').value;
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const result = await adminApi('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      adminToken = result.token;
      sessionStorage.removeItem('bharatrailReceiptAccess');
      const settings = await adminApi('/api/admin/payment-settings');
      savedQrs = settings.qrs || [];
      activeTab = 'qr';
      ticketDraft = freshDraft();
      renderShell();
    } catch (error) {
      renderLogin(error.message);
      workspace.querySelector('#admin-password').value = password;
      workspace.querySelector('#admin-password').focus();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const logo = document.querySelector('.nav-logo');
    logo?.addEventListener('click', openPanel);
    logo?.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPanel(); }
    });
  });

  document.addEventListener('submit', event => {
    if (workspace?.contains(event.target)) handleLogin(event);
  });

  document.addEventListener('click', event => {
    if (!workspace?.contains(event.target)) return;
    const action = event.target.closest('[data-admin-action]')?.dataset.adminAction;
    if (action === 'close') closeWorkspace();
    if (action === 'logout') { clearInterval(approvalCountTimer); approvalCountTimer = null; clearInterval(proofRefreshTimer); proofRefreshTimer = null; adminToken = null; sessionStorage.removeItem('bharatrailAdminToken'); sessionStorage.removeItem('bharatrailReceiptAccess'); renderLogin(); }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && workspace) closeWorkspace();
  });

  window.openBharatrailAdminPanel = openPanel;
})();
