/**
 * BALANCE НББ — Нягтлан бодох бүртгэлийн программ
 * Google Sheet + Apps Script вэб апп. Нэг программд олон компани, давхар бичилт.
 *
 * Зарчмууд:
 *  - Мөнгөн дүнг мөнгөөр (₮ × 100) БҮХЭЛ тоогоор хадгална. Float ашиглахгүй.
 *  - Гүйлгээ бүр Дебет = Кредит байх ёстой; тэнцэхгүй бол батлахгүй.
 *  - Батлагдсан гүйлгээг устгах/засахгүй, зөвхөн буцаалтын гүйлгээгээр засна.
 *  - "Lines" хүснэгт зөвхөн нэмэгддэг (append-only). Гүйлгээний мөрүүдийг эхэлж бичээд,
 *    дараа нь толгойг POSTED болгоно. Тайлан зөвхөн толгойн post_key-тэй таарсан мөрийг
 *    тооцдог тул дундуур тасарсан бичилт тайланд орохгүй (transaction-ий орлуулга).
 *  - Бүх өөрчлөлт Audit хүснэгтэд бүртгэгдэнэ.
 */

var APP_NAME = 'BALANCE НББ';
var APP_VERSION = '1.0.0';

var SCHEMA = {
  Companies: ['id', 'code', 'name', 'register_no', 'vat_payer', 'address', 'active', 'created_at'],
  Users: ['username', 'name', 'role', 'companies', 'pass_hash', 'salt', 'active', 'must_change', 'created_at'],
  Accounts: ['company_id', 'code', 'name', 'type', 'parent', 'is_group', 'subtype', 'active'],
  Partners: ['company_id', 'id', 'code', 'name', 'register_no', 'kind', 'phone', 'email', 'active'],
  Segments: ['company_id', 'code', 'name', 'active'],
  Periods: ['company_id', 'period', 'status', 'closed_by', 'closed_at'],
  Entries: ['id', 'company_id', 'number', 'date', 'period', 'description', 'ref', 'status', 'source', 'cf',
    'reversal_of', 'reversed_by', 'total', 'post_key', 'draft_json', 'created_by', 'created_at', 'posted_by', 'posted_at'],
  Lines: ['entry_id', 'company_id', 'line_no', 'date', 'account', 'partner_id', 'segment', 'description', 'debit', 'credit', 'post_key'],
  Settings: ['company_id', 'key', 'value'],
  Audit: ['ts', 'username', 'action', 'company_id', 'object', 'object_id', 'details']
};

var ROLES = { ADMIN: 'Админ', DIRECTOR: 'Захирал', MANAGER: 'Менежер', ACCOUNTANT: 'Нягтлан', VIEWER: 'Зөвхөн харах' };
var PERMS = {
  view: ['ADMIN', 'DIRECTOR', 'MANAGER', 'ACCOUNTANT', 'VIEWER'],
  draft: ['ADMIN', 'MANAGER', 'ACCOUNTANT'],
  post: ['ADMIN', 'MANAGER', 'ACCOUNTANT'],
  reverse: ['ADMIN', 'DIRECTOR', 'MANAGER'],
  masterdata: ['ADMIN', 'MANAGER', 'ACCOUNTANT'],
  period: ['ADMIN', 'DIRECTOR'],
  settings: ['ADMIN', 'DIRECTOR'],
  audit: ['ADMIN', 'DIRECTOR'],
  admin: ['ADMIN']
};

var TYPES = { ASSET: 'Хөрөнгө', LIABILITY: 'Өр төлбөр', EQUITY: 'Эздийн өмч', REVENUE: 'Орлого', EXPENSE: 'Зардал' };
var SUBTYPES = {
  '': '—', CASH: 'Мөнгө (касс, харилцах)', RECEIVABLE: 'Авлага (харилцагчтай)', PAYABLE: 'Өглөг (харилцагчтай)',
  VAT_IN: 'НӨАТ-ын авлага', VAT_OUT: 'НӨАТ-ын өглөг', INVENTORY: 'Бараа материал', FIXED_ASSET: 'Үндсэн/биет бус хөрөнгө',
  ACC_DEP: 'Хуримтлагдсан элэгдэл', LOAN: 'Авсан зээл', RETAINED: 'Хуримтлагдсан ашиг', SALES: 'Борлуулалтын орлого',
  COGS: 'Борлуулсан бүтээгдэхүүний өртөг', INCOME_TAX: 'ААНОАТ-ын зардал'
};
var CF = { OPERATING: 'Үндсэн үйл ажиллагааны', INVESTING: 'Хөрөнгө оруулалтын үйл ажиллагааны', FINANCING: 'Санхүүгийн үйл ажиллагааны' };
var PARTNER_KINDS = { CUSTOMER: 'Худалдан авагч', SUPPLIER: 'Нийлүүлэгч', BOTH: 'Худалдан авагч/нийлүүлэгч', EMPLOYEE: 'Ажилтан', OTHER: 'Бусад' };
var CLOSING_SOURCES = { CLOSING: 1, CLOSING_REV: 1 };
var MAX_MINOR = 1e15; // 10 их наяд ₮ — бүхэл тооны нарийвчлалын хязгаараас хол

var DEFAULT_SETTINGS = {
  vat_rate: '10',
  cit_brackets: '6000000000:10;*:25',
  cit_small_threshold: '0',
  cit_small_rate: '1',
  retained_account: '3400'
};

// [код, нэр, төрөл, эцэг, бүлэг эсэх, дэд төрөл] — НББОУС-д нийцсэн жишиг, компани бүр өөрчилж болно.
var COA_TEMPLATE = [
  ['1000', 'ХӨРӨНГӨ', 'ASSET', '', 1, ''],
  ['1100', 'Мөнгө ба түүнтэй адилтгах хөрөнгө', 'ASSET', '1000', 1, ''],
  ['1110', 'Касс', 'ASSET', '1100', 0, 'CASH'],
  ['1120', 'Харилцах данс (төгрөг)', 'ASSET', '1100', 0, 'CASH'],
  ['1130', 'Харилцах данс (валют)', 'ASSET', '1100', 0, 'CASH'],
  ['1200', 'Авлага', 'ASSET', '1000', 1, ''],
  ['1210', 'Дансны авлага', 'ASSET', '1200', 0, 'RECEIVABLE'],
  ['1220', 'Ажиллагсдаас авах авлага', 'ASSET', '1200', 0, 'RECEIVABLE'],
  ['1230', 'Олгосон зээлийн авлага', 'ASSET', '1200', 0, 'RECEIVABLE'],
  ['1240', 'НӨАТ-ын авлага', 'ASSET', '1200', 0, 'VAT_IN'],
  ['1250', 'Татвар, НДШ-ийн бусад авлага', 'ASSET', '1200', 0, ''],
  ['1290', 'Бусад авлага', 'ASSET', '1200', 0, 'RECEIVABLE'],
  ['1300', 'Бараа материал', 'ASSET', '1000', 1, ''],
  ['1310', 'Бараа', 'ASSET', '1300', 0, 'INVENTORY'],
  ['1320', 'Түүхий эд, материал', 'ASSET', '1300', 0, 'INVENTORY'],
  ['1400', 'Урьдчилж төлсөн зардал, төлбөр', 'ASSET', '1000', 1, ''],
  ['1410', 'Урьдчилж төлсөн зардал', 'ASSET', '1400', 0, ''],
  ['1420', 'Нийлүүлэгчид өгсөн урьдчилгаа', 'ASSET', '1400', 0, 'RECEIVABLE'],
  ['1500', 'Эргэлтийн бус хөрөнгө', 'ASSET', '1000', 1, ''],
  ['1510', 'Үндсэн хөрөнгө', 'ASSET', '1500', 0, 'FIXED_ASSET'],
  ['1520', 'Хуримтлагдсан элэгдэл', 'ASSET', '1500', 0, 'ACC_DEP'],
  ['1530', 'Биет бус хөрөнгө', 'ASSET', '1500', 0, 'FIXED_ASSET'],
  ['1540', 'Хуримтлагдсан хорогдуулалт', 'ASSET', '1500', 0, 'ACC_DEP'],
  ['1550', 'Урт хугацаат хөрөнгө оруулалт', 'ASSET', '1500', 0, 'FIXED_ASSET'],
  ['2000', 'ӨР ТӨЛБӨР', 'LIABILITY', '', 1, ''],
  ['2100', 'Богино хугацаат өр төлбөр', 'LIABILITY', '2000', 1, ''],
  ['2110', 'Дансны өглөг', 'LIABILITY', '2100', 0, 'PAYABLE'],
  ['2120', 'Цалингийн өглөг', 'LIABILITY', '2100', 0, 'PAYABLE'],
  ['2130', 'НӨАТ-ын өглөг', 'LIABILITY', '2100', 0, 'VAT_OUT'],
  ['2140', 'ХХОАТ-ын өглөг', 'LIABILITY', '2100', 0, ''],
  ['2150', 'НДШ-ийн өглөг', 'LIABILITY', '2100', 0, ''],
  ['2160', 'ААНОАТ-ын өглөг', 'LIABILITY', '2100', 0, ''],
  ['2170', 'Урьдчилж орсон орлого', 'LIABILITY', '2100', 0, 'PAYABLE'],
  ['2180', 'Богино хугацаат зээл', 'LIABILITY', '2100', 0, 'LOAN'],
  ['2190', 'Бусад богино хугацаат өглөг', 'LIABILITY', '2100', 0, 'PAYABLE'],
  ['2200', 'Урт хугацаат өр төлбөр', 'LIABILITY', '2000', 1, ''],
  ['2210', 'Урт хугацаат зээл', 'LIABILITY', '2200', 0, 'LOAN'],
  ['3000', 'ЭЗДИЙН ӨМЧ', 'EQUITY', '', 1, ''],
  ['3100', 'Өмч (хувь нийлүүлсэн хөрөнгө)', 'EQUITY', '3000', 0, ''],
  ['3200', 'Нэмж төлөгдсөн капитал', 'EQUITY', '3000', 0, ''],
  ['3300', 'Хөрөнгийн дахин үнэлгээний нэмэгдэл', 'EQUITY', '3000', 0, ''],
  ['3400', 'Хуримтлагдсан ашиг', 'EQUITY', '3000', 0, 'RETAINED'],
  ['4000', 'ОРЛОГО', 'REVENUE', '', 1, ''],
  ['4100', 'Борлуулалтын орлого', 'REVENUE', '4000', 0, 'SALES'],
  ['4110', 'Борлуулалтын буцаалт, хөнгөлөлт', 'REVENUE', '4000', 0, 'SALES'],
  ['4200', 'Үйлчилгээний орлого', 'REVENUE', '4000', 0, 'SALES'],
  ['4300', 'Хүүгийн орлого', 'REVENUE', '4000', 0, ''],
  ['4400', 'Ханшийн зөрүүний олз', 'REVENUE', '4000', 0, ''],
  ['4900', 'Бусад орлого', 'REVENUE', '4000', 0, ''],
  ['5000', 'ЗАРДАЛ', 'EXPENSE', '', 1, ''],
  ['5100', 'Борлуулсан бүтээгдэхүүний өртөг', 'EXPENSE', '5000', 0, 'COGS'],
  ['5200', 'Борлуулалт, маркетингийн зардал', 'EXPENSE', '5000', 0, ''],
  ['5300', 'Цалингийн зардал', 'EXPENSE', '5000', 0, ''],
  ['5310', 'НДШ-ийн зардал (ажил олгогч)', 'EXPENSE', '5000', 0, ''],
  ['5400', 'Түрээсийн зардал', 'EXPENSE', '5000', 0, ''],
  ['5500', 'Ашиглалтын зардал (цахилгаан, интернет)', 'EXPENSE', '5000', 0, ''],
  ['5600', 'Элэгдэл, хорогдуулалтын зардал', 'EXPENSE', '5000', 0, ''],
  ['5700', 'Банкны шимтгэл', 'EXPENSE', '5000', 0, ''],
  ['5800', 'Хүүгийн зардал', 'EXPENSE', '5000', 0, ''],
  ['5850', 'Ханшийн зөрүүний гарз', 'EXPENSE', '5000', 0, ''],
  ['5900', 'Бусад зардал', 'EXPENSE', '5000', 0, ''],
  ['5950', 'Орлогын албан татварын зардал', 'EXPENSE', '5000', 0, 'INCOME_TAX']
];

var MEM = {}; // нэг дуудлагын доторх кэш

/* ============================================================
 * Вэб апп, цэс, анхны тохиргоо
 * ============================================================ */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu(APP_NAME)
    .addItem('1. Анхны тохиргоо хийх', 'setupWizard')
    .addItem('Админы нууц үг шинэчлэх', 'resetAdminWizard')
    .addToUi();
}

function setupWizard() {
  var ui = SpreadsheetApp.getUi();
  var c = ui.prompt(APP_NAME, 'Эхний компанийн нэр:', ui.ButtonSet.OK_CANCEL);
  if (c.getSelectedButton() !== ui.Button.OK) return;
  var p = ui.prompt(APP_NAME, '"admin" хэрэглэгчийн нууц үг (8+ тэмдэгт):', ui.ButtonSet.OK_CANCEL);
  if (p.getSelectedButton() !== ui.Button.OK) return;
  try {
    ui.alert(APP_NAME, setup_(c.getResponseText().trim() || 'Миний компани', p.getResponseText()), ui.ButtonSet.OK);
  } catch (e) {
    ui.alert(APP_NAME, 'Алдаа: ' + e.message, ui.ButtonSet.OK);
  }
}

function resetAdminWizard() {
  var ui = SpreadsheetApp.getUi();
  var p = ui.prompt(APP_NAME, '"admin" хэрэглэгчийн шинэ нууц үг (8+ тэмдэгт):', ui.ButtonSet.OK_CANCEL);
  if (p.getSelectedButton() !== ui.Button.OK) return;
  try {
    ensureSheets_();
    var u = readAll_('Users').filter(function (x) { return x.username === 'admin'; })[0];
    if (!u) createUser_({ username: 'admin', name: 'Админ', role: 'ADMIN', companies: '*' }, p.getResponseText(), false);
    else { setPassword_(u, p.getResponseText(), false); u.active = '1'; u.role = 'ADMIN'; update_('Users', u); }
    audit_({ username: 'spreadsheet-owner' }, 'ADMIN_RESET', '', 'user', 'admin', '');
    ui.alert(APP_NAME, 'admin хэрэглэгчийн нууц үг шинэчлэгдлээ.', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert(APP_NAME, 'Алдаа: ' + e.message, ui.ButtonSet.OK);
  }
}

function setup_(companyName, adminPassword) {
  if (!adminPassword || String(adminPassword).length < 8) throw new Error('Нууц үг хамгийн багадаа 8 тэмдэгт байна.');
  PropertiesService.getScriptProperties().setProperty('SS_ID', SpreadsheetApp.getActive().getId());
  MEM = {};
  ensureSheets_();
  var msgs = [];
  if (!readAll_('Companies').length) {
    createCompany_({ code: 'C01', name: companyName }, { username: 'setup' });
    msgs.push('Компани үүслээ: ' + companyName + ' (жишиг дансны төлөвлөгөөтэй)');
  }
  if (!readAll_('Users').some(function (u) { return u.username === 'admin'; })) {
    createUser_({ username: 'admin', name: 'Админ', role: 'ADMIN', companies: '*' }, adminPassword, false);
    msgs.push('Хэрэглэгч үүслээ: admin');
  } else {
    msgs.push('admin хэрэглэгч аль хэдийн байгаа тул нууц үгийг өөрчлөөгүй ("Админы нууц үг шинэчлэх" цэсийг ашиглана уу).');
  }
  msgs.push('Дараагийн алхам: Өргөтгөл → Apps Script → Байршуулах (Deploy) → Шинэ байршуулалт → Вэб апп.');
  return msgs.join('\n');
}

/* ============================================================
 * Өгөгдлийн давхарга (Google Sheet)
 * ============================================================ */

function ss_() {
  if (MEM._ss) return MEM._ss;
  var id = PropertiesService.getScriptProperties().getProperty('SS_ID');
  MEM._ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
  return MEM._ss;
}

function sh_(name) {
  var s = ss_().getSheetByName(name);
  if (!s) throw new Error('"' + name + '" хүснэгт олдсонгүй. Google Sheet дээр "' + APP_NAME + ' → Анхны тохиргоо хийх" цэсийг ажиллуулна уу.');
  return s;
}

function ensureSheets_() {
  var ss = ss_();
  Object.keys(SCHEMA).forEach(function (name) {
    var cols = SCHEMA[name];
    var s = ss.getSheetByName(name) || ss.insertSheet(name);
    var lastCol = Math.max(s.getLastColumn(), 1);
    var head = s.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    cols.forEach(function (c, i) {
      if (!head[i]) s.getRange(1, i + 1).setValue(c);
      else if (head[i] !== c) throw new Error(name + ' хүснэгтийн ' + (i + 1) + '-р багана "' + head[i] + '" байна, "' + c + '" байх ёстой.');
    });
    s.setFrozenRows(1);
    s.getRange(1, 1, s.getMaxRows(), cols.length).setNumberFormat('@');
    s.getRange(1, 1, 1, cols.length).setFontWeight('bold').setBackground('#0F1E3D').setFontColor('#FFFFFF');
  });
}

function norm_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : String(v);
}

function cell_(v) {
  if (v === undefined || v === null) return '';
  var s = String(v);
  return /^[=+@]/.test(s) ? "'" + s : s; // томьёо болон хувирахаас сэргийлнэ
}

function readAll_(name) {
  var k = 't_' + name;
  if (MEM[k]) return MEM[k];
  var s = sh_(name), cols = SCHEMA[name], last = s.getLastRow(), out = [];
  if (last >= 2) {
    var vals = s.getRange(2, 1, last - 1, cols.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      var r = vals[i], empty = true;
      for (var j = 0; j < r.length; j++) if (r[j] !== '' && r[j] !== null) { empty = false; break; }
      if (empty) continue;
      var o = { _row: i + 2 };
      for (j = 0; j < cols.length; j++) o[cols[j]] = norm_(r[j]);
      out.push(o);
    }
  }
  MEM[k] = out;
  return out;
}

function invalidate_(name) {
  delete MEM['t_' + name];
  if (name === 'Lines' || name === 'Entries') {
    Object.keys(MEM).forEach(function (k) { if (k.indexOf('led_') === 0) delete MEM[k]; });
  }
}

function append_(name, objs) {
  if (!objs || !objs.length) return;
  var s = sh_(name), cols = SCHEMA[name];
  var rows = objs.map(function (o) { return cols.map(function (c) { return cell_(o[c]); }); });
  var start = s.getLastRow() + 1;
  var need = start + rows.length - 1 - s.getMaxRows();
  if (need > 0) {
    var at = s.getMaxRows();
    s.insertRowsAfter(at, need + 200);
    s.getRange(at + 1, 1, need + 200, cols.length).setNumberFormat('@');
  }
  s.getRange(start, 1, rows.length, cols.length).setValues(rows);
  invalidate_(name);
}

function update_(name, obj) {
  if (!obj._row) throw new Error('update_: мөрийн дугаар алга');
  var cols = SCHEMA[name];
  sh_(name).getRange(obj._row, 1, 1, cols.length).setValues([cols.map(function (c) { return cell_(obj[c]); })]);
  invalidate_(name);
}

/* ============================================================
 * Туслах функцууд
 * ============================================================ */

function tz_() { return Session.getScriptTimeZone() || 'Asia/Ulaanbaatar'; }
function now_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss'); }
function today_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }
function newId_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 16); }
function clean_(v, max) { return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max || 200); }

function validDate_(s, label) {
  s = String(s || '').trim();
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error((label || 'Огноо') + ' буруу байна (ЖЖЖЖ-СС-ӨӨ).');
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new Error((label || 'Огноо') + ' буруу байна: ' + s);
  if (+m[1] < 1990 || +m[1] > 2100) throw new Error((label || 'Огноо') + ' хүрээнээс гадуур: ' + s);
  return s;
}

function daysBetween_(a, b) {
  var pa = a.split('-'), pb = b.split('-');
  return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
}

function monthEnd_(period) {
  var y = +period.slice(0, 4), m = +period.slice(5, 7);
  var d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return period + '-' + (d < 10 ? '0' : '') + d;
}

/** "1,234.56" → 123456 (мөнгө). Хоёроос олон орон бутархайг 0.5-аас дээш тоймлоно. */
function toMinor_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  if (typeof v === 'number') {
    if (!isFinite(v)) throw new Error('Буруу дүн: ' + v);
    v = v.toFixed(6);
  }
  var s = String(v).replace(/[\s,'₮]/g, '');
  if (s === '' || s === '-') return 0;
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '.' || s === '-.') throw new Error('Буруу дүн: ' + v);
  var neg = s.charAt(0) === '-';
  if (neg) s = s.slice(1);
  var parts = s.split('.'), ip = parts[0] || '0', fp = parts[1] || '';
  var n = Number(ip + (fp + '00').slice(0, 2));
  if (fp.length > 2 && Number(fp.charAt(2)) >= 5) n += 1;
  if (n > MAX_MINOR) throw new Error('Дүн хэт их: ' + v);
  return neg ? -n : n;
}

function fmtMoney_(m) {
  var neg = m < 0; m = Math.abs(m);
  var i = Math.floor(m / 100), f = m % 100;
  return (neg ? '-' : '') + String(i).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + (f < 10 ? '0' : '') + f;
}

/* ============================================================
 * Нэвтрэлт, эрх
 * ============================================================ */

function hash_(password, salt) {
  var h = salt + '|' + password;
  for (var i = 0; i < 300; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8));
  }
  return h;
}

function setPassword_(u, password, mustChange) {
  if (!password || String(password).length < 8) throw new Error('Нууц үг хамгийн багадаа 8 тэмдэгт байна.');
  u.salt = newId_() + newId_();
  u.pass_hash = hash_(String(password), u.salt);
  u.must_change = mustChange ? '1' : '0';
}

function login(username, password) {
  return wrap_(function () {
    username = String(username || '').trim().toLowerCase();
    var cache = CacheService.getScriptCache(), fk = 'fail_' + username;
    var fails = Number(cache.get(fk) || 0);
    if (fails >= 5) throw new Error('Олон удаа буруу оролдсон тул 15 минут түр хаагдлаа.');
    var u = readAll_('Users').filter(function (x) { return x.username === username && x.active !== '0'; })[0];
    if (!u || hash_(String(password || ''), u.salt) !== u.pass_hash) {
      cache.put(fk, String(fails + 1), 900);
      throw new Error('Нэвтрэх нэр эсвэл нууц үг буруу.');
    }
    cache.remove(fk);
    var token = newId_() + newId_() + newId_() + newId_();
    cache.put('tok_' + token, username, 21600);
    audit_(u, 'LOGIN', '', 'user', username, '');
    return { token: token, session: sessionInfo_(u) };
  });
}

function logout(token) {
  try { CacheService.getScriptCache().remove('tok_' + String(token || '')); } catch (e) { /* ignore */ }
  return { ok: true };
}

function auth_(token) {
  if (!token) throw new Error('Нэвтрэх хугацаа дууссан. Дахин нэвтэрнэ үү.');
  var cache = CacheService.getScriptCache();
  var username = cache.get('tok_' + token);
  if (!username) throw new Error('Нэвтрэх хугацаа дууссан. Дахин нэвтэрнэ үү.');
  var u = readAll_('Users').filter(function (x) { return x.username === username && x.active !== '0'; })[0];
  if (!u) throw new Error('Нэвтрэх хугацаа дууссан. Дахин нэвтэрнэ үү.');
  cache.put('tok_' + token, username, 21600);
  return u;
}

function can_(user, perm) { return (PERMS[perm] || []).indexOf(user.role) >= 0; }

function allowedCompanies_(user) {
  var all = readAll_('Companies').filter(function (c) { return c.active !== '0'; });
  if (user.companies === '*') return all;
  var ids = String(user.companies || '').split(',').map(function (s) { return s.trim(); });
  return all.filter(function (c) { return ids.indexOf(c.id) >= 0; });
}

function companyFor_(user, cid) {
  var c = allowedCompanies_(user).filter(function (x) { return x.id === cid; })[0];
  if (!c) throw new Error('Компани сонгоогүй эсвэл танд энэ компанид хандах эрх байхгүй.');
  return c;
}

function sessionInfo_(u) {
  var perms = {};
  Object.keys(PERMS).forEach(function (p) { perms[p] = can_(u, p); });
  return {
    app: { name: APP_NAME, version: APP_VERSION, today: today_() },
    user: { username: u.username, name: u.name, role: u.role, roleName: ROLES[u.role] || u.role, must_change: u.must_change === '1' },
    perms: perms,
    companies: allowedCompanies_(u).map(pubCompany_),
    consts: { TYPES: TYPES, SUBTYPES: SUBTYPES, CF: CF, ROLES: ROLES, PARTNER_KINDS: PARTNER_KINDS }
  };
}

function wrap_(fn) {
  try { return { ok: true, data: fn() }; }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

/** Клиентээс дуудагдах цорын ганц үүд. */
function api(token, method, params) {
  return wrap_(function () {
    MEM = {};
    var user = auth_(token);
    var def = API[method];
    if (!def) throw new Error('Үл мэдэгдэх үйлдэл: ' + method);
    if (user.must_change === '1' && method !== 'changePassword' && method !== 'session') {
      throw new Error('Эхлээд нууц үгээ солино уу.');
    }
    if (!can_(user, def.perm)) throw new Error('Танд энэ үйлдлийг хийх эрх байхгүй.');
    params = params || {};
    var company = def.company === false ? null : companyFor_(user, params.cid);
    if (!def.write) return def.fn(user, company, params);
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) throw new Error('Систем завгүй байна, дахин оролдоно уу.');
    try { MEM = {}; return def.fn(user, company, params); }
    finally { lock.releaseLock(); }
  });
}

function audit_(user, action, cid, object, id, details) {
  try {
    append_('Audit', [{ ts: now_(), username: (user && user.username) || '', action: action, company_id: cid || '',
      object: object || '', object_id: id || '', details: typeof details === 'string' ? details.slice(0, 2000) : JSON.stringify(details).slice(0, 2000) }]);
  } catch (e) { /* аудит бичих алдаа үндсэн үйлдлийг зогсоохгүй */ }
}

/* ============================================================
 * Компани, хэрэглэгч, тохиргоо
 * ============================================================ */

function pubCompany_(c) {
  return { id: c.id, code: c.code, name: c.name, register_no: c.register_no, vat_payer: c.vat_payer === '1', address: c.address, active: c.active !== '0' };
}

function createCompany_(p, user) {
  var code = clean_(p.code, 20).toUpperCase(), name = clean_(p.name, 200);
  if (!code || !name) throw new Error('Компанийн код, нэрийг оруулна уу.');
  if (readAll_('Companies').some(function (c) { return c.code === code; })) throw new Error('Ийм кодтой компани байна: ' + code);
  var c = { id: 'C' + newId_().slice(0, 10), code: code, name: name, register_no: clean_(p.register_no, 20), vat_payer: p.vat_payer ? '1' : '0',
    address: clean_(p.address, 300), active: '1', created_at: now_() };
  append_('Companies', [c]);
  append_('Accounts', COA_TEMPLATE.map(function (a) {
    return { company_id: c.id, code: a[0], name: a[1], type: a[2], parent: a[3], is_group: a[4] ? '1' : '0', subtype: a[5], active: '1' };
  }));
  append_('Settings', Object.keys(DEFAULT_SETTINGS).map(function (k) { return { company_id: c.id, key: k, value: DEFAULT_SETTINGS[k] }; }));
  audit_(user, 'COMPANY_CREATE', c.id, 'company', c.id, name);
  return c;
}

function apiCompanies_(user) { return readAll_('Companies').map(pubCompany_); }

function apiSaveCompany_(user, _c, p) {
  if (!p.id) { createCompany_(p, user); return apiCompanies_(user); }
  var c = readAll_('Companies').filter(function (x) { return x.id === p.id; })[0];
  if (!c) throw new Error('Компани олдсонгүй.');
  var name = clean_(p.name, 200);
  if (!name) throw new Error('Компанийн нэрийг оруулна уу.');
  c.name = name; c.register_no = clean_(p.register_no, 20); c.vat_payer = p.vat_payer ? '1' : '0';
  c.address = clean_(p.address, 300); c.active = p.active === false ? '0' : '1';
  update_('Companies', c);
  audit_(user, 'COMPANY_UPDATE', c.id, 'company', c.id, { name: name, active: c.active });
  return apiCompanies_(user);
}

function createUser_(p, password, mustChange) {
  var username = clean_(p.username, 30).toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error('Нэвтрэх нэр 3-30 тэмдэгт, латин жижиг үсэг/тоо байна.');
  if (!ROLES[p.role]) throw new Error('Эрхийн түвшин буруу.');
  if (readAll_('Users').some(function (u) { return u.username === username; })) throw new Error('Ийм нэвтрэх нэр бүртгэлтэй байна.');
  var u = { username: username, name: clean_(p.name, 100) || username, role: p.role, companies: normCompanies_(p.companies),
    active: '1', created_at: now_() };
  setPassword_(u, password, mustChange);
  append_('Users', [u]);
  return u;
}

function normCompanies_(v) {
  if (v === '*' || (Array.isArray(v) && v.indexOf('*') >= 0)) return '*';
  var ids = (Array.isArray(v) ? v : String(v || '').split(',')).map(function (s) { return String(s).trim(); }).filter(String);
  var valid = readAll_('Companies').map(function (c) { return c.id; });
  ids.forEach(function (id) { if (valid.indexOf(id) < 0) throw new Error('Компани олдсонгүй: ' + id); });
  return ids.join(',');
}

function pubUser_(u) {
  return { username: u.username, name: u.name, role: u.role, companies: u.companies, active: u.active !== '0', must_change: u.must_change === '1', created_at: u.created_at };
}

function apiUsers_() { return readAll_('Users').map(pubUser_); }

function apiSaveUser_(user, _c, p) {
  if (p.isNew) {
    var nu = createUser_(p, p.password, true);
    audit_(user, 'USER_CREATE', '', 'user', nu.username, { role: nu.role, companies: nu.companies });
    return apiUsers_();
  }
  var u = readAll_('Users').filter(function (x) { return x.username === p.username; })[0];
  if (!u) throw new Error('Хэрэглэгч олдсонгүй.');
  if (!ROLES[p.role]) throw new Error('Эрхийн түвшин буруу.');
  var willBeAdmin = p.role === 'ADMIN' && p.active !== false;
  if (u.role === 'ADMIN' && !willBeAdmin) {
    var admins = readAll_('Users').filter(function (x) { return x.role === 'ADMIN' && x.active !== '0'; });
    if (admins.length <= 1) throw new Error('Сүүлийн идэвхтэй админыг өөрчлөх боломжгүй.');
  }
  u.name = clean_(p.name, 100) || u.username; u.role = p.role; u.companies = normCompanies_(p.companies);
  u.active = p.active === false ? '0' : '1';
  update_('Users', u);
  audit_(user, 'USER_UPDATE', '', 'user', u.username, { role: u.role, companies: u.companies, active: u.active });
  return apiUsers_();
}

function apiResetPassword_(user, _c, p) {
  var u = readAll_('Users').filter(function (x) { return x.username === p.username; })[0];
  if (!u) throw new Error('Хэрэглэгч олдсонгүй.');
  setPassword_(u, p.password, true);
  update_('Users', u);
  audit_(user, 'PASSWORD_RESET', '', 'user', u.username, '');
  return true;
}

function apiChangePassword_(user, _c, p) {
  var u = readAll_('Users').filter(function (x) { return x.username === user.username; })[0];
  if (hash_(String(p.old || ''), u.salt) !== u.pass_hash) throw new Error('Одоогийн нууц үг буруу.');
  if (String(p.password || '') === String(p.old || '')) throw new Error('Шинэ нууц үг хуучинтайгаа ижил байна.');
  setPassword_(u, p.password, false);
  update_('Users', u);
  audit_(user, 'PASSWORD_CHANGE', '', 'user', u.username, '');
  return sessionInfo_(u);
}

function settings_(cid) {
  var s = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { s[k] = DEFAULT_SETTINGS[k]; });
  readAll_('Settings').forEach(function (r) { if (r.company_id === cid) s[r.key] = r.value; });
  return s;
}

function apiSaveSettings_(user, co, p) {
  var vals = p.values || {};
  if ('vat_rate' in vals && !(Number(vals.vat_rate) >= 0 && Number(vals.vat_rate) < 100)) throw new Error('НӨАТ-ын хувь буруу.');
  if ('cit_brackets' in vals) parseBrackets_(vals.cit_brackets);
  if ('retained_account' in vals) {
    var a = accountMap_(co.id)[String(vals.retained_account)];
    if (!a || a.type !== 'EQUITY' || a.is_group === '1') throw new Error('Хуримтлагдсан ашгийн данс нь өмчийн энгийн данс байх ёстой.');
  }
  var rows = readAll_('Settings');
  Object.keys(vals).forEach(function (k) {
    if (!(k in DEFAULT_SETTINGS)) return;
    var v = clean_(vals[k], 200);
    var r = rows.filter(function (x) { return x.company_id === co.id && x.key === k; })[0];
    if (r) { r.value = v; update_('Settings', r); rows = readAll_('Settings'); }
    else { append_('Settings', [{ company_id: co.id, key: k, value: v }]); rows = readAll_('Settings'); }
  });
  audit_(user, 'SETTINGS', co.id, 'settings', co.id, vals);
  return settings_(co.id);
}

function parseBrackets_(s) {
  var out = [];
  String(s || '').split(';').map(function (x) { return x.trim(); }).filter(String).forEach(function (part) {
    var kv = part.split(':');
    if (kv.length !== 2) throw new Error('ААНОАТ-ын шатлал буруу: ' + part);
    var rate = Number(kv[1]);
    if (!(rate >= 0 && rate < 100)) throw new Error('ААНОАТ-ын хувь буруу: ' + part);
    out.push({ limit: kv[0].trim() === '*' ? Infinity : toMinor_(kv[0].trim()), rate: rate });
  });
  if (!out.length || out[out.length - 1].limit !== Infinity) throw new Error('ААНОАТ-ын шатлал "*:хувь"-аар төгсөх ёстой.');
  return out;
}

/* ============================================================
 * Дансны төлөвлөгөө, харилцагч, чиглэл
 * ============================================================ */

function accounts_(cid) {
  return readAll_('Accounts').filter(function (a) { return a.company_id === cid; })
    .sort(function (a, b) { return a.code < b.code ? -1 : a.code > b.code ? 1 : 0; });
}
function accountMap_(cid) { var m = {}; accounts_(cid).forEach(function (a) { m[a.code] = a; }); return m; }
function pubAcc_(a) { return { code: a.code, name: a.name, type: a.type, parent: a.parent, is_group: a.is_group === '1', subtype: a.subtype, active: a.active !== '0' }; }

function partners_(cid) { return readAll_('Partners').filter(function (p) { return p.company_id === cid; }); }
function partnerMap_(cid) { var m = {}; partners_(cid).forEach(function (p) { m[p.id] = p; }); return m; }
function pubPartner_(p) { return { id: p.id, code: p.code, name: p.name, register_no: p.register_no, kind: p.kind, phone: p.phone, email: p.email, active: p.active !== '0' }; }

function segments_(cid) { return readAll_('Segments').filter(function (s) { return s.company_id === cid; }); }
function segmentMap_(cid) { var m = {}; segments_(cid).forEach(function (s) { m[s.code] = s; }); return m; }
function pubSegment_(s) { return { code: s.code, name: s.name, active: s.active !== '0' }; }

function apiMaster_(user, co) {
  return {
    company: pubCompany_(co),
    accounts: accounts_(co.id).map(pubAcc_),
    partners: partners_(co.id).map(pubPartner_).sort(function (a, b) { return a.name.localeCompare(b.name); }),
    segments: segments_(co.id).map(pubSegment_),
    settings: settings_(co.id)
  };
}

function usedAccounts_(cid) {
  var used = {};
  readAll_('Lines').forEach(function (l) { if (l.company_id === cid) used[l.account] = 1; });
  readAll_('Entries').forEach(function (e) {
    if (e.company_id === cid && e.status === 'DRAFT' && e.draft_json) {
      try { JSON.parse(e.draft_json).forEach(function (l) { used[l.account] = 1; }); } catch (x) { /* ignore */ }
    }
  });
  return used;
}

function apiSaveAccount_(user, co, p) {
  var code = clean_(p.code, 20);
  if (!/^[0-9A-Za-z.\-]{1,20}$/.test(code)) throw new Error('Дансны код зөвхөн тоо, үсэг, цэг, зураас агуулна.');
  if (!TYPES[p.type]) throw new Error('Дансны төрөл буруу.');
  var subtype = p.subtype || '';
  if (!(subtype in SUBTYPES)) throw new Error('Дэд төрөл буруу.');
  var name = clean_(p.name, 200);
  if (!name) throw new Error('Дансны нэрийг оруулна уу.');
  var all = accounts_(co.id), by = {};
  all.forEach(function (a) { by[a.code] = a; });
  var parent = clean_(p.parent, 20);
  if (parent) {
    if (!by[parent]) throw new Error('Эцэг данс олдсонгүй: ' + parent);
    if (by[parent].is_group !== '1') throw new Error('Эцэг данс нь бүлэг данс байх ёстой.');
    var cur = parent, guard = 0;
    while (cur && guard++ < 50) { if (cur === code) throw new Error('Данс өөрийнхөө дэд данс болж болохгүй.'); cur = by[cur] ? by[cur].parent : ''; }
  }
  var isGroup = p.is_group ? '1' : '0';
  var ex = by[code];
  var used = usedAccounts_(co.id)[code];
  if (ex) {
    if (p.isNew) throw new Error('Ийм кодтой данс аль хэдийн байна: ' + code);
    if (used && isGroup === '1') throw new Error('Гүйлгээ орсон дансыг бүлэг данс болгох боломжгүй.');
    if (used && ex.type !== p.type) throw new Error('Гүйлгээ орсон дансны төрлийг өөрчлөх боломжгүй.');
    if (ex.is_group === '1' && isGroup === '0' && all.some(function (a) { return a.parent === code; })) throw new Error('Дэд данстай бүлгийг энгийн данс болгох боломжгүй.');
    var before = pubAcc_(ex);
    ex.name = name; ex.type = p.type; ex.parent = parent; ex.is_group = isGroup; ex.subtype = subtype; ex.active = p.active === false ? '0' : '1';
    update_('Accounts', ex);
    audit_(user, 'ACCOUNT_UPDATE', co.id, 'account', code, { before: before, after: pubAcc_(ex) });
  } else {
    append_('Accounts', [{ company_id: co.id, code: code, name: name, type: p.type, parent: parent, is_group: isGroup, subtype: subtype, active: '1' }]);
    audit_(user, 'ACCOUNT_CREATE', co.id, 'account', code, name);
  }
  return accounts_(co.id).map(pubAcc_);
}

function apiSavePartner_(user, co, p) {
  var name = clean_(p.name, 200), code = clean_(p.code, 30);
  if (!name) throw new Error('Харилцагчийн нэрийг оруулна уу.');
  if (!code) throw new Error('Харилцагчийн кодыг оруулна уу.');
  var kind = PARTNER_KINDS[p.kind] ? p.kind : 'OTHER';
  var all = partners_(co.id);
  if (all.some(function (x) { return x.code === code && x.id !== p.id; })) throw new Error('Ийм кодтой харилцагч байна: ' + code);
  var rec;
  if (p.id) {
    rec = all.filter(function (x) { return x.id === p.id; })[0];
    if (!rec) throw new Error('Харилцагч олдсонгүй.');
    rec.code = code; rec.name = name; rec.register_no = clean_(p.register_no, 20); rec.kind = kind;
    rec.phone = clean_(p.phone, 50); rec.email = clean_(p.email, 100); rec.active = p.active === false ? '0' : '1';
    update_('Partners', rec);
    audit_(user, 'PARTNER_UPDATE', co.id, 'partner', rec.id, pubPartner_(rec));
  } else {
    rec = { company_id: co.id, id: 'P' + newId_().slice(0, 10), code: code, name: name, register_no: clean_(p.register_no, 20), kind: kind,
      phone: clean_(p.phone, 50), email: clean_(p.email, 100), active: '1' };
    append_('Partners', [rec]);
    audit_(user, 'PARTNER_CREATE', co.id, 'partner', rec.id, name);
  }
  return { id: rec.id, partners: partners_(co.id).map(pubPartner_).sort(function (a, b) { return a.name.localeCompare(b.name); }) };
}

function apiSaveSegment_(user, co, p) {
  var code = clean_(p.code, 20).toUpperCase(), name = clean_(p.name, 100);
  if (!/^[A-Z0-9_\-]{1,20}$/.test(code)) throw new Error('Чиглэлийн код латин үсэг, тоо байна.');
  if (!name) throw new Error('Чиглэлийн нэрийг оруулна уу.');
  var ex = segments_(co.id).filter(function (s) { return s.code === code; })[0];
  if (ex) {
    if (p.isNew) throw new Error('Ийм кодтой чиглэл байна.');
    ex.name = name; ex.active = p.active === false ? '0' : '1'; update_('Segments', ex);
  } else {
    append_('Segments', [{ company_id: co.id, code: code, name: name, active: '1' }]);
  }
  audit_(user, 'SEGMENT_SAVE', co.id, 'segment', code, name);
  return segments_(co.id).map(pubSegment_);
}

/* ============================================================
 * Тайлант үе
 * ============================================================ */

function periodStatus_(cid, period) {
  var r = readAll_('Periods').filter(function (x) { return x.company_id === cid && x.period === period; })[0];
  return r ? r.status : 'OPEN';
}

function assertOpen_(cid, date) {
  var p = date.slice(0, 7);
  if (periodStatus_(cid, p) === 'CLOSED') throw new Error(p + ' тайлант үе хаагдсан тул гүйлгээ бичих боломжгүй.');
}

function setPeriod_(user, cid, period, status) {
  var r = readAll_('Periods').filter(function (x) { return x.company_id === cid && x.period === period; })[0];
  var by = status === 'CLOSED' ? user.username : '', at = status === 'CLOSED' ? now_() : '';
  if (r) { r.status = status; r.closed_by = by; r.closed_at = at; update_('Periods', r); }
  else append_('Periods', [{ company_id: cid, period: period, status: status, closed_by: by, closed_at: at }]);
}

function activeClosing_(cid, year) {
  return readAll_('Entries').filter(function (e) {
    return e.company_id === cid && e.status === 'POSTED' && e.source === 'CLOSING' && e.date === year + '-12-31' && !e.reversed_by;
  })[0];
}

function draftsIn_(cid, prefix) {
  return readAll_('Entries').filter(function (e) { return e.company_id === cid && e.status === 'DRAFT' && e.date.indexOf(prefix) === 0; }).length;
}

function apiPeriods_(user, co, p) {
  var year = String(p.year || today_().slice(0, 4));
  if (!/^\d{4}$/.test(year)) throw new Error('Он буруу.');
  var rows = readAll_('Periods').filter(function (x) { return x.company_id === co.id; });
  var ents = readAll_('Entries').filter(function (e) { return e.company_id === co.id && e.date.indexOf(year) === 0; });
  var months = [];
  for (var m = 1; m <= 12; m++) {
    var per = year + '-' + (m < 10 ? '0' : '') + m;
    var r = rows.filter(function (x) { return x.period === per; })[0];
    months.push({
      period: per, status: r ? r.status : 'OPEN', closed_by: r ? r.closed_by : '', closed_at: r ? r.closed_at : '',
      posted: ents.filter(function (e) { return e.period === per && e.status === 'POSTED'; }).length,
      drafts: ents.filter(function (e) { return e.period === per && e.status === 'DRAFT'; }).length
    });
  }
  var cl = activeClosing_(co.id, year);
  return { year: year, months: months, yearClosed: !!cl, closingNumber: cl ? cl.number : '' };
}

function apiClosePeriod_(user, co, p) {
  var period = String(p.period || '');
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('Тайлант үе буруу.');
  var d = draftsIn_(co.id, period);
  if (d) throw new Error(period + ' үед ' + d + ' ноорог гүйлгээ байна. Эхлээд баталж эсвэл устгана уу.');
  setPeriod_(user, co.id, period, 'CLOSED');
  audit_(user, 'PERIOD_CLOSE', co.id, 'period', period, '');
  return apiPeriods_(user, co, { year: period.slice(0, 4) });
}

function apiReopenPeriod_(user, co, p) {
  var period = String(p.period || '');
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('Тайлант үе буруу.');
  if (activeClosing_(co.id, period.slice(0, 4))) throw new Error(period.slice(0, 4) + ' оны жилийн хаалт хийгдсэн байна. Эхлээд жилийн хаалтыг цуцална уу.');
  setPeriod_(user, co.id, period, 'OPEN');
  audit_(user, 'PERIOD_REOPEN', co.id, 'period', period, '');
  return apiPeriods_(user, co, { year: period.slice(0, 4) });
}

/** Жилийн хаалт: орлого, зардлын дансыг хааж цэвэр ашгийг хуримтлагдсан ашигт шилжүүлнэ. */
function apiCloseYear_(user, co, p) {
  var year = String(p.year || '');
  if (!/^\d{4}$/.test(year)) throw new Error('Он буруу.');
  if (activeClosing_(co.id, year)) throw new Error(year + ' оны хаалт аль хэдийн хийгдсэн.');
  var d = draftsIn_(co.id, year);
  if (d) throw new Error(year + ' онд ' + d + ' ноорог гүйлгээ байна. Эхлээд баталж эсвэл устгана уу.');
  var st = settings_(co.id), accs = accountMap_(co.id), ret = accs[st.retained_account];
  if (!ret || ret.type !== 'EQUITY' || ret.is_group === '1') throw new Error('Тохиргоонд хуримтлагдсан ашгийн данс буруу байна (' + st.retained_account + ').');
  var net = {};
  ledger_(co.id).forEach(function (l) {
    if (l.date.slice(0, 4) !== year) return;
    var a = accs[l.account];
    if (!a || (a.type !== 'REVENUE' && a.type !== 'EXPENSE')) return;
    net[l.account] = (net[l.account] || 0) + l.debit - l.credit;
  });
  var lines = [], diff = 0;
  Object.keys(net).sort().forEach(function (code) {
    var n = net[code];
    if (!n) return;
    diff += n;
    lines.push({ account: code, partner_id: '', segment: '', description: 'Жилийн хаалт', debit: n < 0 ? -n : 0, credit: n > 0 ? n : 0 });
  });
  var result = null;
  if (lines.length) {
    // diff = зардал - орлого → ашигтай бол diff < 0 → хуримтлагдсан ашгийг кредитлэнэ
    lines.push({ account: ret.code, partner_id: '', segment: '', description: diff < 0 ? 'Тайлант жилийн цэвэр ашиг' : 'Тайлант жилийн цэвэр алдагдал',
      debit: diff > 0 ? diff : 0, credit: diff < 0 ? -diff : 0 });
    result = writePosted_(user, co, [{ header: { date: year + '-12-31', description: year + ' оны жилийн хаалт', ref: '', cf: '', source: 'CLOSING' }, lines: lines }])[0];
  }
  for (var m = 1; m <= 12; m++) setPeriod_(user, co.id, year + '-' + (m < 10 ? '0' : '') + m, 'CLOSED');
  audit_(user, 'YEAR_CLOSE', co.id, 'year', year, { entry: result && result.number, profit: -diff });
  return apiPeriods_(user, co, { year: year });
}

function apiReopenYear_(user, co, p) {
  var year = String(p.year || '');
  var cl = activeClosing_(co.id, year);
  if (cl) {
    var lines = entryLines_(cl).map(swapLine_);
    var r = writePosted_(user, co, [{ header: { date: cl.date, description: 'Жилийн хаалтыг цуцалсан: ' + cl.number, ref: cl.number, cf: '', source: 'CLOSING_REV', reversal_of: cl.id }, lines: lines }])[0];
    var fresh = entryById_(co.id, cl.id);
    fresh.reversed_by = r.id; update_('Entries', fresh);
  }
  setPeriod_(user, co.id, year + '-12', 'OPEN');
  audit_(user, 'YEAR_REOPEN', co.id, 'year', year, cl ? cl.number : '');
  return apiPeriods_(user, co, { year: year });
}

/* ============================================================
 * Журнал: ноорог, батлах, буцаах
 * ============================================================ */

function entryById_(cid, id) {
  var e = readAll_('Entries').filter(function (x) { return x.company_id === cid && x.id === id; })[0];
  if (!e) throw new Error('Гүйлгээ олдсонгүй.');
  return e;
}

function entryLines_(e) {
  return readAll_('Lines').filter(function (l) { return l.entry_id === e.id && l.post_key === e.post_key; })
    .sort(function (a, b) { return Number(a.line_no) - Number(b.line_no); })
    .map(function (l) {
      return { account: l.account, partner_id: l.partner_id, segment: l.segment, description: l.description, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 };
    });
}

function swapLine_(l) {
  return { account: l.account, partner_id: l.partner_id, segment: l.segment, description: l.description, debit: l.credit, credit: l.debit };
}

/** Мөрүүдийг шалгаж, мөнгөний бүхэл дүн рүү хөрвүүлнэ. strict=true бол батлахад шаардлагатай бүх шалгалт. */
function normLines_(co, lines, strict, minor) {
  var acc = accountMap_(co.id), parts = partnerMap_(co.id), segs = segmentMap_(co.id), out = [];
  if (!Array.isArray(lines)) lines = [];
  if (lines.length > 500) throw new Error('Нэг гүйлгээнд 500-аас олон мөр байж болохгүй.');
  lines.forEach(function (l, i) {
    var n = (i + 1) + '-р мөр: ';
    var account = clean_(l.account, 20), partner = clean_(l.partner_id, 30), segment = clean_(l.segment, 20);
    var description = clean_(l.description, 300);
    var debit, credit;
    if (minor) { // ноорогт хадгалсан мөр — аль хэдийн мөнгөөр (бүхэл)
      debit = Number(l.debit) || 0; credit = Number(l.credit) || 0;
      if (debit % 1 || credit % 1) throw new Error(n + 'дүн бүхэл биш байна.');
    } else {
      try { debit = toMinor_(l.debit); credit = toMinor_(l.credit); } catch (e) { throw new Error(n + e.message); }
    }
    if (!account && !debit && !credit && !partner && !description) return; // хоосон мөр
    if (debit < 0 || credit < 0) throw new Error(n + 'дүн сөрөг байж болохгүй.');
    if (debit && credit) throw new Error(n + 'нэг мөрөнд дебет, кредитийн аль нэгийг л бөглөнө.');
    if (account || strict) {
      var a = acc[account];
      if (!a) throw new Error(n + 'данс олдсонгүй "' + account + '".');
      if (a.is_group === '1') throw new Error(n + account + ' бүлэг данс тул гүйлгээ бичих боломжгүй.');
      if (a.active === '0') throw new Error(n + account + ' данс идэвхгүй.');
      if (strict && (a.subtype === 'RECEIVABLE' || a.subtype === 'PAYABLE') && !partner) {
        throw new Error(n + account + ' ' + a.name + ' дансанд харилцагч заавал сонгоно.');
      }
    }
    if (partner && !parts[partner]) throw new Error(n + 'харилцагч олдсонгүй.');
    if (segment && !segs[segment]) throw new Error(n + 'чиглэл олдсонгүй "' + segment + '".');
    if (strict && !debit && !credit) throw new Error(n + 'дүн оруулна уу.');
    out.push({ account: account, partner_id: partner, segment: segment, description: description, debit: debit, credit: credit });
  });
  return out;
}

function checkBalanced_(lines) {
  if (lines.length < 2) throw new Error('Гүйлгээ хамгийн багадаа 2 мөртэй байна.');
  var d = 0, c = 0;
  lines.forEach(function (l) { d += l.debit; c += l.credit; });
  if (d !== c) throw new Error('Дебет (' + fmtMoney_(d) + ') ба кредит (' + fmtMoney_(c) + ') тэнцэхгүй байна. Зөрүү: ' + fmtMoney_(d - c));
  if (d <= 0) throw new Error('Гүйлгээний дүн 0 байна.');
  return d;
}

function nextNumberInt_(cid, year) {
  var prefix = 'JE' + year + '-', max = 0;
  readAll_('Entries').forEach(function (e) {
    if (e.company_id === cid && e.number.indexOf(prefix) === 0) {
      var n = parseInt(e.number.slice(prefix.length), 10);
      if (n > max) max = n;
    }
  });
  return max + 1;
}
function fmtNumber_(year, n) { return 'JE' + year + '-' + ('00000' + n).slice(-5); }

/** Шинэ батлагдсан гүйлгээ(үүд)-ийг бичнэ: эхлээд мөрүүд, дараа нь толгой. */
function writePosted_(user, co, items) {
  var ctr = {}, lineRows = [], heads = [], ts = now_();
  items.forEach(function (it) {
    var h = it.header, total = checkBalanced_(it.lines), y = h.date.slice(0, 4);
    if (!(y in ctr)) ctr[y] = nextNumberInt_(co.id, y);
    var id = newId_(), key = newId_();
    it.lines.forEach(function (l, i) {
      lineRows.push({ entry_id: id, company_id: co.id, line_no: i + 1, date: h.date, account: l.account, partner_id: l.partner_id || '',
        segment: l.segment || '', description: l.description || '', debit: l.debit, credit: l.credit, post_key: key });
    });
    heads.push({ id: id, company_id: co.id, number: fmtNumber_(y, ctr[y]++), date: h.date, period: h.date.slice(0, 7),
      description: h.description, ref: h.ref || '', status: 'POSTED', source: h.source || 'MANUAL', cf: h.cf || '',
      reversal_of: h.reversal_of || '', reversed_by: '', total: total, post_key: key, draft_json: '',
      created_by: user.username, created_at: ts, posted_by: user.username, posted_at: ts });
  });
  append_('Lines', lineRows);
  append_('Entries', heads);
  heads.forEach(function (h) { audit_(user, 'POST', co.id, 'entry', h.id, h.number + ' ' + h.source + ' ' + fmtMoney_(h.total)); });
  return heads.map(function (h) { return { id: h.id, number: h.number }; });
}

function apiSaveDraft_(user, co, p) {
  var date = validDate_(p.date);
  var lines = normLines_(co, p.lines, false);
  var total = 0; lines.forEach(function (l) { total += l.debit; });
  var fields = { date: date, period: date.slice(0, 7), description: clean_(p.description, 500), ref: clean_(p.ref, 100),
    cf: CF[p.cf] ? p.cf : '', total: total, draft_json: JSON.stringify(lines) };
  var e;
  if (p.id) {
    e = entryById_(co.id, p.id);
    if (e.status !== 'DRAFT') throw new Error('Зөвхөн ноорог гүйлгээг засах боломжтой.');
    Object.keys(fields).forEach(function (k) { e[k] = fields[k]; });
    update_('Entries', e);
    audit_(user, 'DRAFT_UPDATE', co.id, 'entry', e.id, fields.description);
  } else {
    e = { id: newId_(), company_id: co.id, number: '', status: 'DRAFT', source: 'MANUAL', reversal_of: '', reversed_by: '', post_key: '',
      created_by: user.username, created_at: now_(), posted_by: '', posted_at: '' };
    Object.keys(fields).forEach(function (k) { e[k] = fields[k]; });
    append_('Entries', [e]);
    audit_(user, 'DRAFT_CREATE', co.id, 'entry', e.id, fields.description);
  }
  return { id: e.id };
}

function apiPost_(user, co, p) {
  var id = p.id;
  if (p.lines) {
    // Эхлээд бүрэн шалгана — алдаатай бол юу ч хадгалахгүй
    var d0 = validDate_(p.date);
    if (!clean_(p.description, 500)) throw new Error('Гүйлгээний утгыг оруулна уу.');
    checkBalanced_(normLines_(co, p.lines, true));
    assertOpen_(co.id, d0);
    id = apiSaveDraft_(user, co, p).id;
  }
  var e = entryById_(co.id, id);
  if (e.status !== 'DRAFT') throw new Error('Энэ гүйлгээ ноорог биш байна.');
  if (!e.description) throw new Error('Гүйлгээний утгыг оруулна уу.');
  var lines = normLines_(co, JSON.parse(e.draft_json || '[]'), true, true);
  var total = checkBalanced_(lines);
  assertOpen_(co.id, e.date);
  var key = newId_(), year = e.date.slice(0, 4), number = fmtNumber_(year, nextNumberInt_(co.id, year));
  append_('Lines', lines.map(function (l, i) {
    return { entry_id: e.id, company_id: co.id, line_no: i + 1, date: e.date, account: l.account, partner_id: l.partner_id, segment: l.segment,
      description: l.description, debit: l.debit, credit: l.credit, post_key: key };
  }));
  e = entryById_(co.id, id); // Lines бичсэний дараа толгойг дахин уншина
  e.status = 'POSTED'; e.number = number; e.post_key = key; e.total = total; e.draft_json = '';
  e.posted_by = user.username; e.posted_at = now_();
  update_('Entries', e);
  audit_(user, 'POST', co.id, 'entry', e.id, number + ' ' + fmtMoney_(total));
  return { id: e.id, number: number };
}

function apiDeleteDraft_(user, co, p) {
  var e = entryById_(co.id, p.id);
  if (e.status !== 'DRAFT') throw new Error('Зөвхөн ноорог гүйлгээг устгана. Батлагдсан гүйлгээг буцаалтаар засна.');
  e.status = 'DELETED';
  update_('Entries', e);
  audit_(user, 'DRAFT_DELETE', co.id, 'entry', e.id, e.description);
  return true;
}

function apiReverse_(user, co, p) {
  var e = entryById_(co.id, p.id);
  if (e.status !== 'POSTED') throw new Error('Зөвхөн батлагдсан гүйлгээг буцаана.');
  if (e.reversed_by) throw new Error('Энэ гүйлгээ аль хэдийн буцаагдсан.');
  if (e.source === 'REVERSAL' || CLOSING_SOURCES[e.source]) throw new Error('Буцаалтын болон жилийн хаалтын гүйлгээг энд буцаах боломжгүй.');
  var date = validDate_(p.date || today_(), 'Буцаалтын огноо');
  if (date < e.date) throw new Error('Буцаалтын огноо эх гүйлгээний огнооноос өмнө байж болохгүй.');
  assertOpen_(co.id, date);
  var reason = clean_(p.reason, 300);
  var r = writePosted_(user, co, [{
    header: { date: date, description: 'Буцаалт ' + e.number + ': ' + (reason || e.description), ref: e.number, cf: e.cf, source: 'REVERSAL', reversal_of: e.id },
    lines: entryLines_(e).map(swapLine_)
  }])[0];
  var fresh = entryById_(co.id, e.id);
  fresh.reversed_by = r.id;
  update_('Entries', fresh);
  audit_(user, 'REVERSE', co.id, 'entry', e.id, e.number + ' → ' + r.number + (reason ? ' (' + reason + ')' : ''));
  return r;
}

function pubEntry_(e) {
  return { id: e.id, number: e.number, date: e.date, description: e.description, ref: e.ref, status: e.status, source: e.source, cf: e.cf,
    total: Number(e.total) || 0, reversed_by: e.reversed_by, reversal_of: e.reversal_of, created_by: e.created_by, posted_by: e.posted_by, posted_at: e.posted_at };
}

function apiEntries_(user, co, p) {
  var from = p.from ? validDate_(p.from) : '', to = p.to ? validDate_(p.to) : '';
  var q = String(p.q || '').toLowerCase().trim(), status = p.status || '';
  var list = readAll_('Entries').filter(function (e) {
    if (e.company_id !== co.id || e.status === 'DELETED') return false;
    if (from && e.date < from) return false;
    if (to && e.date > to) return false;
    if (status === 'DRAFT' && e.status !== 'DRAFT') return false;
    if (status === 'POSTED' && (e.status !== 'POSTED' || e.reversed_by)) return false;
    if (status === 'REVERSED' && !e.reversed_by) return false;
    if (q && (e.number + ' ' + e.description + ' ' + e.ref).toLowerCase().indexOf(q) < 0) return false;
    return true;
  }).sort(function (a, b) {
    return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.created_at < b.created_at ? 1 : -1);
  });
  return { total: list.length, rows: list.slice(0, 1000).map(pubEntry_) };
}

function apiEntry_(user, co, p) {
  var e = entryById_(co.id, p.id);
  var lines = e.status === 'DRAFT' ? JSON.parse(e.draft_json || '[]') : entryLines_(e);
  var rev = e.reversed_by ? readAll_('Entries').filter(function (x) { return x.id === e.reversed_by; })[0] : null;
  var orig = e.reversal_of ? readAll_('Entries').filter(function (x) { return x.id === e.reversal_of; })[0] : null;
  var out = pubEntry_(e);
  out.lines = lines;
  out.reversed_by_number = rev ? rev.number : '';
  out.reversal_of_number = orig ? orig.number : '';
  out.created_at = e.created_at;
  return out;
}

/* ============================================================
 * Ерөнхий дэвтэр ба тайлангууд
 * ============================================================ */

/** Тухайн компанийн бүх батлагдсан мөрүүд (огноо, дугаараар эрэмбэлсэн). */
function ledger_(cid) {
  var k = 'led_' + cid;
  if (MEM[k]) return MEM[k];
  var heads = {};
  readAll_('Entries').forEach(function (e) { if (e.company_id === cid && e.status === 'POSTED') heads[e.id] = e; });
  var out = [];
  readAll_('Lines').forEach(function (l) {
    if (l.company_id !== cid) return;
    var h = heads[l.entry_id];
    if (!h || h.post_key !== l.post_key) return; // дуусаагүй бичилт → тооцохгүй
    out.push({ id: h.id, number: h.number, date: l.date, account: l.account, partner_id: l.partner_id, segment: l.segment,
      description: l.description || h.description, edesc: h.description, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0,
      source: h.source, cf: h.cf, line_no: Number(l.line_no) || 0 });
  });
  out.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.number !== b.number) return a.number < b.number ? -1 : 1;
    return a.line_no - b.line_no;
  });
  MEM[k] = out;
  return out;
}

function tree_(accs) {
  var by = {}, ch = {}, roots = [], order = [], seen = {};
  accs.forEach(function (a) { by[a.code] = a; });
  accs.forEach(function (a) {
    if (a.parent && by[a.parent] && a.parent !== a.code) (ch[a.parent] = ch[a.parent] || []).push(a);
    else roots.push(a);
  });
  function walk(a, lv) {
    if (seen[a.code]) return;
    seen[a.code] = 1; order.push({ a: a, level: lv });
    (ch[a.code] || []).forEach(function (c) { walk(c, lv + 1); });
  }
  roots.forEach(function (r) { walk(r, 0); });
  accs.forEach(function (a) { if (!seen[a.code]) walk(a, 0); });
  return { by: by, ch: ch, order: order };
}

/** leaf: код → тоон массив. Бүлэг бүрт дэд дансны нийлбэрийг гаргана. */
function rollup_(accs, leaf, width) {
  var t = tree_(accs), memo = {};
  function zero() { var z = []; for (var i = 0; i < width; i++) z.push(0); return z; }
  function sum(code, depth) {
    if (memo[code]) return memo[code];
    var v = (leaf[code] || zero()).slice();
    if (depth < 50) (t.ch[code] || []).forEach(function (c) {
      var cv = sum(c.code, depth + 1);
      for (var i = 0; i < width; i++) v[i] += cv[i];
    });
    memo[code] = v;
    return v;
  }
  t.order.forEach(function (o) { sum(o.a.code, 0); });
  return { t: t, v: memo };
}

function descendants_(accs, code) {
  var t = tree_(accs), set = {};
  function walk(c, d) { set[c] = 1; if (d < 50) (t.ch[c] || []).forEach(function (x) { walk(x.code, d + 1); }); }
  if (t.by[code]) walk(code, 0);
  return set;
}

function range_(p) {
  var from = validDate_(p.from, 'Эхлэх огноо'), to = validDate_(p.to, 'Дуусах огноо');
  if (from > to) throw new Error('Эхлэх огноо дуусах огнооноос хойш байна.');
  return { from: from, to: to };
}

function apiTrialBalance_(user, co, p) {
  var r = range_(p), seg = p.segment || '';
  var accs = accounts_(co.id), leaf = {};
  ledger_(co.id).forEach(function (l) {
    if (l.date > r.to || (seg && l.segment !== seg)) return;
    var v = leaf[l.account] || (leaf[l.account] = [0, 0, 0]);
    if (l.date < r.from) v[0] += l.debit - l.credit;
    else { v[1] += l.debit; v[2] += l.credit; }
  });
  var ru = rollup_(accs, leaf, 3), rows = [], tot = { od: 0, oc: 0, td: 0, tc: 0, cd: 0, cc: 0 };
  ru.t.order.forEach(function (o) {
    var v = ru.v[o.a.code], c = v[0] + v[1] - v[2];
    if (!p.showZero && !v[0] && !v[1] && !v[2]) return;
    var row = { code: o.a.code, name: o.a.name, level: o.level, is_group: o.a.is_group === '1', type: o.a.type,
      od: v[0] > 0 ? v[0] : 0, oc: v[0] < 0 ? -v[0] : 0, td: v[1], tc: v[2], cd: c > 0 ? c : 0, cc: c < 0 ? -c : 0 };
    rows.push(row);
    if (!row.is_group) ['od', 'oc', 'td', 'tc', 'cd', 'cc'].forEach(function (k) { tot[k] += row[k]; });
  });
  return { from: r.from, to: r.to, rows: rows, totals: tot, balanced: tot.od === tot.oc && tot.td === tot.tc && tot.cd === tot.cc };
}

function apiLedger_(user, co, p) {
  var r = range_(p), accs = accounts_(co.id), code = clean_(p.account, 20), partner = clean_(p.partner_id, 30), seg = p.segment || '';
  if (!code && !partner) throw new Error('Данс эсвэл харилцагч сонгоно уу.');
  var set = code ? descendants_(accs, code) : null;
  if (code && !Object.keys(set).length) throw new Error('Данс олдсонгүй.');
  var parts = partnerMap_(co.id), am = accountMap_(co.id);
  var opening = 0, rows = [], td = 0, tc = 0;
  ledger_(co.id).forEach(function (l) {
    if (set && !set[l.account]) return;
    if (partner && l.partner_id !== partner) return;
    if (seg && l.segment !== seg) return;
    if (l.date > r.to) return;
    if (l.date < r.from) { opening += l.debit - l.credit; return; }
    td += l.debit; tc += l.credit;
    rows.push({ id: l.id, date: l.date, number: l.number, description: l.description, account: l.account,
      account_name: am[l.account] ? am[l.account].name : '', partner: parts[l.partner_id] ? parts[l.partner_id].name : '',
      debit: l.debit, credit: l.credit });
  });
  var bal = opening;
  rows.forEach(function (x) { bal += x.debit - x.credit; x.balance = bal; });
  var a = code ? am[code] : null;
  return { from: r.from, to: r.to, account: a ? pubAcc_(a) : null, partner: partner && parts[partner] ? pubPartner_(parts[partner]) : null,
    opening: opening, rows: rows, td: td, tc: tc, closing: opening + td - tc };
}

function netAt_(cid, date) {
  var net = {};
  ledger_(cid).forEach(function (l) { if (l.date <= date) net[l.account] = (net[l.account] || 0) + l.debit - l.credit; });
  return net;
}

function apiBalanceSheet_(user, co, p) {
  var date = validDate_(p.date, 'Тайлангийн огноо');
  var cmp = p.compare ? validDate_(p.compare, 'Харьцуулах огноо') : (Number(date.slice(0, 4)) - 1) + '-12-31';
  var accs = accounts_(co.id), n1 = netAt_(co.id, date), n0 = netAt_(co.id, cmp), leaf = {};
  accs.forEach(function (a) { leaf[a.code] = [n0[a.code] || 0, n1[a.code] || 0]; });
  var ru = rollup_(accs, leaf, 2);
  function section(type, sign) {
    var rows = [], total = [0, 0];
    ru.t.order.forEach(function (o) {
      if (o.a.type !== type) return;
      var v = ru.v[o.a.code];
      if (!v[0] && !v[1]) return;
      var vals = [sign * v[0], sign * v[1]];
      rows.push({ code: o.a.code, name: o.a.name, level: o.level, is_group: o.a.is_group === '1', v: vals });
      if (o.a.is_group !== '1') { total[0] += vals[0]; total[1] += vals[1]; }
    });
    return { rows: rows, total: total };
  }
  function unclosed(net) {
    var s = 0;
    accs.forEach(function (a) { if (a.type === 'REVENUE' || a.type === 'EXPENSE') s += net[a.code] || 0; });
    return -s;
  }
  var assets = section('ASSET', 1), liab = section('LIABILITY', -1), eq = section('EQUITY', -1);
  var profit = [unclosed(n0), unclosed(n1)];
  if (profit[0] || profit[1]) {
    eq.rows.push({ code: '', name: 'Тайлант үеийн цэвэр ашиг (хаагдаагүй)', level: 1, is_group: false, v: profit, computed: true });
    eq.total = [eq.total[0] + profit[0], eq.total[1] + profit[1]];
  }
  var le = [liab.total[0] + eq.total[0], liab.total[1] + eq.total[1]];
  return { date: date, compare: cmp, assets: assets, liabilities: liab, equity: eq, totalLE: le,
    balanced: assets.total[0] === le[0] && assets.total[1] === le[1] };
}

function apiIncomeStatement_(user, co, p) {
  var r = range_(p), accs = accounts_(co.id), seg = p.segment || '';
  var cols;
  if (p.bySegment) {
    cols = segments_(co.id).map(function (s) { return { label: s.name, f: function (l) { return l.segment === s.code; } }; });
    cols.push({ label: 'Чиглэлгүй', f: function (l) { return !l.segment; } });
    cols.push({ label: 'Нийт', f: function () { return true; } });
  } else {
    cols = [{ label: 'Дүн', f: seg ? function (l) { return l.segment === seg; } : function () { return true; } }];
  }
  var w = cols.length, leaf = {};
  ledger_(co.id).forEach(function (l) {
    if (l.date < r.from || l.date > r.to || CLOSING_SOURCES[l.source]) return;
    var v = leaf[l.account];
    if (!v) { v = leaf[l.account] = []; for (var i = 0; i < w; i++) v.push(0); }
    for (var j = 0; j < w; j++) if (cols[j].f(l)) v[j] += l.debit - l.credit;
  });
  function zero() { var z = []; for (var i = 0; i < w; i++) z.push(0); return z; }
  function sec(filter, sign) {
    var rows = [], total = zero();
    accs.forEach(function (a) {
      if (a.is_group === '1' || !filter(a) || !leaf[a.code]) return;
      var v = leaf[a.code].map(function (x) { return sign * x; });
      if (v.every(function (x) { return !x; })) return;
      rows.push({ code: a.code, name: a.name, v: v });
      for (var i = 0; i < w; i++) total[i] += v[i];
    });
    return { rows: rows, total: total };
  }
  function sub(a, b) { return a.map(function (x, i) { return x - b[i]; }); }
  var revenue = sec(function (a) { return a.type === 'REVENUE'; }, -1);
  var cogs = sec(function (a) { return a.type === 'EXPENSE' && a.subtype === 'COGS'; }, 1);
  var opex = sec(function (a) { return a.type === 'EXPENSE' && a.subtype !== 'COGS' && a.subtype !== 'INCOME_TAX'; }, 1);
  var tax = sec(function (a) { return a.type === 'EXPENSE' && a.subtype === 'INCOME_TAX'; }, 1);
  var gross = sub(revenue.total, cogs.total), pbt = sub(gross, opex.total), net = sub(pbt, tax.total);
  return { from: r.from, to: r.to, columns: cols.map(function (c) { return c.label; }), revenue: revenue, cogs: cogs, gross: gross,
    opex: opex, pbt: pbt, tax: tax, net: net };
}

function inferCf_(lines, accMap) {
  var cf = 'OPERATING';
  lines.forEach(function (l) {
    var a = accMap[l.account];
    if (!a || a.subtype === 'CASH') return;
    if (a.subtype === 'FIXED_ASSET') cf = 'INVESTING';
    else if ((a.subtype === 'LOAN' || a.type === 'EQUITY') && cf !== 'INVESTING') cf = 'FINANCING';
  });
  return cf;
}

function apiCashFlow_(user, co, p) {
  var r = range_(p), am = accountMap_(co.id);
  var isCash = function (code) { return am[code] && am[code].subtype === 'CASH'; };
  var opening = 0, closing = 0, byEntry = {}, order = [];
  ledger_(co.id).forEach(function (l) {
    if (l.date > r.to) return;
    if (isCash(l.account)) {
      if (l.date < r.from) opening += l.debit - l.credit;
      closing += l.debit - l.credit;
    }
    if (l.date < r.from || CLOSING_SOURCES[l.source]) return;
    if (!byEntry[l.id]) { byEntry[l.id] = { cf: l.cf, lines: [] }; order.push(l.id); }
    byEntry[l.id].lines.push(l);
  });
  var cats = {};
  Object.keys(CF).forEach(function (k) { cats[k] = { key: k, label: CF[k], items: {}, inflow: 0, outflow: 0 }; });
  order.forEach(function (id) {
    var e = byEntry[id];
    var cashLines = e.lines.filter(function (l) { return isCash(l.account); });
    if (!cashLines.length) return;
    var other = e.lines.filter(function (l) { return !isCash(l.account); });
    if (!other.length) return; // мөнгөн хөрөнгийн дансуудын хоорондох шилжүүлэг
    var cat = cats[CF[e.cf] ? e.cf : inferCf_(e.lines, am)];
    other.forEach(function (l) {
      var amt = l.credit - l.debit; // мөнгөнд үзүүлэх нөлөө
      if (!amt) return;
      var a = am[l.account], key = (amt > 0 ? 'in|' : 'out|') + l.account;
      var it = cat.items[key] || (cat.items[key] = { account: l.account, name: a ? a.name : l.account, amount: 0, dir: amt > 0 ? 'in' : 'out' });
      it.amount += amt;
      if (amt > 0) cat.inflow += amt; else cat.outflow += amt;
    });
  });
  var sections = Object.keys(cats).map(function (k) {
    var c = cats[k], items = Object.keys(c.items).map(function (x) { return c.items[x]; });
    items.sort(function (a, b) { return a.dir === b.dir ? (a.account < b.account ? -1 : 1) : (a.dir === 'in' ? -1 : 1); });
    return { key: k, label: c.label, inflows: items.filter(function (i) { return i.dir === 'in'; }), outflows: items.filter(function (i) { return i.dir === 'out'; }),
      inflow: c.inflow, outflow: c.outflow, net: c.inflow + c.outflow };
  });
  var net = sections.reduce(function (s, x) { return s + x.net; }, 0);
  return { from: r.from, to: r.to, opening: opening, sections: sections, net: net, closing: closing, balanced: opening + net === closing };
}

function apiEquityChanges_(user, co, p) {
  var r = range_(p), accs = accounts_(co.id), am = {};
  accs.forEach(function (a) { am[a.code] = a; });
  var eqAccs = accs.filter(function (a) { return a.type === 'EQUITY' && a.is_group !== '1'; });
  var col = {}; // код → [эхний, ашиг, хаалтын шилжүүлэг, бусад өөрчлөлт]
  eqAccs.forEach(function (a) { col[a.code] = [0, 0, 0, 0]; });
  var pl = [0, 0, 0, 0];
  ledger_(co.id).forEach(function (l) {
    if (l.date > r.to) return;
    var a = am[l.account];
    if (!a) return;
    var amt = l.credit - l.debit, closing = !!CLOSING_SOURCES[l.source];
    if (a.type === 'EQUITY') {
      var c = col[l.account] || (col[l.account] = [0, 0, 0, 0]);
      if (l.date < r.from) c[0] += amt; else if (closing) c[2] += amt; else c[3] += amt;
    } else if (a.type === 'REVENUE' || a.type === 'EXPENSE') {
      if (l.date < r.from) pl[0] += amt; else if (closing) pl[2] += amt; else pl[1] += amt;
    }
  });
  var columns = eqAccs.filter(function (a) { return col[a.code].some(function (x) { return x; }); })
    .map(function (a) { var v = col[a.code]; return { code: a.code, name: a.name, opening: v[0], profit: v[1], transfer: v[2], other: v[3], closing: v[0] + v[1] + v[2] + v[3] }; });
  columns.push({ code: '', name: 'Хаагдаагүй ашиг', opening: pl[0], profit: pl[1], transfer: pl[2], other: pl[3], closing: pl[0] + pl[1] + pl[2] + pl[3] });
  var total = { opening: 0, profit: 0, transfer: 0, other: 0, closing: 0 };
  columns.forEach(function (c) { Object.keys(total).forEach(function (k) { total[k] += c[k]; }); });
  return { from: r.from, to: r.to, columns: columns, total: total };
}

function apiPartnerBalances_(user, co, p) {
  var date = validDate_(p.date, 'Огноо'), kind = p.kind === 'PAYABLE' ? 'PAYABLE' : 'RECEIVABLE';
  var am = accountMap_(co.id), parts = partnerMap_(co.id), by = {};
  ledger_(co.id).forEach(function (l) {
    if (l.date > date) return;
    var a = am[l.account];
    if (!a || a.subtype !== kind) return;
    var pid = l.partner_id || '';
    var x = by[pid] || (by[pid] = { inc: [], dec: 0 });
    var inc = kind === 'RECEIVABLE' ? l.debit : l.credit, dec = kind === 'RECEIVABLE' ? l.credit : l.debit;
    if (inc) x.inc.push({ date: l.date, amt: inc });
    x.dec += dec;
  });
  var rows = [], tot = { balance: 0, b0: 0, b30: 0, b60: 0, b90: 0, prepaid: 0 };
  Object.keys(by).forEach(function (pid) {
    var x = by[pid], incSum = x.inc.reduce(function (s, i) { return s + i.amt; }, 0), bal = incSum - x.dec;
    if (!bal && !p.showZero) return;
    var row = { partner_id: pid, code: parts[pid] ? parts[pid].code : '', name: parts[pid] ? parts[pid].name : '(харилцагчгүй)',
      balance: bal, b0: 0, b30: 0, b60: 0, b90: 0, prepaid: 0 };
    if (bal > 0) {
      var rem = x.dec; // FIFO: төлөлтийг хамгийн эртний үлдэгдэлд тулгана
      x.inc.forEach(function (i) {
        var left = i.amt;
        if (rem > 0) { var used = Math.min(rem, left); left -= used; rem -= used; }
        if (!left) return;
        var d = daysBetween_(i.date, date);
        if (d <= 30) row.b0 += left; else if (d <= 60) row.b30 += left; else if (d <= 90) row.b60 += left; else row.b90 += left;
      });
    } else if (bal < 0) row.prepaid = -bal;
    rows.push(row);
    Object.keys(tot).forEach(function (k) { tot[k] += row[k]; });
  });
  rows.sort(function (a, b) { return b.balance - a.balance; });
  return { date: date, kind: kind, rows: rows, total: tot };
}

function citCalc_(st, revenue, pbt) {
  var small = toMinor_(st.cit_small_threshold || '0');
  if (small > 0 && revenue <= small) {
    return { method: 'small', base: revenue, tax: Math.round(revenue * Number(st.cit_small_rate) / 100),
      note: 'Борлуулалтын орлого ' + fmtMoney_(small) + '₮-өөс бага тул орлогоос ' + st.cit_small_rate + '%' };
  }
  var br = parseBrackets_(st.cit_brackets), base = Math.max(pbt, 0), prev = 0, tax = 0, parts = [];
  br.forEach(function (b) {
    if (base <= prev) return;
    var portion = Math.min(base, b.limit) - prev;
    var t = Math.round(portion * b.rate / 100);
    tax += t; parts.push(fmtMoney_(portion) + ' × ' + b.rate + '%');
    prev = b.limit;
  });
  return { method: 'brackets', base: base, tax: tax, note: parts.join(' + ') || 'Татвар ногдох ашиг алга' };
}

function apiTaxReport_(user, co, p) {
  var r = range_(p), am = accountMap_(co.id), st = settings_(co.id), months = {};
  var revenue = 0, expense = 0, taxExp = 0, vatOut = 0, vatIn = 0;
  ledger_(co.id).forEach(function (l) {
    if (l.date < r.from || l.date > r.to || CLOSING_SOURCES[l.source]) return;
    var a = am[l.account];
    if (!a) return;
    var per = l.date.slice(0, 7), m = months[per] || (months[per] = { period: per, out: 0, inp: 0, revenue: 0 });
    if (a.subtype === 'VAT_OUT') { vatOut += l.credit - l.debit; m.out += l.credit - l.debit; }
    if (a.subtype === 'VAT_IN') { vatIn += l.debit - l.credit; m.inp += l.debit - l.credit; }
    if (a.type === 'REVENUE') { revenue += l.credit - l.debit; m.revenue += l.credit - l.debit; }
    if (a.type === 'EXPENSE') { if (a.subtype === 'INCOME_TAX') taxExp += l.debit - l.credit; else expense += l.debit - l.credit; }
  });
  var pbt = revenue - expense;
  return {
    from: r.from, to: r.to, settings: st,
    vat: { out: vatOut, inp: vatIn, payable: vatOut - vatIn,
      months: Object.keys(months).sort().map(function (k) { var m = months[k]; m.payable = m.out - m.inp; return m; })
        .filter(function (m) { return m.out || m.inp || m.revenue; }) },
    cit: { revenue: revenue, expense: expense, pbt: pbt, booked: taxExp, calc: citCalc_(st, revenue, pbt) }
  };
}

function apiDashboard_(user, co) {
  var today = today_(), month = today.slice(0, 7), year = today.slice(0, 4), am = accountMap_(co.id);
  var k = { cash: 0, ar: 0, ap: 0, revM: 0, expM: 0, revY: 0, expY: 0 }, months = {};
  for (var i = 5; i >= 0; i--) {
    var d = new Date(Date.UTC(+year, +month.slice(5, 7) - 1 - i, 1));
    var per = d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2);
    months[per] = { period: per, revenue: 0, expense: 0 };
  }
  ledger_(co.id).forEach(function (l) {
    var a = am[l.account];
    if (!a || l.date > today) return;
    var n = l.debit - l.credit;
    if (a.subtype === 'CASH') k.cash += n;
    if (a.subtype === 'RECEIVABLE') k.ar += n;
    if (a.subtype === 'PAYABLE') k.ap -= n;
    if (CLOSING_SOURCES[l.source]) return;
    var per = l.date.slice(0, 7);
    if (a.type === 'REVENUE') {
      if (per === month) k.revM -= n;
      if (l.date.slice(0, 4) === year) k.revY -= n;
      if (months[per]) months[per].revenue -= n;
    } else if (a.type === 'EXPENSE') {
      if (per === month) k.expM += n;
      if (l.date.slice(0, 4) === year) k.expY += n;
      if (months[per]) months[per].expense += n;
    }
  });
  var ents = readAll_('Entries').filter(function (e) { return e.company_id === co.id && e.status !== 'DELETED'; });
  var recent = ents.filter(function (e) { return e.status === 'POSTED'; })
    .sort(function (a, b) { return a.posted_at < b.posted_at ? 1 : -1; }).slice(0, 8).map(pubEntry_);
  return {
    today: today, kpi: k, profitY: k.revY - k.expY, months: Object.keys(months).map(function (x) { return months[x]; }),
    drafts: ents.filter(function (e) { return e.status === 'DRAFT'; }).length,
    periodStatus: periodStatus_(co.id, month), recent: recent
  };
}

function apiAudit_(user, co, p) {
  var lim = Math.min(Number(p.limit) || 300, 2000);
  var all = readAll_('Audit').filter(function (a) { return a.company_id === co.id || (user.role === 'ADMIN' && !a.company_id); });
  return all.slice(-lim).reverse().map(function (a) {
    return { ts: a.ts, username: a.username, action: a.action, object: a.object, object_id: a.object_id, details: a.details };
  });
}

/* ============================================================
 * Импорт (Excel-ээс хуулж буулгах / CSV)
 * ============================================================ */

function apiImport_(user, co, p) {
  var rows = Array.isArray(p.rows) ? p.rows : [];
  if (!rows.length) throw new Error('Импортлох мөр алга.');
  if (rows.length > 3000) throw new Error('Нэг удаад 3000-аас ихгүй мөр импортлоно.');
  var post = !!p.post;
  if (post && !can_(user, 'post')) throw new Error('Танд гүйлгээ батлах эрх байхгүй.');
  var byCode = {};
  partners_(co.id).forEach(function (x) { byCode[x.code] = x.id; });
  var groups = {}, order = [], errors = [];
  rows.forEach(function (r, i) {
    var key = clean_(r.key, 50) || ('#' + (i + 1));
    if (!groups[key]) { groups[key] = { key: key, first: i + 2, date: r.date, description: r.description, ref: r.ref, cf: r.cf, lines: [] }; order.push(key); }
    var pc = clean_(r.partner, 30);
    if (pc && !byCode[pc]) errors.push((i + 2) + '-р мөр: харилцагчийн код олдсонгүй "' + pc + '"');
    groups[key].lines.push({ account: r.account, partner_id: pc ? byCode[pc] || '' : '', segment: clean_(r.segment, 20).toUpperCase(),
      description: r.line_description || '', debit: r.debit, credit: r.credit });
  });
  var items = [];
  order.forEach(function (k) {
    var g = groups[k];
    try {
      var date = validDate_(g.date);
      var desc = clean_(g.description, 500);
      if (!desc) throw new Error('гүйлгээний утга хоосон');
      var lines = normLines_(co, g.lines, post);
      if (post) { checkBalanced_(lines); assertOpen_(co.id, date); }
      items.push({ header: { date: date, description: desc, ref: clean_(g.ref, 100), cf: CF[g.cf] ? g.cf : '', source: 'IMPORT' }, lines: lines });
    } catch (e) {
      errors.push('Гүйлгээ "' + k + '" (' + g.first + '-р мөрөөс): ' + e.message);
    }
  });
  if (errors.length) return { imported: 0, errors: errors.slice(0, 100) };
  if (post) {
    var res = writePosted_(user, co, items);
    audit_(user, 'IMPORT_POST', co.id, 'import', '', res.length + ' гүйлгээ');
    return { imported: res.length, errors: [], numbers: res.map(function (x) { return x.number; }) };
  }
  var ts = now_();
  append_('Entries', items.map(function (it) {
    var t = 0; it.lines.forEach(function (l) { t += l.debit; });
    return { id: newId_(), company_id: co.id, number: '', date: it.header.date, period: it.header.date.slice(0, 7), description: it.header.description,
      ref: it.header.ref, status: 'DRAFT', source: 'IMPORT', cf: it.header.cf, reversal_of: '', reversed_by: '', total: t, post_key: '',
      draft_json: JSON.stringify(it.lines), created_by: user.username, created_at: ts, posted_by: '', posted_at: '' };
  }));
  audit_(user, 'IMPORT_DRAFT', co.id, 'import', '', items.length + ' ноорог');
  return { imported: items.length, errors: [] };
}

/* ============================================================
 * API бүртгэл
 * ============================================================ */

var API = {
  session: { perm: 'view', company: false, fn: function (u) { return sessionInfo_(u); } },
  changePassword: { perm: 'view', company: false, write: true, fn: apiChangePassword_ },
  dashboard: { perm: 'view', fn: apiDashboard_ },
  master: { perm: 'view', fn: apiMaster_ },
  saveAccount: { perm: 'masterdata', write: true, fn: apiSaveAccount_ },
  savePartner: { perm: 'masterdata', write: true, fn: apiSavePartner_ },
  saveSegment: { perm: 'masterdata', write: true, fn: apiSaveSegment_ },
  entries: { perm: 'view', fn: apiEntries_ },
  entry: { perm: 'view', fn: apiEntry_ },
  saveDraft: { perm: 'draft', write: true, fn: apiSaveDraft_ },
  postEntry: { perm: 'post', write: true, fn: apiPost_ },
  deleteDraft: { perm: 'draft', write: true, fn: apiDeleteDraft_ },
  reverse: { perm: 'reverse', write: true, fn: apiReverse_ },
  trialBalance: { perm: 'view', fn: apiTrialBalance_ },
  ledger: { perm: 'view', fn: apiLedger_ },
  balanceSheet: { perm: 'view', fn: apiBalanceSheet_ },
  incomeStatement: { perm: 'view', fn: apiIncomeStatement_ },
  cashFlow: { perm: 'view', fn: apiCashFlow_ },
  equityChanges: { perm: 'view', fn: apiEquityChanges_ },
  partnerBalances: { perm: 'view', fn: apiPartnerBalances_ },
  taxReport: { perm: 'view', fn: apiTaxReport_ },
  periods: { perm: 'view', fn: apiPeriods_ },
  closePeriod: { perm: 'period', write: true, fn: apiClosePeriod_ },
  reopenPeriod: { perm: 'period', write: true, fn: apiReopenPeriod_ },
  closeYear: { perm: 'period', write: true, fn: apiCloseYear_ },
  reopenYear: { perm: 'period', write: true, fn: apiReopenYear_ },
  saveSettings: { perm: 'settings', write: true, fn: apiSaveSettings_ },
  importEntries: { perm: 'draft', write: true, fn: apiImport_ },
  audit: { perm: 'audit', fn: apiAudit_ },
  companies: { perm: 'admin', company: false, fn: apiCompanies_ },
  saveCompany: { perm: 'admin', company: false, write: true, fn: apiSaveCompany_ },
  users: { perm: 'admin', company: false, fn: apiUsers_ },
  saveUser: { perm: 'admin', company: false, write: true, fn: apiSaveUser_ },
  resetPassword: { perm: 'admin', company: false, write: true, fn: apiResetPassword_ }
};
