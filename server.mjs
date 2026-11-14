import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8082);
const host = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const bundledDataPath = path.join(root, 'data');
const storagePath = path.resolve(process.env.BHARATRAIL_STORAGE_DIR || bundledDataPath);
const paymentSettingsPath = path.join(storagePath, 'payment-settings.json');
const supportSettingsPath = path.join(storagePath, 'support-settings.json');
const supportContactsPath = path.join(storagePath, 'customer-support-contacts.json');
const paymentProofsPath = path.join(storagePath, 'payment-proofs');
const visitorRegisterPath = path.join(storagePath, 'visitor-register.json');
const paymentProofRetentionMs = 10 * 24 * 60 * 60 * 1000;
const adminSessions = new Map();
let supportRotationQueue = Promise.resolve();
let visitorRegisterQueue = Promise.resolve();
let visitorRegisterCache = null;
const paymentSessions = new Map();
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.gz', 'application/gzip'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.ico', 'image/x-icon']
]);

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function journeyDateAllowed(date) {
  if (!validDate(date)) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const maximumDate = new Date(`${today}T00:00:00Z`);
  const day = maximumDate.getUTCDate();
  maximumDate.setUTCDate(1);
  maximumDate.setUTCMonth(maximumDate.getUTCMonth() + 2);
  const lastDay = new Date(Date.UTC(maximumDate.getUTCFullYear(), maximumDate.getUTCMonth() + 1, 0)).getUTCDate();
  maximumDate.setUTCDate(Math.min(day, lastDay));
  const maximum = maximumDate.toISOString().slice(0, 10);
  return date >= today && date <= maximum;
}

function readRequest(request, maxBytes = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    request.on('data', chunk => {
      if (exceeded) return;
      size += chunk.length;
      if (size > maxBytes) {
        exceeded = true;
        reject(new Error('Request is too large.'));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
    request.on('error', reject);
  });
}

async function readJsonRequest(request, maxBytes = 4 * 1024 * 1024) {
  const body = await readRequest(request, maxBytes);
  return JSON.parse(body.toString('utf8') || '{}');
}

function adminAuthorized(request) {
  const token = (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const expires = adminSessions.get(token);
  if (!expires || expires < Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

async function readPaymentSettings() {
  try {
    const saved = JSON.parse(await fsp.readFile(paymentSettingsPath, 'utf8'));
    const qrs = Array.isArray(saved.qrs) ? saved.qrs.slice(0, 10) : (saved.qrCode ? [{ qrCode: saved.qrCode, changeCount: 0, disabled: false }] : []);
    return { qrs: Array.from({ length: 10 }, (_, index) => qrs[index] || { qrCode: '', changeCount: 0, disabled: false }) };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read payment settings.');
    return { qrs: Array.from({ length: 10 }, () => ({ qrCode: '', changeCount: 0, disabled: false })) };
  }
}

async function cleanupExpiredPaymentProofs() {
  let names;
  try { names = await fsp.readdir(paymentProofsPath); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const cutoff = Date.now() - paymentProofRetentionMs;
  for (const name of names.filter(file => file.endsWith('.json'))) {
    const metadataPath = path.join(paymentProofsPath, name);
    try {
      const proof = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
      if (proof.proofFileDeletedAt || Date.parse(proof.receivedAt || '') >= cutoff) continue;
      if (proof.fileName && path.basename(proof.fileName) === proof.fileName) await fsp.rm(path.join(paymentProofsPath, proof.fileName), { force: true });
      proof.fileName = null;
      proof.proofFileDeletedAt = new Date().toISOString();
      await fsp.writeFile(metadataPath, JSON.stringify(proof, null, 2), { mode: 0o600 });
    } catch (error) { if (error.code !== 'ENOENT') console.error('Could not clean up an expired payment proof.'); }
  }
}

function getClientIp(request) {
  const socketIp = String(request.socket?.remoteAddress || '').replace(/^::ffff:/i, '');
  if (process.env.BHARATRAIL_TRUST_PROXY === '1') {
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim().replace(/^::ffff:/i, '');
    if (net.isIP(forwarded)) return forwarded;
  }
  return net.isIP(socketIp) ? socketIp : 'unknown';
}

function normalizeMobile(value) { return String(value || '').replace(/\D/g, ''); }

async function readVisitorRegister() {
  if (visitorRegisterCache) return visitorRegisterCache;
  try {
    const saved = JSON.parse(await fsp.readFile(visitorRegisterPath, 'utf8'));
    visitorRegisterCache = { visitors: Array.isArray(saved.visitors) ? saved.visitors : [], bans: Array.isArray(saved.bans) ? saved.bans : [] };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read visitor register.');
    visitorRegisterCache = { visitors: [], bans: [] };
  }
  return visitorRegisterCache;
}

async function updateVisitorRegister(change) {
  const task = visitorRegisterQueue.then(async () => {
    const register = await readVisitorRegister();
    const result = await change(register);
    await fsp.mkdir(path.dirname(visitorRegisterPath), { recursive: true });
    await fsp.writeFile(visitorRegisterPath, JSON.stringify(register, null, 2), { mode: 0o600 });
    visitorRegisterCache = register;
    return result;
  });
  visitorRegisterQueue = task.then(() => undefined, () => undefined);
  return task;
}

function isVisitorBanned(register, ip, mobile = '') {
  const normalizedPhone = normalizeMobile(mobile);
  return register.bans.some(ban => (ban.type === 'ip' && ban.value === ip) ||
    (normalizedPhone && ban.type === 'mobile' && ban.value === normalizedPhone));
}

async function recordVisitor(ip, mobile = '') {
  const normalizedPhone = normalizeMobile(mobile);
  const now = new Date().toISOString();
  return updateVisitorRegister(register => {
    let visitor = register.visitors.find(item => item.ip === ip && (item.mobile || '') === normalizedPhone);
    if (!visitor) {
      visitor = { ip, mobile: normalizedPhone || null, firstSeen: now, lastSeen: now, visits: 0 };
      register.visitors.push(visitor);
    }
    visitor.lastSeen = now;
    visitor.visits = (Number(visitor.visits) || 0) + 1;
    if (normalizedPhone) {
      const ipOnly = register.visitors.find(item => item.ip === ip && !item.mobile);
      if (ipOnly && !ipOnly.mobile) {
        visitor.visits += Number(ipOnly.visits) || 0;
        visitor.firstSeen = ipOnly.firstSeen || visitor.firstSeen;
        register.visitors.splice(register.visitors.indexOf(ipOnly), 1);
      }
    }
    if (register.visitors.length > 20000) register.visitors.splice(0, register.visitors.length - 20000);
    return visitor;
  });
}

async function readSupportSettings() {
  try {
    const saved = JSON.parse(await fsp.readFile(supportSettingsPath, 'utf8'));
    const legacyNumbers = Array.isArray(saved.numbers) ? saved.numbers : [];
    const whatsappNumbers = (Array.isArray(saved.whatsappNumbers) ? saved.whatsappNumbers : legacyNumbers).filter(item => /^\d{8,15}$/.test(String(item)));
    const callNumbers = (Array.isArray(saved.callNumbers) ? saved.callNumbers : legacyNumbers).filter(item => /^\d{8,15}$/.test(String(item)));
    const counts = saved.counts && typeof saved.counts === 'object' ? saved.counts : {};
    return { whatsappNumbers, callNumbers, counts, nextIndexes: saved.nextIndexes || { whatsapp: saved.nextIndex || 0, call: saved.nextIndex || 0 } };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read support settings.');
    return { whatsappNumbers: [], callNumbers: [], counts: {}, nextIndexes: { whatsapp: 0, call: 0 } };
  }
}

async function nextSupportNumber(channel) {
  const selectNext = async () => {
    const settings = await readSupportSettings();
    const numbers = channel === 'whatsapp' ? settings.whatsappNumbers : settings.callNumbers;
    if (!numbers.length) return null;
    const index = (Number(settings.nextIndexes[channel]) || 0) % numbers.length;
    const number = numbers[index];
    const nextIndex = (index + 1) % numbers.length;
    const counts = { ...settings.counts };
    const current = counts[number] || { whatsappClicks: 0, callClicks: 0 };
    const key = channel === 'whatsapp' ? 'whatsappClicks' : 'callClicks';
    counts[number] = { ...current, [key]: (Number(current[key]) || 0) + 1 };
    const nextIndexes = { ...settings.nextIndexes, [channel]: nextIndex };
    await fsp.writeFile(supportSettingsPath, JSON.stringify({ whatsappNumbers: settings.whatsappNumbers, callNumbers: settings.callNumbers, counts, nextIndexes, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    return number;
  };
  const current = supportRotationQueue.then(selectNext, selectNext);
  supportRotationQueue = current.then(() => undefined, () => undefined);
  return current;
}

async function handleAdmin(request, response, url) {
  if (url.pathname === '/api/admin/login' && request.method === 'POST') {
    let body;
    try { body = await readJsonRequest(request, 2048); }
    catch { return sendJson(response, 400, { success: false, message: 'Invalid login request.' }); }
    const expected = process.env.BHARATRAIL_ADMIN_PASSWORD || '196196';
    const actual = String(body.password || '');
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(actual);
    const valid = expectedBytes.length === actualBytes.length && crypto.timingSafeEqual(expectedBytes, actualBytes);
    if (!valid) return sendJson(response, 401, { success: false, message: 'Incorrect admin password.' });
    const token = crypto.randomUUID();
    adminSessions.set(token, Date.now() + 4 * 60 * 60 * 1000);
    return sendJson(response, 200, { success: true, token });
  }

  if (!adminAuthorized(request)) return sendJson(response, 401, { success: false, message: 'Admin login has expired. Sign in again.' });
  if (url.pathname === '/api/admin/visitor-register' && request.method === 'GET') {
    const register = await readVisitorRegister();
    register.visitors.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
    register.bans.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return sendJson(response, 200, { success: true, visitors: register.visitors, bans: register.bans });
  }
  if (url.pathname === '/api/admin/customer-bans' && request.method === 'POST') {
    let body;
    try { body = await readJsonRequest(request, 4096); } catch { return sendJson(response, 400, { success: false, message: 'Invalid ban request.' }); }
    const type = body.type === 'ip' ? 'ip' : body.type === 'mobile' ? 'mobile' : '';
    const value = type === 'ip' ? String(body.value || '').trim().replace(/^::ffff:/i, '') : normalizeMobile(body.value);
    if (!type || (type === 'ip' ? !net.isIP(value) : !/^\d{10,15}$/.test(value))) return sendJson(response, 400, { success: false, message: 'Enter a valid IP address or phone number.' });
    if (type === 'ip' && value === getClientIp(request)) return sendJson(response, 400, { success: false, message: 'You cannot block the IP address currently being used for this admin session.' });
    const ban = await updateVisitorRegister(register => {
      let existing = register.bans.find(item => item.type === type && item.value === value);
      if (existing) return existing;
      existing = { type, value, reason: String(body.reason || '').trim().slice(0, 200), createdAt: new Date().toISOString() };
      register.bans.push(existing);
      return existing;
    });
    return sendJson(response, 200, { success: true, ban });
  }
  if (url.pathname === '/api/admin/customer-bans' && request.method === 'DELETE') {
    let body;
    try { body = await readJsonRequest(request, 2048); } catch { return sendJson(response, 400, { success: false, message: 'Invalid unban request.' }); }
    const type = body.type === 'ip' ? 'ip' : body.type === 'mobile' ? 'mobile' : '';
    const value = type === 'ip' ? String(body.value || '').trim().replace(/^::ffff:/i, '') : normalizeMobile(body.value);
    if (!type || !value) return sendJson(response, 400, { success: false, message: 'Choose a valid ban to remove.' });
    await updateVisitorRegister(register => { register.bans = register.bans.filter(item => item.type !== type || item.value !== value); });
    return sendJson(response, 200, { success: true });
  }
  if (url.pathname === '/api/admin/receipt-auth' && request.method === 'POST') {
    let body;
    try { body = await readJsonRequest(request, 2048); }
    catch { return sendJson(response, 400, { success: false, message: 'Invalid receipt PIN request.' }); }
    const expected = process.env.BHARATRAIL_RECEIPT_PASSWORD || 'bharatrail1234';
    const actual = String(body.password || '');
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(actual);
    const valid = expectedBytes.length === actualBytes.length && crypto.timingSafeEqual(expectedBytes, actualBytes);
    if (!valid) return sendJson(response, 401, { success: false, message: 'Incorrect receipt maker password.' });
    return sendJson(response, 200, { success: true });
  }
  if (url.pathname === '/api/admin/payment-settings' && request.method === 'GET') {
    return sendJson(response, 200, { success: true, ...(await readPaymentSettings()) });
  }
  if (url.pathname === '/api/admin/payment-settings' && request.method === 'PUT') {
    let body;
    try { body = await readJsonRequest(request, 48 * 1024 * 1024); }
    catch { return sendJson(response, 400, { success: false, message: 'Invalid or oversized QR upload.' }); }
    const index = Number(body.index);
    const qrCode = String(body.qrCode || '');
    if (!Number.isInteger(index) || index < 0 || index >= 10) return sendJson(response, 400, { success: false, message: 'Choose a QR slot from 1 to 10.' });
    const match = qrCode.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) return sendJson(response, 400, { success: false, message: 'Upload a PNG, JPG, or WebP payment QR image.' });
    const imageBytes = Buffer.from(match[2], 'base64');
    if (!imageBytes.length || imageBytes.length > 3 * 1024 * 1024) {
      return sendJson(response, 400, { success: false, message: 'QR image must be smaller than 3 MB.' });
    }
    const settings = await readPaymentSettings();
    settings.qrs[index] = { qrCode, changeCount: 0, disabled: false };
    await fsp.mkdir(path.dirname(paymentSettingsPath), { recursive: true });
    await fsp.writeFile(paymentSettingsPath, JSON.stringify({ qrs: settings.qrs, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    return sendJson(response, 200, { success: true, message: `Payment QR slot ${index + 1} saved and re-enabled.` });
  }
  if (url.pathname === '/api/admin/support-settings' && request.method === 'GET') {
    const settings = await readSupportSettings();
    let recentContacts = [];
    try { recentContacts = JSON.parse(await fsp.readFile(supportContactsPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') console.error('Could not read support contact history.'); }
    const list = numbers => numbers.map(number => ({ number, ...(settings.counts[number] || {}) }));
    return sendJson(response, 200, { success: true, whatsappContacts: list(settings.whatsappNumbers), callContacts: list(settings.callNumbers), recentContacts: Array.isArray(recentContacts) ? recentContacts.slice(-100).reverse() : [] });
  }
  if (url.pathname === '/api/admin/support-settings' && request.method === 'PUT') {
    let body;
    try { body = await readJsonRequest(request, 16 * 1024); }
    catch { return sendJson(response, 400, { success: false, message: 'Invalid support contact settings.' }); }
    const normalize = values => Array.isArray(values) ? [...new Set(values.map(item => String(item).replace(/\D/g, '')).filter(number => /^\d{8,15}$/.test(number)))].slice(0, 100) : [];
    const whatsappNumbers = normalize(body.whatsappNumbers);
    const callNumbers = normalize(body.callNumbers);
    await fsp.mkdir(path.dirname(supportSettingsPath), { recursive: true });
    const current = await readSupportSettings();
    await fsp.writeFile(supportSettingsPath, JSON.stringify({ whatsappNumbers, callNumbers, counts: current.counts, nextIndexes: current.nextIndexes, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    return sendJson(response, 200, { success: true, whatsappNumbers, callNumbers, message: 'Support contacts saved.' });
  }
  if (url.pathname === '/api/admin/payment-proofs' && request.method === 'GET') {
    await cleanupExpiredPaymentProofs();
    let entries = [];
    try {
      const files = await fsp.readdir(paymentProofsPath);
      const records = await Promise.all(files.filter(name => name.endsWith('.json')).map(async name => {
        try { return JSON.parse(await fsp.readFile(path.join(paymentProofsPath, name), 'utf8')); }
        catch { return null; }
      }));
      entries = records.filter(Boolean);
    } catch (error) {
      if (error.code !== 'ENOENT') return sendJson(response, 500, { success: false, message: 'Could not read payment proof records.' });
    }
    const mobile = (url.searchParams.get('mobile') || '').replace(/\D/g, '');
    if (mobile) entries = entries.filter(record => String(record.mobile || '').replace(/\D/g, '').includes(mobile));
    entries.sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')));
    return sendJson(response, 200, { success: true, proofs: entries });
  }
  if (url.pathname === '/api/admin/payment-proof-status' && request.method === 'PUT') {
    let body;
    try { body = await readJsonRequest(request, 4096); } catch { return sendJson(response, 400, { success: false, message: 'Invalid payment review update.' }); }
    const id = String(body.referenceId || '');
    const status = String(body.status || '');
    if (!/^[a-f0-9-]{36}$/i.test(id) || !['APPROVED', 'DECLINED'].includes(status)) return sendJson(response, 400, { success: false, message: 'Choose a valid payment request and review status.' });
    const metadataPath = path.join(paymentProofsPath, `${id}.json`);
    let proof;
    try { proof = JSON.parse(await fsp.readFile(metadataPath, 'utf8')); } catch { return sendJson(response, 404, { success: false, message: 'Payment proof not found.' }); }
    proof.status = status;
    proof.reviewedAt = new Date().toISOString();
    await fsp.writeFile(metadataPath, JSON.stringify(proof, null, 2), { mode: 0o600 });
    return sendJson(response, 200, { success: true, proof: { referenceId: id, status, reviewedAt: proof.reviewedAt } });
  }
  if (url.pathname === '/api/admin/payment-proof-file' && request.method === 'GET') {
    await cleanupExpiredPaymentProofs();
    const id = url.searchParams.get('referenceId') || '';
    if (!/^[a-f0-9-]{36}$/i.test(id)) return sendJson(response, 400, { success: false, message: 'Invalid proof reference.' });
    let metadata;
    try { metadata = JSON.parse(await fsp.readFile(path.join(paymentProofsPath, `${id}.json`), 'utf8')); }
    catch { return sendJson(response, 404, { success: false, message: 'Payment proof not found.' }); }
    const fileName = String(metadata.fileName || '');
    if (path.basename(fileName) !== fileName || !fileName.startsWith(`${id}.`)) return sendJson(response, 404, { success: false, message: 'Payment proof file not found.' });
    try {
      const proofBytes = await fsp.readFile(path.join(paymentProofsPath, fileName));
      response.writeHead(200, {
        'Content-Type': metadata.mimeType || 'application/octet-stream',
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return response.end(proofBytes);
    } catch { return sendJson(response, 404, { success: false, message: 'Payment proof file not found.' }); }
  }
  return sendJson(response, 404, { success: false, message: 'Admin endpoint not found.' });
}

async function handlePaymentQr(request, response) {
  let body;
  try { body = await readJsonRequest(request, 4096); }
  catch { return sendJson(response, 400, { success: false, message: 'Invalid payment request.' }); }
  const ip = getClientIp(request);
  const mobile = normalizeMobile(body.mobile);
  if (mobile && !/^\d{10,15}$/.test(mobile)) return sendJson(response, 400, { success: false, message: 'Enter a valid phone number.' });
  await recordVisitor(ip, mobile);
  if (isVisitorBanned(await readVisitorRegister(), ip, mobile)) return sendJson(response, 403, { success: false, blocked: true, message: 'This phone number or network is blocked from booking. Contact customer support if this is a mistake.' });
  const settings = await readPaymentSettings();
  const activeSlot = settings.qrs.findIndex(item => item.qrCode && !item.disabled);
  if (activeSlot < 0) return sendJson(response, 503, { success: false, message: 'The admin has not configured an active payment QR yet.' });
  const paymentId = crypto.randomUUID();
  const amount = Number.isFinite(Number(body.amount)) && Number(body.amount) > 0 ? Number(body.amount) : null;
  const expires = Date.now() + 5 * 60 * 1000;
  paymentSessions.set(paymentId, {
    expires,
    trainNumber: String(body.trainNumber || ''),
    amount,
    qrSlot: activeSlot
  });
  return sendJson(response, 200, { success: true, paymentId, amount, expiresAt: new Date(expires).toISOString(), qrCode: settings.qrs[activeSlot].qrCode, qrSlot: activeSlot });
}

async function handleChangePaymentQr(request, response) {
  let body;
  try { body = await readJsonRequest(request, 2048); } catch { return sendJson(response, 400, { success: false, message: 'Invalid payment account change request.' }); }
  const session = paymentSessions.get(String(body.paymentId || ''));
  if (!session || session.expires < Date.now()) return sendJson(response, 400, { success: false, message: 'Payment session expired. Reopen checkout and try again.' });
  const settings = await readPaymentSettings();
  const currentSlot = session.qrSlot;
  const current = settings.qrs[currentSlot];
  if (!current?.qrCode || current.disabled) return sendJson(response, 400, { success: false, message: 'This QR is no longer active.' });
  current.changeCount += 1;
  if (current.changeCount >= 3) current.disabled = true;
  let nextSlot = -1;
  for (let offset = 1; offset < settings.qrs.length; offset++) {
    const candidate = (currentSlot + offset) % settings.qrs.length;
    if (settings.qrs[candidate].qrCode && !settings.qrs[candidate].disabled) { nextSlot = candidate; break; }
  }
  await fsp.writeFile(paymentSettingsPath, JSON.stringify({ qrs: settings.qrs, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  if (nextSlot < 0) return sendJson(response, 503, { success: false, message: 'No other active payment QR is available. Please contact support.' });
  session.qrSlot = nextSlot;
  return sendJson(response, 200, { success: true, qrCode: settings.qrs[nextSlot].qrCode, qrSlot: nextSlot, amount: session.amount, disabledPrevious: current.disabled });
}

async function handleSupportContact(request, response) {
  let body;
  try { body = await readJsonRequest(request, 1024); } catch { body = {}; }
  const channel = body.channel === 'whatsapp' ? 'whatsapp' : body.channel === 'call' ? 'call' : '';
  if (!channel) return sendJson(response, 400, { success: false, message: 'Choose WhatsApp or call support.' });
  const customerPhone = String(body.customerPhone || '').replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(customerPhone)) return sendJson(response, 400, { success: false, message: 'Enter a valid phone number with country code.' });
  const ip = getClientIp(request);
  await recordVisitor(ip, customerPhone);
  if (isVisitorBanned(await readVisitorRegister(), ip, customerPhone)) return sendJson(response, 403, { success: false, blocked: true, message: 'This phone number or network is blocked. Contact customer support if this is a mistake.' });
  const number = await nextSupportNumber(channel);
  if (!number) return sendJson(response, 503, { success: false, message: 'Customer support contacts are not configured yet.' });
  let contacts = [];
  try { contacts = JSON.parse(await fsp.readFile(supportContactsPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') return sendJson(response, 500, { success: false, message: 'Could not save your support request.' }); }
  if (!Array.isArray(contacts)) contacts = [];
  contacts.push({ customerPhone, supportNumber: number, channel, contactedAt: new Date().toISOString() });
  await fsp.writeFile(supportContactsPath, JSON.stringify(contacts.slice(-10000), null, 2), { mode: 0o600 });
  return sendJson(response, 200, { success: true, number });
}

async function handlePaymentProof(request, response) {
  const contentType = request.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) return sendJson(response, 400, { success: false, message: 'Payment proof upload must use multipart form data.' });
  let body;
  try { body = await readRequest(request, 6 * 1024 * 1024); }
  catch { return sendJson(response, 413, { success: false, message: 'Payment proof is larger than 5 MB.' }); }
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const fields = {};
  let proof = null;
  for (const part of body.toString('latin1').split(`--${boundary}`)) {
    const separator = part.indexOf('\r\n\r\n');
    if (separator < 0) continue;
    const headers = part.slice(0, separator);
    const data = part.slice(separator + 4).replace(/\r\n$/, '');
    const name = headers.match(/name="([^"]+)"/i)?.[1];
    if (!name) continue;
    const filename = headers.match(/filename="([^"]*)"/i)?.[1] || '';
    if (name === 'proof' && filename) {
      const mimeType = headers.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase() || '';
      proof = { bytes: Buffer.from(data, 'latin1'), mimeType, filename };
    } else fields[name] = Buffer.from(data, 'latin1').toString('utf8');
  }
  const ip = getClientIp(request);
  const mobile = normalizeMobile(fields.mobile);
  if (mobile) await recordVisitor(ip, mobile);
  if (isVisitorBanned(await readVisitorRegister(), ip, mobile)) return sendJson(response, 403, { success: false, blocked: true, message: 'This phone number or network is blocked from booking. Contact customer support if this is a mistake.' });
  if (!proof || !proof.bytes.length || proof.bytes.length > 5 * 1024 * 1024 ||
      !['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(proof.mimeType)) {
    return sendJson(response, 400, { success: false, message: 'Upload a PNG, JPG, WebP, or PDF payment proof up to 5 MB.' });
  }
  if (!journeyDateAllowed(fields.journeyDate)) {
    return sendJson(response, 400, { success: false, message: 'Choose a journey date from today through the next two months.' });
  }
  const session = paymentSessions.get(fields.paymentId);
  if (!session || session.expires < Date.now()) return sendJson(response, 400, { success: false, message: 'Payment session expired. Reopen the payment QR and try again.' });
  const referenceId = crypto.randomUUID();
  const ext = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'application/pdf': '.pdf' })[proof.mimeType];
  await fsp.mkdir(paymentProofsPath, { recursive: true });
  await fsp.writeFile(path.join(paymentProofsPath, `${referenceId}${ext}`), proof.bytes, { mode: 0o600 });
  const metadata = {
    referenceId, paymentId: fields.paymentId, amount: session.amount,
    trainNumber: fields.trainNumber, trainName: fields.trainName, classCode: fields.classCode,
    journeyDate: fields.journeyDate, fromStation: fields.fromStation, toStation: fields.toStation,
    departure: fields.departure, arrival: fields.arrival, transactionRef: fields.transactionRef,
    quota: fields.quota, distance: fields.distance,
    mobile: fields.mobile, email: fields.email, mimeType: proof.mimeType, fileName: `${referenceId}${ext}`,
    travellers: fields.travellers, receivedAt: new Date().toISOString(), status: 'PENDING_REVIEW'
  };
  await fsp.writeFile(path.join(paymentProofsPath, `${referenceId}.json`), JSON.stringify(metadata, null, 2), { mode: 0o600 });
  paymentSessions.delete(fields.paymentId);
  return sendJson(response, 200, { success: true, status: 'PENDING_REVIEW', referenceId });
}

async function proxyTrainData(url, response) {
  const number = url.searchParams.get('number') || '';
  const date = url.searchParams.get('date') || '';
  const type = url.searchParams.get('type') || 'status';
  const allowedTypes = new Set(['status', 'schedule', 'route', 'coaches', 'fare']);
  if (!/^\d{5}$/.test(number)) {
    return sendJson(response, 400, { status: 'ERROR', error: { message: 'Enter a valid 5-digit train number.' } });
  }
  if (!validDate(date)) {
    return sendJson(response, 400, { status: 'ERROR', error: { message: 'Enter a valid journey date.' } });
  }
  if (!allowedTypes.has(type)) {
    return sendJson(response, 400, { status: 'ERROR', error: { message: 'Unsupported train data request.' } });
  }

  const apiKey = process.env.BHARATRAIL_RAILWAY_ENGINE_API_KEY;
  if (!apiKey) {
    return sendJson(response, 503, { status: 'ERROR', error: { message: 'Live train and fare data is not configured on this server yet.' } });
  }

  const upstreamUrl = new URL(`https://railway-engine.apkscope.workers.dev/v1/train/${encodeURIComponent(number)}/${type}`);
  if (['status', 'schedule', 'route'].includes(type)) upstreamUrl.searchParams.set('date', date);
  if (type === 'coaches') {
    upstreamUrl.searchParams.set('blueprints', 'false');
    upstreamUrl.searchParams.set('stationVariations', 'false');
  }
  if (type === 'fare') {
    const source = url.searchParams.get('source') || '';
    const destination = url.searchParams.get('destination') || '';
    const fareClass = url.searchParams.get('class') || '';
    const quota = url.searchParams.get('quota') || 'GN';
    if (!/^[A-Z0-9]{2,6}$/i.test(source) || !/^[A-Z0-9]{2,6}$/i.test(destination) ||
        !/^[A-Z0-9]{1,4}$/i.test(fareClass) || !/^[A-Z0-9]{1,4}$/i.test(quota)) {
      return sendJson(response, 400, { status: 'ERROR', error: { message: 'A valid route, class, and quota are required for a fare quote.' } });
    }
    upstreamUrl.searchParams.set('source', source.toUpperCase());
    upstreamUrl.searchParams.set('destination', destination.toUpperCase());
    upstreamUrl.searchParams.set('class', fareClass.toUpperCase());
    upstreamUrl.searchParams.set('quota', quota.toUpperCase());
    upstreamUrl.searchParams.set('date', date);
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { Accept: 'application/json', 'x-api-key': apiKey },
      signal: AbortSignal.timeout(12000),
      redirect: 'error'
    });
    const text = await upstream.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      console.error(`Train provider returned non-JSON data (HTTP ${upstream.status}).`);
      return sendJson(response, 502, { status: 'ERROR', error: { message: 'The train provider returned an unreadable response.' } });
    }
    sendJson(response, upstream.status, payload);
  } catch (error) {
    console.error(`Train provider request failed: ${error.message}`);
    sendJson(response, 502, { status: 'ERROR', error: { message: 'The train data provider did not respond. Please try again shortly.' } });
  }
}

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin || '';
  const isLocalOrigin = origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  if (isLocalOrigin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, HEAD, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(isLocalOrigin ? 204 : 403);
    return response.end();
  }
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const clientIp = getClientIp(request);
  if (!requestUrl.pathname.startsWith('/api/admin/')) {
    const register = await readVisitorRegister();
    if (isVisitorBanned(register, clientIp)) {
      if (requestUrl.pathname.startsWith('/api/')) return sendJson(response, 403, { success: false, blocked: true, message: 'This IP address cannot access the site.' });
      response.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return response.end('<!doctype html><meta charset="utf-8"><title>Access unavailable</title><main style="font:16px Arial,sans-serif;max-width:560px;margin:12vh auto;padding:24px"><h1>Access unavailable</h1><p>This connection cannot access Bharatrail. Contact customer support if you think this is a mistake.</p></main>');
    }
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/visitor/identify') {
    let body;
    try { body = await readJsonRequest(request, 2048); } catch { return sendJson(response, 400, { success: false, message: 'Invalid visitor details.' }); }
    const mobile = normalizeMobile(body.mobile);
    if (!/^\d{10,15}$/.test(mobile)) return sendJson(response, 400, { success: false, message: 'Enter a valid phone number.' });
    await recordVisitor(clientIp, mobile);
    if (isVisitorBanned(await readVisitorRegister(), clientIp, mobile)) return sendJson(response, 403, { success: false, blocked: true, message: 'This phone number or network is blocked. Contact customer support if this is a mistake.' });
    return sendJson(response, 200, { success: true });
  }
  if (request.method === 'GET' && ['/', '/index.html'].includes(requestUrl.pathname)) await recordVisitor(clientIp);
  if (requestUrl.pathname === '/api/trains.php') return proxyTrainData(requestUrl, response);
  if (requestUrl.pathname.startsWith('/api/admin/')) return handleAdmin(request, response, requestUrl);
  if (requestUrl.pathname === '/api/payments/qr' && request.method === 'POST') return handlePaymentQr(request, response);
  if (requestUrl.pathname === '/api/customer/payment-status' && request.method === 'GET') {
    const id = requestUrl.searchParams.get('referenceId') || '';
    if (!/^[a-f0-9-]{36}$/i.test(id)) return sendJson(response, 400, { success: false, message: 'Invalid payment request.' });
    try {
      const proof = JSON.parse(await fsp.readFile(path.join(paymentProofsPath, `${id}.json`), 'utf8'));
      const receipt = proof.status === 'APPROVED' ? {
        referenceId: proof.referenceId, receivedAt: proof.receivedAt, reviewedAt: proof.reviewedAt,
        amount: proof.amount, trainNumber: proof.trainNumber, trainName: proof.trainName,
        classCode: proof.classCode, journeyDate: proof.journeyDate, fromStation: proof.fromStation,
        toStation: proof.toStation, departure: proof.departure, arrival: proof.arrival,
        transactionRef: proof.transactionRef, mobile: proof.mobile, email: proof.email,
        quota: proof.quota, distance: proof.distance,
        travellers: proof.travellers
      } : null;
      return sendJson(response, 200, { success: true, status: proof.status, reviewedAt: proof.reviewedAt || null, receipt });
    } catch { return sendJson(response, 404, { success: false, message: 'Payment request was not found or its proof expired.' }); }
  }
  if (requestUrl.pathname === '/api/payments/change-qr' && request.method === 'POST') return handleChangePaymentQr(request, response);
  if (requestUrl.pathname === '/api/support/next' && request.method === 'POST') return handleSupportContact(request, response);
  if (requestUrl.pathname === '/api/bookings/payment-proof' && request.method === 'POST') return handlePaymentProof(request, response);
  if (requestUrl.pathname.startsWith('/api/')) return sendJson(response, 404, { success: false, message: 'API endpoint not found.' });
  if (!['GET', 'HEAD'].includes(request.method || '')) {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    return response.end();
  }

  let decodedPath;
  try { decodedPath = decodeURIComponent(requestUrl.pathname); }
  catch { response.writeHead(400); return response.end('Invalid URL path.'); }
  const requestedPath = decodedPath === '/' ? '/index.html' : decodedPath;
  if (requestedPath.startsWith('/.') || requestedPath.startsWith('/api/') ||
      requestedPath.startsWith('/scripts/') || requestedPath === '/server.mjs' ||
      requestedPath.startsWith('/data/payment-') || requestedPath === '/data/support-settings.json' ||
      requestedPath === '/data/customer-support-contacts.json' || requestedPath === '/data/visitor-register.json') {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return response.end('Not found.');
  }
  const filePath = path.resolve(root, `.${requestedPath}`);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403);
    return response.end('Forbidden.');
  }
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return response.end('Not found.');
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    if (request.method === 'HEAD') return response.end();
    fs.createReadStream(filePath).pipe(response);
  });
});

async function startServer() {
  await fsp.mkdir(storagePath, { recursive: true });
  if (storagePath !== bundledDataPath) {
    try {
      await fsp.access(paymentSettingsPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        await fsp.copyFile(path.join(bundledDataPath, 'payment-settings.json'), paymentSettingsPath, fs.constants.COPYFILE_EXCL);
      } catch (copyError) {
        if (copyError.code !== 'ENOENT' && copyError.code !== 'EEXIST') throw copyError;
      }
    }
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  console.log(`Bharatrail running at http://${host}:${port}`);
  cleanupExpiredPaymentProofs().catch(() => console.error('Payment proof cleanup failed.'));
  const cleanupTimer = setInterval(() => cleanupExpiredPaymentProofs().catch(() => console.error('Payment proof cleanup failed.')), 24 * 60 * 60 * 1000);
  cleanupTimer.unref();
  if (!process.env.BHARATRAIL_RAILWAY_ENGINE_API_KEY) {
    console.log('Live status and fare lookups return a clear setup message until the server API key is configured.');
  }
}

startServer().catch(error => {
  console.error(`Bharatrail could not start: ${error.message}`);
  process.exitCode = 1;
});
