import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = Number(process.env.PORT || 3000);
const defaultDbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'miniapp.sqlite');
const defaultStaffOpenId = 'staff-openid-v1';
const allowedStaffOpenIds = new Set(
  String(process.env.STAFF_OPEN_IDS || process.env.STAFF_OPEN_ID || defaultStaffOpenId)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
);

const seedGalleryItems = [
  {
    id: 'gallery-aurora',
    title: '极光猫眼',
    imageUrl: 'https://example.com/images/aurora-cat-eye.jpg',
    tags: ['猫眼', '通勤', '热门'],
    priceFrom: 198,
    serviceId: 'svc-design',
    serviceName: '轻奢款式设计',
    ctaText: '预约同款',
    sortOrder: 1,
    status: 'active'
  },
  {
    id: 'gallery-french',
    title: '奶油法式',
    imageUrl: 'https://example.com/images/cream-french.jpg',
    tags: ['法式', '温柔', '约会'],
    priceFrom: 228,
    serviceId: 'svc-french',
    serviceName: '法式清透款',
    ctaText: '立即预约',
    sortOrder: 2,
    status: 'active'
  },
  {
    id: 'gallery-glossy',
    title: '琥珀镜面',
    imageUrl: 'https://example.com/images/amber-glossy.jpg',
    tags: ['镜面', '轻奢', '人气'],
    priceFrom: 268,
    serviceId: 'svc-design',
    serviceName: '轻奢款式设计',
    ctaText: '预约同款',
    sortOrder: 3,
    status: 'active'
  }
];

const defaultDailySlots = ['10:00-11:00', '11:30-12:30', '14:00-15:00'];
const defaultAdvanceOpenDays = 14;

const appointmentAllowedFields = new Set([
  'appointmentDate',
  'timeSlot',
  'customerName',
  'phone',
  'note'
]);

const bookingRuleAllowedFields = new Set([
  'advanceOpenDays',
  'closedDates',
  'dailySlots',
  'updatedAt'
]);

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Customer-OpenId, X-Staff-OpenId',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,OPTIONS'
  });

  if (statusCode === 204) {
    res.end();
    return;
  }

  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) {
    return String(value[0] || '').trim();
  }
  return String(value || '').trim();
}

function getCustomerOpenId(req) {
  return normalizeHeaderValue(req.headers['x-customer-openid']);
}

function getStaffOpenId(req) {
  return normalizeHeaderValue(req.headers['x-staff-openid']);
}

function sendCustomerUnauthorized(res) {
  sendJson(res, 401, {
    error: 'Customer unauthorized',
    code: 'CUSTOMER_UNAUTHORIZED'
  });
}

function requireCustomer(req, res) {
  const customerOpenId = getCustomerOpenId(req);
  if (!customerOpenId) {
    sendCustomerUnauthorized(res);
    return null;
  }
  return customerOpenId;
}

function requireStaff(req, res) {
  const staffOpenId = getStaffOpenId(req);
  if (!staffOpenId || !allowedStaffOpenIds.has(staffOpenId)) {
    sendJson(res, 401, {
      error: 'Staff unauthorized',
      code: 'STAFF_UNAUTHORIZED'
    });
    return null;
  }
  return staffOpenId;
}

function ensureDirForFile(filePath) {
  if (filePath === ':memory:') {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function tableExists(db, tableName) {
  return Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = :tableName")
      .get({ tableName })
  );
}

function tableColumns(db, tableName) {
  if (!tableExists(db, tableName)) {
    return [];
  }
  return db.prepare(`PRAGMA table_info(${tableName})`).all();
}

function columnExists(db, tableName, columnName) {
  return tableColumns(db, tableName).some((column) => column.name === columnName);
}

function ensureColumn(db, tableName, columnName, definition) {
  if (!columnExists(db, tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function parseDateValue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  date.setHours(0, 0, 0, 0);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function formatDateValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  next.setHours(0, 0, 0, 0);
  return next;
}

function diffCalendarDays(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

function isValidDate(value) {
  return Boolean(parseDateValue(value));
}

function parseTimeSlot(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || '').trim());
  if (!match) {
    return null;
  }

  const startHours = Number(match[1]);
  const startMinutes = Number(match[2]);
  const endHours = Number(match[3]);
  const endMinutes = Number(match[4]);
  const startTotalMinutes = startHours * 60 + startMinutes;
  const endTotalMinutes = endHours * 60 + endMinutes;

  if (startTotalMinutes >= endTotalMinutes) {
    return null;
  }

  return {
    slot: `${match[1]}:${match[2]}-${match[3]}:${match[4]}`,
    startMinutes: startTotalMinutes,
    endMinutes: endTotalMinutes
  };
}

function isValidTimeSlot(value) {
  return Boolean(parseTimeSlot(value));
}

function sortTimeSlots(slots) {
  return [...slots].sort((left, right) => {
    const leftSlot = parseTimeSlot(left);
    const rightSlot = parseTimeSlot(right);
    if (!leftSlot || !rightSlot) {
      return String(left).localeCompare(String(right));
    }
    if (leftSlot.startMinutes !== rightSlot.startMinutes) {
      return leftSlot.startMinutes - rightSlot.startMinutes;
    }
    return leftSlot.endMinutes - rightSlot.endMinutes;
  });
}

function isValidIsoDatetime(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function defaultBookingRules() {
  return {
    advanceOpenDays: defaultAdvanceOpenDays,
    closedDates: [],
    dailySlots: [...defaultDailySlots],
    updatedAt: new Date().toISOString()
  };
}

function validateAdvanceOpenDays(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('advanceOpenDays must be a non-negative integer');
  }
  return value;
}

function normalizeClosedDates(value) {
  if (!Array.isArray(value)) {
    throw new Error('closedDates must be an array');
  }

  const deduped = new Set();
  for (const rawDate of value) {
    if (typeof rawDate !== 'string') {
      throw new Error('closedDates must contain YYYY-MM-DD strings');
    }
    const date = rawDate.trim();
    if (!isValidDate(date)) {
      throw new Error(`Invalid closed date: ${date}`);
    }
    deduped.add(date);
  }

  return [...deduped].sort((left, right) => left.localeCompare(right));
}

function normalizeDailySlots(value) {
  if (!Array.isArray(value)) {
    throw new Error('dailySlots must be an array');
  }

  const parsedSlots = [];
  const seen = new Set();

  for (const rawSlot of value) {
    if (typeof rawSlot !== 'string') {
      throw new Error('dailySlots must contain HH:mm-HH:mm strings');
    }

    const parsedSlot = parseTimeSlot(rawSlot.trim());
    if (!parsedSlot) {
      throw new Error(`Invalid daily slot: ${String(rawSlot).trim()}`);
    }

    if (seen.has(parsedSlot.slot)) {
      throw new Error(`Duplicate daily slot: ${parsedSlot.slot}`);
    }

    seen.add(parsedSlot.slot);
    parsedSlots.push(parsedSlot);
  }

  parsedSlots.sort((left, right) => {
    if (left.startMinutes !== right.startMinutes) {
      return left.startMinutes - right.startMinutes;
    }
    return left.endMinutes - right.endMinutes;
  });

  for (let index = 1; index < parsedSlots.length; index += 1) {
    const previous = parsedSlots[index - 1];
    const current = parsedSlots[index];
    if (current.startMinutes < previous.endMinutes) {
      throw new Error(`Overlapping daily slots: ${previous.slot} and ${current.slot}`);
    }
  }

  return parsedSlots.map((slot) => slot.slot);
}

function normalizeStoredBookingRules(row) {
  if (!row) {
    return defaultBookingRules();
  }

  const advanceOpenDays = validateAdvanceOpenDays(Number(row.advance_open_days));
  const closedDates = normalizeClosedDates(JSON.parse(row.closed_dates_json || '[]'));
  const dailySlots = normalizeDailySlots(JSON.parse(row.daily_slots_json || '[]'));
  const updatedAt = isValidIsoDatetime(row.updated_at)
    ? new Date(row.updated_at).toISOString()
    : new Date().toISOString();

  return {
    advanceOpenDays,
    closedDates,
    dailySlots,
    updatedAt
  };
}

function normalizeIncomingBookingRules(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Invalid booking rules payload');
  }

  const unexpectedFields = Object.keys(body).filter((key) => !bookingRuleAllowedFields.has(key));
  if (unexpectedFields.length > 0) {
    throw new Error(`Unexpected booking rule fields: ${unexpectedFields.join(', ')}`);
  }

  if (typeof body.updatedAt !== 'undefined' && body.updatedAt !== null && body.updatedAt !== '') {
    if (!isValidIsoDatetime(body.updatedAt)) {
      throw new Error('updatedAt must be an ISO datetime when provided');
    }
  }

  return {
    advanceOpenDays: validateAdvanceOpenDays(body.advanceOpenDays),
    closedDates: normalizeClosedDates(body.closedDates),
    dailySlots: normalizeDailySlots(body.dailySlots),
    updatedAt: new Date().toISOString()
  };
}

function isActiveLegacySlotStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '' || normalized === 'active';
}

function createAppointmentsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      service_id TEXT NOT NULL DEFAULT '',
      service_name TEXT NOT NULL DEFAULT '',
      artist_id TEXT NOT NULL DEFAULT '',
      artist_name TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      time_slot TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      customer_open_id TEXT NOT NULL DEFAULT '',
      reviewed_at TEXT,
      reviewed_by TEXT,
      review_note TEXT NOT NULL DEFAULT ''
    )
  `);
}

function buildLegacyAppointmentId(row, index) {
  const id = String(row.id || '').trim();
  if (id) {
    return id;
  }

  const customerOpenId = String(row.customer_open_id || row.customerOpenId || '').trim();
  if (customerOpenId) {
    return `legacy-${customerOpenId}`;
  }

  return `legacy-appointment-${index + 1}`;
}

function migrateAppointmentsTable(db) {
  if (!tableExists(db, 'appointments')) {
    createAppointmentsTable(db);
    return;
  }

  const columns = tableColumns(db, 'appointments');
  const hasIdColumn = columns.some((column) => column.name === 'id');

  if (!hasIdColumn) {
    const backupTableName = `appointments_legacy_${Date.now()}`;
    db.exec(`ALTER TABLE appointments RENAME TO ${backupTableName}`);
    createAppointmentsTable(db);

    const rows = db.prepare(`SELECT * FROM ${backupTableName}`).all();
    const insertStatement = db.prepare(`
      INSERT INTO appointments (
        id,
        customer_name,
        phone,
        service_id,
        service_name,
        artist_id,
        artist_name,
        date,
        time_slot,
        note,
        status,
        created_at,
        customer_open_id,
        reviewed_at,
        reviewed_by,
        review_note
      ) VALUES (
        :id,
        :customerName,
        :phone,
        :serviceId,
        :serviceName,
        :artistId,
        :artistName,
        :date,
        :timeSlot,
        :note,
        :status,
        :createdAt,
        :customerOpenId,
        :reviewedAt,
        :reviewedBy,
        :reviewNote
      )
    `);

    for (const [index, row] of rows.entries()) {
      insertStatement.run({
        id: buildLegacyAppointmentId(row, index),
        customerName: String(row.customer_name || row.customerName || ''),
        phone: String(row.phone || ''),
        serviceId: String(row.service_id || row.serviceId || ''),
        serviceName: String(row.service_name || row.serviceName || ''),
        artistId: String(row.artist_id || row.artistId || ''),
        artistName: String(row.artist_name || row.artistName || ''),
        date: String(row.date || ''),
        timeSlot: String(row.time_slot || row.timeSlot || ''),
        note: String(row.note || ''),
        status: String(row.status || 'pending'),
        createdAt: String(row.created_at || row.createdAt || new Date().toISOString()),
        customerOpenId: String(row.customer_open_id || row.customerOpenId || ''),
        reviewedAt: row.reviewed_at || row.reviewedAt || null,
        reviewedBy: String(row.reviewed_by || row.reviewedBy || ''),
        reviewNote: String(row.review_note || row.reviewNote || '')
      });
    }

    db.exec(`DROP TABLE ${backupTableName}`);
  }

  ensureColumn(db, 'appointments', 'customer_name', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'appointments', 'phone', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'appointments', 'service_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'appointments', 'service_name', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'appointments', 'artist_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'appointments', 'artist_name', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'appointments', 'customer_open_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'appointments', 'reviewed_at', 'TEXT');
  ensureColumn(db, 'appointments', 'reviewed_by', 'TEXT');
  ensureColumn(db, 'appointments', 'review_note', "TEXT NOT NULL DEFAULT ''");
}

function resolveApprovedSlotConflicts(db) {
  const rows = db.prepare(`
    SELECT id, date, time_slot, created_at
    FROM appointments
    WHERE status = 'approved'
    ORDER BY date ASC,
             time_slot ASC,
             datetime(created_at) ASC,
             id ASC
  `).all();

  const seen = new Set();
  const rejectStatement = db.prepare(`
    UPDATE appointments
    SET status = 'rejected',
        reviewed_at = COALESCE(reviewed_at, :reviewedAt),
        reviewed_by = COALESCE(NULLIF(reviewed_by, ''), 'migration'),
        review_note = CASE
          WHEN COALESCE(review_note, '') = '' THEN :reviewNote
          ELSE review_note || ' | ' || :reviewNote
        END
    WHERE id = :id
  `);
  const reviewedAt = new Date().toISOString();
  const reviewNote = 'Migrated duplicate approved slot';

  for (const row of rows) {
    const key = `${row.date}__${row.time_slot}`;
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }

    rejectStatement.run({
      id: row.id,
      reviewedAt,
      reviewNote
    });
  }
}

function createBookingRulesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS booking_rules (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      advance_open_days INTEGER NOT NULL,
      closed_dates_json TEXT NOT NULL,
      daily_slots_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

function insertBookingRules(db, rules) {
  db.prepare(`
    INSERT INTO booking_rules (
      id,
      advance_open_days,
      closed_dates_json,
      daily_slots_json,
      updated_at
    ) VALUES (
      1,
      :advanceOpenDays,
      :closedDatesJson,
      :dailySlotsJson,
      :updatedAt
    )
  `).run({
    advanceOpenDays: rules.advanceOpenDays,
    closedDatesJson: JSON.stringify(rules.closedDates),
    dailySlotsJson: JSON.stringify(rules.dailySlots),
    updatedAt: rules.updatedAt
  });
}

function deriveBookingRulesFromLegacyAvailabilitySlots(db) {
  if (!tableExists(db, 'availability_slots')) {
    return null;
  }

  const rows = db.prepare(`
    SELECT date, time_slot, status
    FROM availability_slots
    ORDER BY date ASC, time_slot ASC, id ASC
  `).all();

  const activeRows = rows.filter((row) => isActiveLegacySlotStatus(row.status));
  if (activeRows.length === 0) {
    return null;
  }

  const activeByDate = new Map();
  const allDailySlots = new Set();
  const today = startOfToday();
  let maxAdvanceOpenDays = 0;

  for (const row of activeRows) {
    const date = String(row.date || '').trim();
    const parsedDate = parseDateValue(date);
    const parsedSlot = parseTimeSlot(String(row.time_slot || '').trim());

    if (!parsedDate || !parsedSlot) {
      continue;
    }

    const normalizedDate = formatDateValue(parsedDate);
    allDailySlots.add(parsedSlot.slot);

    if (!activeByDate.has(normalizedDate)) {
      activeByDate.set(normalizedDate, new Set());
    }
    activeByDate.get(normalizedDate).add(parsedSlot.slot);

    const diffDays = diffCalendarDays(today, parsedDate);
    if (diffDays > maxAdvanceOpenDays) {
      maxAdvanceOpenDays = diffDays;
    }
  }

  if (allDailySlots.size === 0) {
    return null;
  }

  const dailySlots = normalizeDailySlots([...allDailySlots]);
  const closedDates = [];

  for (let offset = 0; offset <= maxAdvanceOpenDays; offset += 1) {
    const date = formatDateValue(addDays(today, offset));
    const availableSlots = activeByDate.get(date) || new Set();
    const hasAllSlots = dailySlots.every((slot) => availableSlots.has(slot));

    if (!hasAllSlots) {
      closedDates.push(date);
    }
  }

  return {
    advanceOpenDays: maxAdvanceOpenDays,
    closedDates,
    dailySlots,
    updatedAt: new Date().toISOString()
  };
}

function migrateBookingRules(db) {
  createBookingRulesTable(db);

  const existingRow = db.prepare('SELECT * FROM booking_rules WHERE id = 1').get();
  if (!existingRow) {
    const derivedRules = deriveBookingRulesFromLegacyAvailabilitySlots(db) || defaultBookingRules();
    insertBookingRules(db, derivedRules);
    return;
  }

  const normalizedRules = normalizeStoredBookingRules(existingRow);
  db.prepare(`
    UPDATE booking_rules
    SET advance_open_days = :advanceOpenDays,
        closed_dates_json = :closedDatesJson,
        daily_slots_json = :dailySlotsJson,
        updated_at = :updatedAt
    WHERE id = 1
  `).run({
    advanceOpenDays: normalizedRules.advanceOpenDays,
    closedDatesJson: JSON.stringify(normalizedRules.closedDates),
    dailySlotsJson: JSON.stringify(normalizedRules.dailySlots),
    updatedAt: normalizedRules.updatedAt
  });
}

function createIndexes(db) {
  resolveApprovedSlotConflicts(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_appointments_customer_open_id
      ON appointments(customer_open_id, created_at DESC)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_appointments_status_created_at
      ON appointments(status, created_at DESC)
  `);
  db.exec('DROP INDEX IF EXISTS idx_appointments_slot_active');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_slot_active
      ON appointments(date, time_slot)
      WHERE status = 'approved'
  `);
}

function setupDatabase(dbPath = defaultDbPath) {
  ensureDirForFile(dbPath);
  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS gallery_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      image_url TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      price_from INTEGER NOT NULL,
      service_id TEXT NOT NULL,
      service_name TEXT NOT NULL,
      cta_text TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      status TEXT NOT NULL
    )
  `);

  migrateAppointmentsTable(db);
  migrateBookingRules(db);
  createIndexes(db);
  seedIfEmpty(db);

  return db;
}

function seedIfEmpty(db) {
  const galleryCount = db.prepare('SELECT COUNT(*) AS count FROM gallery_items').get().count;
  if (galleryCount === 0) {
    const insertGalleryItem = db.prepare(`
      INSERT INTO gallery_items (
        id,
        title,
        image_url,
        tags_json,
        price_from,
        service_id,
        service_name,
        cta_text,
        sort_order,
        status
      ) VALUES (
        :id,
        :title,
        :imageUrl,
        :tagsJson,
        :priceFrom,
        :serviceId,
        :serviceName,
        :ctaText,
        :sortOrder,
        :status
      )
    `);

    for (const item of seedGalleryItems) {
      insertGalleryItem.run({
        id: item.id,
        title: item.title,
        imageUrl: item.imageUrl,
        tagsJson: JSON.stringify(item.tags),
        priceFrom: item.priceFrom,
        serviceId: item.serviceId,
        serviceName: item.serviceName,
        ctaText: item.ctaText,
        sortOrder: item.sortOrder,
        status: item.status
      });
    }
  }

  const bookingRulesCount = db.prepare('SELECT COUNT(*) AS count FROM booking_rules').get().count;
  if (bookingRulesCount === 0) {
    insertBookingRules(db, defaultBookingRules());
  }
}

function isSqliteConstraintError(error) {
  const message = String(error?.message || '');
  return message.includes('constraint') || message.includes('UNIQUE');
}

function normalizeAppointment(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    customerOpenId: row.customer_open_id,
    customerName: row.customer_name,
    phone: row.phone,
    date: row.date,
    timeSlot: row.time_slot,
    note: row.note || '',
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at || null,
    reviewedBy: row.reviewed_by || null,
    reviewNote: row.review_note || ''
  };
}

function normalizeGalleryItem(row) {
  return {
    id: row.id,
    title: row.title,
    imageUrl: row.image_url,
    tags: JSON.parse(row.tags_json),
    priceFrom: row.price_from,
    serviceId: row.service_id,
    serviceName: row.service_name,
    ctaText: row.cta_text,
    sortOrder: row.sort_order,
    status: row.status
  };
}

function normalizeAvailabilityItem(date, timeSlot) {
  return {
    date,
    timeSlot,
    status: 'active'
  };
}

function createAppContext({ dbPath = defaultDbPath } = {}) {
  const db = setupDatabase(dbPath);

  const queries = {
    listGallery: db.prepare(`
      SELECT *
      FROM gallery_items
      WHERE status = 'active'
      ORDER BY sort_order ASC, id ASC
    `),
    getBookingRulesRow: db.prepare('SELECT * FROM booking_rules WHERE id = 1'),
    upsertBookingRules: db.prepare(`
      INSERT INTO booking_rules (
        id,
        advance_open_days,
        closed_dates_json,
        daily_slots_json,
        updated_at
      ) VALUES (
        1,
        :advanceOpenDays,
        :closedDatesJson,
        :dailySlotsJson,
        :updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        advance_open_days = excluded.advance_open_days,
        closed_dates_json = excluded.closed_dates_json,
        daily_slots_json = excluded.daily_slots_json,
        updated_at = excluded.updated_at
    `),
    listOccupiedSlotsByDateRange: db.prepare(`
      SELECT date, time_slot
      FROM appointments
      WHERE status = 'approved'
        AND date >= :startDate
        AND date <= :endDate
    `),
    getApprovedBlockingAppointment: db.prepare(`
      SELECT id
      FROM appointments
      WHERE date = :date
        AND time_slot = :timeSlot
        AND status = 'approved'
      LIMIT 1
    `),
    createAppointment: db.prepare(`
      INSERT INTO appointments (
        id,
        customer_name,
        phone,
        service_id,
        service_name,
        artist_id,
        artist_name,
        date,
        time_slot,
        note,
        status,
        created_at,
        customer_open_id,
        review_note
      ) VALUES (
        :id,
        :customerName,
        :phone,
        '',
        '',
        '',
        '',
        :date,
        :timeSlot,
        :note,
        :status,
        :createdAt,
        :customerOpenId,
        ''
      )
    `),
    getAppointmentById: db.prepare('SELECT * FROM appointments WHERE id = :id'),
    listCustomerAppointments: db.prepare(`
      SELECT *
      FROM appointments
      WHERE customer_open_id = :customerOpenId
      ORDER BY datetime(created_at) DESC, id DESC
    `),
    listStaffAppointments: db.prepare(`
      SELECT *
      FROM appointments
      ORDER BY datetime(created_at) DESC, id DESC
    `),
    updateReviewedAppointment: db.prepare(`
      UPDATE appointments
      SET status = :status,
          reviewed_at = :reviewedAt,
          reviewed_by = :reviewedBy,
          review_note = :reviewNote
      WHERE id = :id
    `)
  };

  return { db, queries };
}

function getBookingRules(queries) {
  return normalizeStoredBookingRules(queries.getBookingRulesRow.get());
}

function storeBookingRules(queries, rules) {
  queries.upsertBookingRules.run({
    advanceOpenDays: rules.advanceOpenDays,
    closedDatesJson: JSON.stringify(rules.closedDates),
    dailySlotsJson: JSON.stringify(rules.dailySlots),
    updatedAt: rules.updatedAt
  });
}

function buildAppointmentPayload(body, customerOpenId) {
  return {
    id: `apt-${randomUUID()}`,
    customerOpenId,
    customerName: String(body.customerName || '').trim(),
    phone: String(body.phone || '').trim(),
    date: String(body.appointmentDate || '').trim(),
    timeSlot: String(body.timeSlot || '').trim(),
    note: String(body.note || '').trim(),
    status: 'pending',
    createdAt: new Date().toISOString()
  };
}

function normalizeReviewStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'approve') {
    return 'approved';
  }
  if (normalized === 'reject') {
    return 'rejected';
  }
  if (normalized === 'approved' || normalized === 'rejected') {
    return normalized;
  }
  return '';
}

function findUnexpectedFields(body, allowedFields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return [];
  }

  return Object.keys(body).filter((key) => !allowedFields.has(key));
}

function isDateBookable(date, rules, today = startOfToday()) {
  const parsedDate = parseDateValue(date);
  if (!parsedDate) {
    return false;
  }

  const diffDays = diffCalendarDays(today, parsedDate);
  if (diffDays < 0 || diffDays > rules.advanceOpenDays) {
    return false;
  }

  return !rules.closedDates.includes(formatDateValue(parsedDate));
}

function isSlotDefinedInRules(timeSlot, rules) {
  return rules.dailySlots.includes(timeSlot);
}

function buildOpenDates(rules, specificDate = '') {
  if (specificDate) {
    return isDateBookable(specificDate, rules) ? [specificDate] : [];
  }

  const today = startOfToday();
  const dates = [];
  for (let offset = 0; offset <= rules.advanceOpenDays; offset += 1) {
    const date = formatDateValue(addDays(today, offset));
    if (!rules.closedDates.includes(date)) {
      dates.push(date);
    }
  }
  return dates;
}

function listAvailabilityItems(queries, rules, specificDate = '') {
  const openDates = buildOpenDates(rules, specificDate);
  if (openDates.length === 0 || rules.dailySlots.length === 0) {
    return [];
  }

  const rangeStart = openDates[0];
  const rangeEnd = openDates[openDates.length - 1];
  const occupiedRows = queries.listOccupiedSlotsByDateRange.all({
    startDate: rangeStart,
    endDate: rangeEnd
  });
  const occupiedSlots = new Set(
    occupiedRows.map((row) => `${row.date}__${row.time_slot}`)
  );

  const items = [];
  for (const date of openDates) {
    for (const timeSlot of sortTimeSlots(rules.dailySlots)) {
      if (occupiedSlots.has(`${date}__${timeSlot}`)) {
        continue;
      }
      items.push(normalizeAvailabilityItem(date, timeSlot));
    }
  }

  return items;
}

async function handleRequest(req, res, context) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const { queries } = context;

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'miniapp-server',
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/gallery') {
    const items = queries.listGallery.all().map(normalizeGalleryItem);
    sendJson(res, 200, { items });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/staff/booking-rules') {
    if (!requireStaff(req, res)) {
      return;
    }

    sendJson(res, 200, getBookingRules(queries));
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/v1/staff/booking-rules') {
    if (!requireStaff(req, res)) {
      return;
    }

    try {
      const body = await readJson(req);
      const rules = normalizeIncomingBookingRules(body);
      storeBookingRules(queries, rules);
      sendJson(res, 200, rules);
      return;
    } catch (error) {
      sendJson(res, 400, {
        error: error.message || 'Bad request',
        code: 'INVALID_BOOKING_RULES'
      });
      return;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/availability') {
    const date = String(url.searchParams.get('date') || '').trim();
    if (date && !isValidDate(date)) {
      sendJson(res, 400, {
        error: 'Invalid date',
        code: 'INVALID_DATE'
      });
      return;
    }

    const rules = getBookingRules(queries);
    const items = listAvailabilityItems(queries, rules, date);
    sendJson(res, 200, { items });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/my/appointments') {
    const customerOpenId = requireCustomer(req, res);
    if (!customerOpenId) {
      return;
    }

    const items = queries.listCustomerAppointments.all({ customerOpenId }).map(normalizeAppointment);
    sendJson(res, 200, { items });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/staff/appointments') {
    if (!requireStaff(req, res)) {
      return;
    }

    const items = queries.listStaffAppointments.all().map(normalizeAppointment);
    sendJson(res, 200, { items });
    return;
  }

  const staffAppointmentMatch = req.method === 'GET'
    ? url.pathname.match(/^\/api\/v1\/staff\/appointments\/([^/]+)$/)
    : null;
  if (staffAppointmentMatch) {
    if (!requireStaff(req, res)) {
      return;
    }

    const item = queries.getAppointmentById.get({ id: decodeURIComponent(staffAppointmentMatch[1]) });
    if (!item) {
      sendJson(res, 404, {
        error: 'Appointment not found',
        code: 'APPOINTMENT_NOT_FOUND'
      });
      return;
    }

    sendJson(res, 200, { item: normalizeAppointment(item) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/appointments') {
    const customerOpenId = requireCustomer(req, res);
    if (!customerOpenId) {
      return;
    }

    try {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      const unexpectedFields = findUnexpectedFields(body, appointmentAllowedFields);
      if (unexpectedFields.length > 0) {
        sendJson(res, 400, {
          error: 'Unexpected fields',
          code: 'INVALID_REQUEST_FIELDS',
          fields: unexpectedFields
        });
        return;
      }

      const item = buildAppointmentPayload(body, customerOpenId);
      const missing = [
        ['appointmentDate', item.date],
        ['timeSlot', item.timeSlot]
      ].filter(([, value]) => !value).map(([field]) => field);

      if (missing.length > 0) {
        sendJson(res, 400, { error: 'Missing required fields', missing });
        return;
      }

      if (!isValidDate(item.date) || !isValidTimeSlot(item.timeSlot)) {
        sendJson(res, 400, {
          error: 'Invalid slot',
          code: 'INVALID_SLOT'
        });
        return;
      }

      const rules = getBookingRules(queries);
      if (!isDateBookable(item.date, rules) || !isSlotDefinedInRules(item.timeSlot, rules)) {
        sendJson(res, 400, {
          error: 'Invalid slot',
          code: 'INVALID_SLOT'
        });
        return;
      }

      const blockingAppointment = queries.getApprovedBlockingAppointment.get({
        date: item.date,
        timeSlot: item.timeSlot
      });
      if (blockingAppointment) {
        sendJson(res, 409, {
          error: 'Slot occupied',
          code: 'SLOT_OCCUPIED'
        });
        return;
      }

      try {
        queries.createAppointment.run(item);
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          sendJson(res, 409, {
            error: 'Slot occupied',
            code: 'SLOT_OCCUPIED'
          });
          return;
        }
        throw error;
      }

      const created = queries.getAppointmentById.get({ id: item.id });
      sendJson(res, 201, { item: normalizeAppointment(created) });
      return;
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Bad request' });
      return;
    }
  }

  const reviewMatch = req.method === 'POST' || req.method === 'PATCH'
    ? url.pathname.match(/^\/api\/v1\/staff\/appointments\/([^/]+)\/review$/)
    : null;
  if (reviewMatch) {
    const staffOpenId = requireStaff(req, res);
    if (!staffOpenId) {
      return;
    }

    try {
      const id = decodeURIComponent(reviewMatch[1]);
      const body = await readJson(req);
      const nextStatus = normalizeReviewStatus(body.status || body.action);
      const reviewNote = String(body.reviewNote || '').trim();

      if (!nextStatus) {
        sendJson(res, 400, {
          error: 'Invalid review status',
          code: 'INVALID_REVIEW_STATUS'
        });
        return;
      }

      const appointment = queries.getAppointmentById.get({ id });
      if (!appointment) {
        sendJson(res, 404, {
          error: 'Appointment not found',
          code: 'APPOINTMENT_NOT_FOUND'
        });
        return;
      }

      if (appointment.status !== 'pending') {
        sendJson(res, 409, { error: 'Already reviewed' });
        return;
      }

      if (nextStatus === 'approved') {
        const blockingAppointment = queries.getApprovedBlockingAppointment.get({
          date: appointment.date,
          timeSlot: appointment.time_slot
        });
        if (blockingAppointment) {
          sendJson(res, 409, {
            error: 'Slot occupied',
            code: 'SLOT_OCCUPIED'
          });
          return;
        }
      }

      try {
        queries.updateReviewedAppointment.run({
          id,
          status: nextStatus,
          reviewedAt: new Date().toISOString(),
          reviewedBy: staffOpenId,
          reviewNote
        });
      } catch (error) {
        if (nextStatus === 'approved' && isSqliteConstraintError(error)) {
          sendJson(res, 409, {
            error: 'Slot occupied',
            code: 'SLOT_OCCUPIED'
          });
          return;
        }
        throw error;
      }

      const updated = queries.getAppointmentById.get({ id });
      sendJson(res, 200, { item: normalizeAppointment(updated) });
      return;
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Bad request' });
      return;
    }
  }

  sendJson(res, 404, {
    error: 'Not found',
    path: url.pathname
  });
}

function createServer({ dbPath = defaultDbPath } = {}) {
  const context = createAppContext({ dbPath });
  const server = http.createServer((req, res) => {
    handleRequest(req, res, context).catch((error) => {
      sendJson(res, 500, { error: error.message || 'Internal server error' });
    });
  });

  const close = server.close.bind(server);
  server.close = (callback) =>
    close((error) => {
      try {
        context.db.close();
      } catch {
        // ignore close errors during shutdown
      }
      if (callback) {
        callback(error);
      }
    });

  return server;
}

async function withStartedServer(dbPath, callback) {
  const server = createServer({ dbPath });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await callback(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function requestJson(baseUrl, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body = options.body;

  if (body !== undefined && typeof body !== 'string') {
    body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(new URL(pathname, baseUrl), {
    method: options.method || 'GET',
    headers,
    body
  });

  const text = await response.text();
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: text ? JSON.parse(text) : null
  };
}

function createLegacyDatabase(dbPath) {
  ensureDirForFile(dbPath);
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE appointments (
      customer_open_id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      service_id TEXT NOT NULL DEFAULT '',
      service_name TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      time_slot TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reviewed_at TEXT
    )
  `);

  db.prepare(`
    INSERT INTO appointments (
      customer_open_id,
      customer_name,
      phone,
      service_id,
      service_name,
      date,
      time_slot,
      note,
      status,
      created_at,
      updated_at,
      reviewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'legacy-openid-001',
    'Legacy User',
    '13700000000',
    'svc-classic',
    '经典纯色美甲',
    '2026-03-17',
    '10:00-11:00',
    'legacy row',
    'approved',
    '2026-03-10T10:00:00.000Z',
    '2026-03-10T10:00:00.000Z',
    '2026-03-10T11:00:00.000Z'
  );

  db.close();
}

function createLegacyDatabaseMissingCustomerOpenId(dbPath) {
  ensureDirForFile(dbPath);
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE appointments (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      service_id TEXT NOT NULL DEFAULT '',
      service_name TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      time_slot TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    )
  `);

  db.prepare(`
    INSERT INTO appointments (
      id,
      customer_name,
      phone,
      service_id,
      service_name,
      date,
      time_slot,
      note,
      status,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'apt-legacy-phone-001',
    'Phone Legacy User',
    '13600000000',
    'svc-french',
    '法式清透款',
    '2026-03-18',
    '10:00-11:00',
    'legacy row without customer_open_id',
    'pending',
    '2026-03-11T09:00:00.000Z'
  );

  db.close();
}

function createLegacyRulesDatabase(dbPath) {
  ensureDirForFile(dbPath);
  const db = new DatabaseSync(dbPath);
  const today = startOfToday();
  const day0 = formatDateValue(today);
  const day1 = formatDateValue(addDays(today, 1));
  const day2 = formatDateValue(addDays(today, 2));
  const day3 = formatDateValue(addDays(today, 3));

  db.exec(`
    CREATE TABLE availability_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      time_slot TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    )
  `);

  const insertSlot = db.prepare(`
    INSERT INTO availability_slots (date, time_slot, status)
    VALUES (?, ?, ?)
  `);

  for (const date of [day0, day1, day2]) {
    insertSlot.run(date, '09:00-10:00', 'active');
    insertSlot.run(date, '10:30-11:30', 'active');
  }

  insertSlot.run(day3, '09:00-10:00', 'active');
  insertSlot.run(day3, '10:30-11:30', 'inactive');

  db.close();
}

async function runSelfTest() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-server-'));
  const dbPath = path.join(tempDir, 'test.sqlite');
  const legacyDbPath = path.join(tempDir, 'legacy.sqlite');
  const legacyMissingCustomerOpenIdDbPath = path.join(tempDir, 'legacy-missing-customer-openid.sqlite');
  const legacyRulesDbPath = path.join(tempDir, 'legacy-rules.sqlite');

  const today = startOfToday();
  const openDate = formatDateValue(addDays(today, 1));
  const closedDate = formatDateValue(addDays(today, 2));
  const secondOpenDate = formatDateValue(addDays(today, 3));
  const outsideDate = formatDateValue(addDays(today, 5));

  try {
    await withStartedServer(dbPath, async (baseUrl) => {
      const galleryRes = await requestJson(baseUrl, '/api/v1/gallery');
      assert.equal(galleryRes.status, 200);
      assert.ok(Array.isArray(galleryRes.body.items));
      assert.ok(galleryRes.body.items.length >= 3);

      const corsPreflightRes = await requestJson(baseUrl, '/api/v1/staff/booking-rules', {
        method: 'OPTIONS'
      });
      assert.equal(corsPreflightRes.status, 204);
      assert.match(
        String(corsPreflightRes.headers['access-control-allow-headers'] || '').toLowerCase(),
        /x-customer-openid/
      );
      assert.match(
        String(corsPreflightRes.headers['access-control-allow-headers'] || '').toLowerCase(),
        /x-staff-openid/
      );
      assert.match(
        String(corsPreflightRes.headers['access-control-allow-methods'] || '').toLowerCase(),
        /put/
      );

      const unauthorizedBookingRulesRes = await requestJson(baseUrl, '/api/v1/staff/booking-rules');
      assert.equal(unauthorizedBookingRulesRes.status, 401);
      assert.equal(unauthorizedBookingRulesRes.body.code, 'STAFF_UNAUTHORIZED');

      const initialRulesRes = await requestJson(baseUrl, '/api/v1/staff/booking-rules', {
        headers: {
          'X-Staff-OpenId': defaultStaffOpenId
        }
      });
      assert.equal(initialRulesRes.status, 200);
      assert.equal(typeof initialRulesRes.body.advanceOpenDays, 'number');
      assert.ok(Array.isArray(initialRulesRes.body.closedDates));
      assert.ok(Array.isArray(initialRulesRes.body.dailySlots));
      assert.ok(initialRulesRes.body.updatedAt);

      const invalidRulesRes = await requestJson(baseUrl, '/api/v1/staff/booking-rules', {
        method: 'PUT',
        headers: {
          'X-Staff-OpenId': defaultStaffOpenId
        },
        body: {
          advanceOpenDays: 3,
          closedDates: [],
          dailySlots: ['09:00-10:00', '09:30-10:30']
        }
      });
      assert.equal(invalidRulesRes.status, 400);
      assert.equal(invalidRulesRes.body.code, 'INVALID_BOOKING_RULES');

      const updateBookingRulesRes = await requestJson(baseUrl, '/api/v1/staff/booking-rules', {
        method: 'PUT',
        headers: {
          'X-Staff-OpenId': defaultStaffOpenId
        },
        body: {
          advanceOpenDays: 3,
          closedDates: [closedDate],
          dailySlots: ['09:00-10:00', '10:30-11:30']
        }
      });
      assert.equal(updateBookingRulesRes.status, 200);
      assert.equal(updateBookingRulesRes.body.advanceOpenDays, 3);
      assert.deepEqual(updateBookingRulesRes.body.closedDates, [closedDate]);
      assert.deepEqual(updateBookingRulesRes.body.dailySlots, ['09:00-10:00', '10:30-11:30']);
      assert.ok(updateBookingRulesRes.body.updatedAt);

      const persistedRulesRes = await requestJson(baseUrl, '/api/v1/staff/booking-rules', {
        headers: {
          'X-Staff-OpenId': defaultStaffOpenId
        }
      });
      assert.equal(persistedRulesRes.status, 200);
      assert.equal(persistedRulesRes.body.advanceOpenDays, 3);
      assert.deepEqual(persistedRulesRes.body.closedDates, [closedDate]);
      assert.deepEqual(persistedRulesRes.body.dailySlots, ['09:00-10:00', '10:30-11:30']);
      assert.equal(persistedRulesRes.body.updatedAt, updateBookingRulesRes.body.updatedAt);

      const availabilityRes = await requestJson(baseUrl, `/api/v1/availability?date=${openDate}`);
      assert.equal(availabilityRes.status, 200);
      assert.deepEqual(availabilityRes.body.items, [
        { date: openDate, timeSlot: '09:00-10:00', status: 'active' },
        { date: openDate, timeSlot: '10:30-11:30', status: 'active' }
      ]);

      const closedAvailabilityRes = await requestJson(baseUrl, `/api/v1/availability?date=${closedDate}`);
      assert.equal(closedAvailabilityRes.status, 200);
      assert.deepEqual(closedAvailabilityRes.body.items, []);

      const outOfWindowAvailabilityRes = await requestJson(baseUrl, `/api/v1/availability?date=${outsideDate}`);
      assert.equal(outOfWindowAvailabilityRes.status, 200);
      assert.deepEqual(outOfWindowAvailabilityRes.body.items, []);

      const allAvailabilityRes = await requestJson(baseUrl, '/api/v1/availability');
      assert.equal(allAvailabilityRes.status, 200);
      assert.deepEqual(allAvailabilityRes.body.items, [
        { date: formatDateValue(today), timeSlot: '09:00-10:00', status: 'active' },
        { date: formatDateValue(today), timeSlot: '10:30-11:30', status: 'active' },
        { date: openDate, timeSlot: '09:00-10:00', status: 'active' },
        { date: openDate, timeSlot: '10:30-11:30', status: 'active' },
        { date: secondOpenDate, timeSlot: '09:00-10:00', status: 'active' },
        { date: secondOpenDate, timeSlot: '10:30-11:30', status: 'active' }
      ]);

      const unauthorizedCreateRes = await requestJson(baseUrl, '/api/v1/appointments', {
        method: 'POST',
        body: {}
      });
      assert.equal(unauthorizedCreateRes.status, 401);
      assert.deepEqual(unauthorizedCreateRes.body, {
        error: 'Customer unauthorized',
        code: 'CUSTOMER_UNAUTHORIZED'
      });

      const unauthorizedMyRes = await requestJson(baseUrl, '/api/v1/my/appointments');
      assert.equal(unauthorizedMyRes.status, 401);
      assert.deepEqual(unauthorizedMyRes.body, {
        error: 'Customer unauthorized',
        code: 'CUSTOMER_UNAUTHORIZED'
      });

      const legacyPayloadRes = await requestJson(baseUrl, '/api/v1/appointments', {
        method: 'POST',
        headers: {
          'X-Customer-OpenId': 'openid-customer-legacy'
        },
        body: {
          appointmentDate: openDate,
          timeSlot: '09:00-10:00',
          serviceId: 'svc-classic',
          serviceName: '经典纯色美甲'
        }
      });
      assert.equal(legacyPayloadRes.status, 400);
      assert.equal(legacyPayloadRes.body.code, 'INVALID_REQUEST_FIELDS');
      assert.deepEqual(legacyPayloadRes.body.fields, ['serviceId', 'serviceName']);

      const createRes = await requestJson(baseUrl, '/api/v1/appointments', {
        method: 'POST',
        headers: {
          'X-Customer-OpenId': 'openid-customer-001'
        },
        body: {
          customerName: 'Lan',
          phone: '13800000000',
          appointmentDate: openDate,
          timeSlot: '09:00-10:00',
          note: '希望保持自然风'
        }
      });
      assert.equal(createRes.status, 201);
      assert.equal(createRes.body.item.customerOpenId, 'openid-customer-001');
      assert.equal(createRes.body.item.customerName, 'Lan');
      assert.equal(createRes.body.item.phone, '13800000000');
      assert.equal(createRes.body.item.status, 'pending');
      assert.equal(Object.hasOwn(createRes.body.item, 'serviceId'), false);
      assert.equal(Object.hasOwn(createRes.body.item, 'artistId'), false);

      const availabilityAfterFirstPendingRes = await requestJson(baseUrl, `/api/v1/availability?date=${openDate}`);
      assert.equal(availabilityAfterFirstPendingRes.status, 200);
      assert.deepEqual(availabilityAfterFirstPendingRes.body.items, [
        { date: openDate, timeSlot: '09:00-10:00', status: 'active' },
        { date: openDate, timeSlot: '10:30-11:30', status: 'active' }
      ]);

      const createSecondPendingRes = await requestJson(baseUrl, '/api/v1/appointments', {
        method: 'POST',
        headers: {
          'X-Customer-OpenId': 'openid-customer-002'
        },
        body: {
          customerName: 'Momo',
          phone: '13900000000',
          appointmentDate: openDate,
          timeSlot: '09:00-10:00',
          note: '可接受等待确认'
        }
      });
      assert.equal(createSecondPendingRes.status, 201);
      assert.equal(createSecondPendingRes.body.item.customerOpenId, 'openid-customer-002');
      assert.equal(createSecondPendingRes.body.item.status, 'pending');

      const myPendingRes = await requestJson(baseUrl, '/api/v1/my/appointments', {
        headers: {
          'X-Customer-OpenId': 'openid-customer-001'
        }
      });
      assert.equal(myPendingRes.status, 200);
      assert.equal(myPendingRes.body.items.length, 1);
      assert.equal(myPendingRes.body.items[0].customerOpenId, 'openid-customer-001');
      assert.equal(myPendingRes.body.items[0].status, 'pending');

      const phoneIgnoredRes = await requestJson(baseUrl, '/api/v1/my/appointments?phone=13800000000', {
        headers: {
          'X-Customer-OpenId': 'openid-customer-unused'
        }
      });
      assert.equal(phoneIgnoredRes.status, 200);
      assert.equal(phoneIgnoredRes.body.items.length, 0);

      const unauthorizedStaffRes = await requestJson(baseUrl, '/api/v1/staff/appointments');
      assert.equal(unauthorizedStaffRes.status, 401);
      assert.equal(unauthorizedStaffRes.body.code, 'STAFF_UNAUTHORIZED');

      const staffListRes = await requestJson(baseUrl, '/api/v1/staff/appointments', {
        headers: {
          'X-Staff-OpenId': defaultStaffOpenId
        }
      });
      assert.equal(staffListRes.status, 200);
      assert.equal(staffListRes.body.items.length, 2);
      assert.ok(staffListRes.body.items.some((item) => item.customerOpenId === 'openid-customer-001'));
      assert.ok(staffListRes.body.items.some((item) => item.customerOpenId === 'openid-customer-002'));
      assert.equal(
        Object.hasOwn(
          staffListRes.body.items.find((item) => item.customerOpenId === 'openid-customer-001'),
          'serviceId'
        ),
        false
      );

      const appointmentId = createRes.body.item.id;
      const secondAppointmentId = createSecondPendingRes.body.item.id;
      const staffDetailRes = await requestJson(baseUrl, `/api/v1/staff/appointments/${appointmentId}`, {
        headers: {
          'X-Staff-OpenId': defaultStaffOpenId
        }
      });
      assert.equal(staffDetailRes.status, 200);
      assert.equal(staffDetailRes.body.item.id, appointmentId);

      const reviewRes = await requestJson(baseUrl, `/api/v1/staff/appointments/${appointmentId}/review`, {
        method: 'POST',
        headers: {
          'X-Staff-OpenId': defaultStaffOpenId
        },
        body: {
          status: 'approved',
          reviewNote: '已确认档期'
        }
      });
      assert.equal(reviewRes.status, 200);
      assert.equal(reviewRes.body.item.status, 'approved');
      assert.equal(reviewRes.body.item.reviewedBy, defaultStaffOpenId);
      assert.equal(reviewRes.body.item.customerOpenId, 'openid-customer-001');

      const availabilityAfterApproveRes = await requestJson(baseUrl, `/api/v1/availability?date=${openDate}`);
      assert.equal(availabilityAfterApproveRes.status, 200);
      assert.deepEqual(availabilityAfterApproveRes.body.items, [
        { date: openDate, timeSlot: '10:30-11:30', status: 'active' }
      ]);

      const createAfterApprovedRes = await requestJson(baseUrl, '/api/v1/appointments', {
        method: 'POST',
        headers: {
          'X-Customer-OpenId': 'openid-customer-003'
        },
        body: {
          appointmentDate: openDate,
          timeSlot: '09:00-10:00'
        }
      });
      assert.equal(createAfterApprovedRes.status, 409);
      assert.equal(createAfterApprovedRes.body.code, 'SLOT_OCCUPIED');

      const conflictingReviewRes = await requestJson(baseUrl, `/api/v1/staff/appointments/${secondAppointmentId}/review`, {
        method: 'PATCH',
        headers: {
          'X-Staff-OpenId': defaultStaffOpenId
        },
        body: {
          status: 'approved',
          reviewNote: '尝试补位'
        }
      });
      assert.equal(conflictingReviewRes.status, 409);
      assert.equal(conflictingReviewRes.body.code, 'SLOT_OCCUPIED');

      const secondCustomerStillPendingRes = await requestJson(baseUrl, '/api/v1/my/appointments', {
        headers: {
          'X-Customer-OpenId': 'openid-customer-002'
        }
      });
      assert.equal(secondCustomerStillPendingRes.status, 200);
      assert.equal(secondCustomerStillPendingRes.body.items.length, 1);
      assert.equal(secondCustomerStillPendingRes.body.items[0].status, 'pending');

      const myApprovedRes = await requestJson(baseUrl, '/api/v1/my/appointments', {
        headers: {
          'X-Customer-OpenId': 'openid-customer-001'
        }
      });
      assert.equal(myApprovedRes.status, 200);
      assert.equal(myApprovedRes.body.items.length, 1);
      assert.equal(myApprovedRes.body.items[0].customerOpenId, 'openid-customer-001');
      assert.equal(myApprovedRes.body.items[0].status, 'approved');
      assert.equal(myApprovedRes.body.items[0].reviewedBy, defaultStaffOpenId);

      const createClosedDateRes = await requestJson(baseUrl, '/api/v1/appointments', {
        method: 'POST',
        headers: {
          'X-Customer-OpenId': 'openid-customer-003'
        },
        body: {
          appointmentDate: closedDate,
          timeSlot: '09:00-10:00'
        }
      });
      assert.equal(createClosedDateRes.status, 400);
      assert.equal(createClosedDateRes.body.code, 'INVALID_SLOT');

      const createOutsideDateRes = await requestJson(baseUrl, '/api/v1/appointments', {
        method: 'POST',
        headers: {
          'X-Customer-OpenId': 'openid-customer-004'
        },
        body: {
          appointmentDate: outsideDate,
          timeSlot: '09:00-10:00'
        }
      });
      assert.equal(createOutsideDateRes.status, 400);
      assert.equal(createOutsideDateRes.body.code, 'INVALID_SLOT');

      const legacyServicesRes = await requestJson(baseUrl, '/api/v1/services');
      assert.equal(legacyServicesRes.status, 404);

      const legacyHotStylesRes = await requestJson(baseUrl, '/api/v1/hot-styles');
      assert.equal(legacyHotStylesRes.status, 404);

      const legacyArtistsRes = await requestJson(baseUrl, '/api/v1/artists');
      assert.equal(legacyArtistsRes.status, 404);

      const legacyAppointmentsRes = await requestJson(baseUrl, '/api/v1/appointments?phone=13800000000');
      assert.equal(legacyAppointmentsRes.status, 404);
    });

    await withStartedServer(dbPath, async (baseUrl) => {
      const persistedRulesRes = await requestJson(baseUrl, '/api/v1/staff/booking-rules', {
        headers: {
          'X-Staff-OpenId': defaultStaffOpenId
        }
      });
      assert.equal(persistedRulesRes.status, 200);
      assert.equal(persistedRulesRes.body.advanceOpenDays, 3);
      assert.deepEqual(persistedRulesRes.body.closedDates, [closedDate]);
      assert.deepEqual(persistedRulesRes.body.dailySlots, ['09:00-10:00', '10:30-11:30']);

      const persistedMyRes = await requestJson(baseUrl, '/api/v1/my/appointments', {
        headers: {
          'X-Customer-OpenId': 'openid-customer-001'
        }
      });
      assert.equal(persistedMyRes.status, 200);
      assert.equal(persistedMyRes.body.items.length, 1);
      assert.equal(persistedMyRes.body.items[0].status, 'approved');
      assert.equal(persistedMyRes.body.items[0].reviewedBy, defaultStaffOpenId);

      const persistedSecondPendingRes = await requestJson(baseUrl, '/api/v1/my/appointments', {
        headers: {
          'X-Customer-OpenId': 'openid-customer-002'
        }
      });
      assert.equal(persistedSecondPendingRes.status, 200);
      assert.equal(persistedSecondPendingRes.body.items.length, 1);
      assert.equal(persistedSecondPendingRes.body.items[0].status, 'pending');

      const persistedAvailabilityRes = await requestJson(baseUrl, `/api/v1/availability?date=${openDate}`);
      assert.equal(persistedAvailabilityRes.status, 200);
      assert.deepEqual(persistedAvailabilityRes.body.items, [
        { date: openDate, timeSlot: '10:30-11:30', status: 'active' }
      ]);
    });

    createLegacyDatabase(legacyDbPath);
    await withStartedServer(legacyDbPath, async (baseUrl) => {
      const staffListRes = await requestJson(baseUrl, '/api/v1/staff/appointments', {
        headers: {
          'X-Staff-OpenId': defaultStaffOpenId
        }
      });
      assert.equal(staffListRes.status, 200);
      assert.equal(staffListRes.body.items.length, 1);
      assert.equal(staffListRes.body.items[0].customerOpenId, 'legacy-openid-001');
      assert.ok(staffListRes.body.items[0].id);

      const myLegacyRes = await requestJson(baseUrl, '/api/v1/my/appointments', {
        headers: {
          'X-Customer-OpenId': 'legacy-openid-001'
        }
      });
      assert.equal(myLegacyRes.status, 200);
      assert.equal(myLegacyRes.body.items.length, 1);
      assert.equal(myLegacyRes.body.items[0].status, 'approved');
    });

    createLegacyDatabaseMissingCustomerOpenId(legacyMissingCustomerOpenIdDbPath);
    await withStartedServer(legacyMissingCustomerOpenIdDbPath, async (baseUrl) => {
      const migratedStaffListRes = await requestJson(baseUrl, '/api/v1/staff/appointments', {
        headers: {
          'X-Staff-OpenId': defaultStaffOpenId
        }
      });
      assert.equal(migratedStaffListRes.status, 200);
      assert.equal(migratedStaffListRes.body.items.length, 1);
      assert.equal(migratedStaffListRes.body.items[0].id, 'apt-legacy-phone-001');
      assert.equal(migratedStaffListRes.body.items[0].customerOpenId, '');
      assert.equal(migratedStaffListRes.body.items[0].phone, '13600000000');

      const migratedCreateRes = await requestJson(baseUrl, '/api/v1/appointments', {
        method: 'POST',
        headers: {
          'X-Customer-OpenId': 'openid-migrated-customer-001'
        },
        body: {
          customerName: 'Migrated New User',
          phone: '13500000000',
          appointmentDate: formatDateValue(today),
          timeSlot: defaultDailySlots[2]
        }
      });
      assert.equal(migratedCreateRes.status, 201);
      assert.equal(migratedCreateRes.body.item.customerOpenId, 'openid-migrated-customer-001');

      const migratedMyRes = await requestJson(baseUrl, '/api/v1/my/appointments?phone=13600000000', {
        headers: {
          'X-Customer-OpenId': 'openid-migrated-customer-001'
        }
      });
      assert.equal(migratedMyRes.status, 200);
      assert.equal(migratedMyRes.body.items.length, 1);
      assert.equal(migratedMyRes.body.items[0].customerOpenId, 'openid-migrated-customer-001');
      assert.equal(migratedMyRes.body.items[0].phone, '13500000000');
    });

    createLegacyRulesDatabase(legacyRulesDbPath);
    await withStartedServer(legacyRulesDbPath, async (baseUrl) => {
      const migratedRulesRes = await requestJson(baseUrl, '/api/v1/staff/booking-rules', {
        headers: {
          'X-Staff-OpenId': defaultStaffOpenId
        }
      });
      assert.equal(migratedRulesRes.status, 200);
      assert.equal(migratedRulesRes.body.advanceOpenDays, 3);
      assert.deepEqual(migratedRulesRes.body.closedDates, [formatDateValue(addDays(today, 3))]);
      assert.deepEqual(migratedRulesRes.body.dailySlots, ['09:00-10:00', '10:30-11:30']);
      assert.ok(migratedRulesRes.body.updatedAt);

      const migratedAvailabilityRes = await requestJson(baseUrl, `/api/v1/availability?date=${formatDateValue(addDays(today, 1))}`);
      assert.equal(migratedAvailabilityRes.status, 200);
      assert.deepEqual(migratedAvailabilityRes.body.items, [
        { date: formatDateValue(addDays(today, 1)), timeSlot: '09:00-10:00', status: 'active' },
        { date: formatDateValue(addDays(today, 1)), timeSlot: '10:30-11:30', status: 'active' }
      ]);

      const migratedClosedDayAvailabilityRes = await requestJson(baseUrl, `/api/v1/availability?date=${formatDateValue(addDays(today, 3))}`);
      assert.equal(migratedClosedDayAvailabilityRes.status, 200);
      assert.deepEqual(migratedClosedDayAvailabilityRes.body.items, []);
    });

    console.log('self-test ok');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function startServer({ host = '0.0.0.0', listenPort = port, dbPath = defaultDbPath } = {}) {
  const server = createServer({ dbPath });

  const shutdown = () => {
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(listenPort, host, () => {
    console.log(`miniapp-server listening on http://127.0.0.1:${listenPort}`);
  });

  return server;
}

const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

export { createServer, runSelfTest, startServer };

if (isMainModule) {
  if (process.argv.includes('--self-test')) {
    runSelfTest().catch((error) => {
      console.error(error.stack || error.message);
      process.exit(1);
    });
  } else {
    startServer();
  }
}
