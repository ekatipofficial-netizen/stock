/***************************************************************
 * ระบบจัดการสต็อกสินค้าด้วยการสแกนบาร์โค้ด — ฝั่ง Google Apps Script
 * เวอร์ชัน 2 : เพิ่มซัพพลายเออร์ + คำนวณรายการสั่งซื้ออัตโนมัติ
 *
 * ติดตั้งครั้งแรก  : รันฟังก์ชัน setupSheets
 * อัปเกรดจากเวอร์ชันเดิม (มีข้อมูลอยู่แล้ว) : รันฟังก์ชัน upgradeSheets
 *   — upgradeSheets จะไม่ลบข้อมูลเดิม เพิ่มเฉพาะคอลัมน์ใหม่และสูตร
 ***************************************************************/

/** รหัสลับ – ต้องตรงกับที่ตั้งในหน้าสแกนบนมือถือ */
var SECRET = 'CHANGE-ME-1234';

var SH_PRODUCTS = 'Products';
var SH_TRANS    = 'Transactions';
var SH_STOCK    = 'Stock';
var TZ          = 'Asia/Bangkok';

/* Products : A บาร์โค้ด | B ชื่อสินค้า | C หน่วยนับ | D ขั้นต่ำ | E สั่งเติมถึง
 *            F ขนาดบรรจุ | G ซัพพลายเออร์ | H หน่วยสั่งซื้อ
 *
 * หน่วยนับ = หน่วยที่ใช้นับสต็อกและสแกน (เช่น ชิ้น)
 * หน่วยสั่งซื้อ = หน่วยที่ใช้สั่งกับซัพพลายเออร์ (เช่น ลัง)
 * ขนาดบรรจุ = 1 หน่วยสั่งซื้อ มีกี่หน่วยนับ (เช่น 12 = ลังละ 12 ชิ้น)
 */
var P_COLS = 8;

/* =============================================================
 *  API  (เรียกผ่าน JSONP จากหน้าเว็บ — ไม่ติดปัญหา CORS)
 * ============================================================= */

function doGet(e) {
  var p = (e && e.parameter) ? e.parameter : {};
  var out;
  try {
    if (p.token !== SECRET) throw new Error('รหัสลับไม่ถูกต้อง');

    switch (p.action) {
      case 'ping':       out = { ok: true, msg: 'เชื่อมต่อสำเร็จ', sheet: SpreadsheetApp.getActive().getName(), version: 4 }; break;
      case 'products':   out = { ok: true, products: getProducts_() }; break;
      case 'lookup':     out = { ok: true, product: lookupProduct_(String(p.barcode || '').trim()) }; break;
      case 'addProduct': out = { ok: true, product: upsertProduct_(p) }; break;
      case 'save':       out = { ok: true, saved: saveTransaction_(p) }; break;
      case 'saveBatch':  out = { ok: true, saved: saveBatch_(p.items) }; break;
      case 'summary':    out = { ok: true, rows: getSummary_() }; break;
      case 'reorder':    out = { ok: true, groups: getReorder_() }; break;
      case 'recent':     out = { ok: true, rows: getRecent_(Number(p.limit || 20)) }; break;
      default: throw new Error('ไม่รู้จักคำสั่ง: ' + p.action);
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return reply_(out, p.callback);
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  return doGet({ parameter: body });
}

function reply_(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/* =============================================================
 *  ทะเบียนสินค้า
 * ============================================================= */

function sheet_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('ไม่พบชีต "' + name + '" — กรุณารัน setupSheets ก่อน');
  return sh;
}

function num_(v) { return v === '' || v === null || v === undefined ? '' : Number(v); }

/** ปัดเศษทศนิยมลอย เช่น 4/0.4 = 9.999999999999998 -> 10 */
function round_(n) { return Math.round(Number(n) * 1000) / 1000; }

function getProducts_() {
  var sh = sheet_(SH_PRODUCTS);
  if (sh.getLastRow() < 2) return [];
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, P_COLS).getValues();
  var out = [];
  for (var i = 0; i < v.length; i++) {
    var code = String(v[i][0]).trim();
    if (!code) continue;
    out.push({
      barcode:  code,
      name:     String(v[i][1]),
      unit:     String(v[i][2]),
      min:      num_(v[i][3]),
      par:      num_(v[i][4]),
      pack:     num_(v[i][5]),
      supplier: String(v[i][6] || ''),
      ounit:    String(v[i][7] || '')
    });
  }
  return out;
}

function lookupProduct_(barcode) {
  if (!barcode) return null;
  var list = getProducts_();
  for (var i = 0; i < list.length; i++) if (list[i].barcode === barcode) return list[i];
  return null;
}

/**
 * เพิ่ม/แก้ไขสินค้า — เขียนทับเฉพาะช่องที่ส่งมา (ช่องที่ไม่ส่งจะคงค่าเดิม)
 */
function upsertProduct_(p) {
  var barcode = String(p.barcode || '').trim();
  if (!barcode) throw new Error('ไม่มีบาร์โค้ด');

  var sh = sheet_(SH_PRODUCTS);
  var last = sh.getLastRow();
  var rowIdx = 0, cur = ['', '', '', '', '', '', '', ''];

  if (last >= 2) {
    var all = sh.getRange(2, 1, last - 1, P_COLS).getValues();
    for (var i = 0; i < all.length; i++) {
      if (String(all[i][0]).trim() === barcode) { rowIdx = i + 2; cur = all[i]; break; }
    }
  }

  function pick(key, curVal, isNum) {
    if (p[key] === undefined || p[key] === null) return curVal;
    var s = String(p[key]).trim();
    if (s === '') return isNum ? '' : (curVal === undefined ? '' : curVal);
    return isNum ? Number(s) : s;
  }

  var name     = pick('name', String(cur[1] || '')) || barcode;
  var unit     = pick('unit', String(cur[2] || '')) || 'ชิ้น';
  var min      = pick('min',  num_(cur[3]), true);
  var par      = pick('par',  num_(cur[4]), true);
  var pack     = pick('pack', num_(cur[5]), true);
  var supplier = pick('supplier', String(cur[6] || ''));
  var ounit    = pick('ounit', String(cur[7] || ''));

  var row = [name, unit, min, par, pack, supplier, ounit];
  if (rowIdx) sh.getRange(rowIdx, 2, 1, 7).setValues([row]);
  else        sh.appendRow([barcode].concat(row));

  return { barcode: barcode, name: name, unit: unit, min: min, par: par,
           pack: pack, supplier: supplier, ounit: ounit };
}

/* =============================================================
 *  รายการเคลื่อนไหว
 * ============================================================= */

function saveTransaction_(p) {
  var barcode = String(p.barcode || '').trim();
  if (!barcode) throw new Error('ไม่มีบาร์โค้ด');

  var type = String(p.type || '').toUpperCase();
  if (type !== 'IN' && type !== 'OUT') throw new Error('ประเภทต้องเป็น IN หรือ OUT');

  var qty = Number(p.qty || 0);
  if (!(qty > 0)) throw new Error('จำนวนต้องมากกว่า 0');

  var prod = lookupProduct_(barcode);
  if (!prod) prod = upsertProduct_({ barcode: barcode, name: p.name, unit: p.unit });

  var ts = p.ts ? new Date(Number(p.ts)) : new Date();
  sheet_(SH_TRANS).appendRow([
    ts, barcode, prod.name, type, qty, prod.unit, String(p.user || ''), String(p.note || '')
  ]);

  return {
    barcode: barcode, name: prod.name, unit: prod.unit,
    type: type, qty: qty, balance: balanceOf_(barcode),
    time: Utilities.formatDate(ts, TZ, 'dd/MM/yyyy HH:mm')
  };
}

function saveBatch_(itemsJson) {
  var items = [];
  try { items = JSON.parse(itemsJson || '[]'); } catch (e) { throw new Error('ข้อมูล batch ไม่ถูกต้อง'); }
  var results = [];
  for (var i = 0; i < items.length; i++) results.push(saveTransaction_(items[i]));
  return results;
}

function balanceOf_(barcode) {
  var sh = sheet_(SH_TRANS);
  if (sh.getLastRow() < 2) return 0;
  var v = sh.getRange(2, 2, sh.getLastRow() - 1, 4).getValues();
  var bal = 0;
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][0]).trim() !== barcode) continue;
    bal += (String(v[i][2]).toUpperCase() === 'IN' ? 1 : -1) * Number(v[i][3] || 0);
  }
  return bal;
}

/* =============================================================
 *  ยอดคงเหลือ + รายการที่ต้องสั่ง
 * ============================================================= */

function balanceMap_() {
  var trans = sheet_(SH_TRANS);
  var map = {};
  if (trans.getLastRow() < 2) return map;
  var v = trans.getRange(2, 2, trans.getLastRow() - 1, 4).getValues();
  for (var i = 0; i < v.length; i++) {
    var code = String(v[i][0]).trim();
    if (!code) continue;
    if (!map[code]) map[code] = { inQty: 0, outQty: 0 };
    var q = Number(v[i][3] || 0);
    if (String(v[i][2]).toUpperCase() === 'IN') map[code].inQty += q; else map[code].outQty += q;
  }
  return map;
}

function getSummary_() {
  var map = balanceMap_();
  var products = getProducts_();
  var rows = [];
  for (var j = 0; j < products.length; j++) {
    var pr = products[j];
    var m = map[pr.barcode] || { inQty: 0, outQty: 0 };
    var bal = m.inQty - m.outQty;
    rows.push({
      barcode: pr.barcode, name: pr.name, unit: pr.unit,
      inQty: m.inQty, outQty: m.outQty, balance: bal,
      min: pr.min, par: pr.par, pack: pr.pack, supplier: pr.supplier, ounit: pr.ounit,
      low: pr.min !== '' && bal <= Number(pr.min)
    });
  }
  rows.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  return rows;
}

/**
 * คำนวณจำนวนที่ต้องสั่ง แล้วจัดกลุ่มตามซัพพลายเออร์
 *   เงื่อนไขสั่ง : คงเหลือ <= ขั้นต่ำ
 *   จำนวนที่สั่ง : (สั่งเติมถึง − คงเหลือ) ปัดขึ้นเป็นจำนวนเต็มลัง
 *   ถ้าไม่ได้ตั้ง "สั่งเติมถึง" ระบบใช้ ขั้นต่ำ × 2
 */
function getReorder_() {
  var rows = getSummary_();
  var bySup = {};

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.min === '' ) continue;                 // ไม่ได้ตั้งขั้นต่ำ = ไม่คุมสต็อก
    if (r.balance > Number(r.min)) continue;     // ยังไม่ถึงจุดสั่ง

    var par  = r.par === '' ? Number(r.min) * 2 : Number(r.par);
    // ขนาดบรรจุรับทศนิยมได้ เช่น 2.5 (1 ก้อน = 2.5 กก.) หรือ 0.4 (1 กก. = 0.4 ก้อน)
    var pack = (r.pack === '' || !(Number(r.pack) > 0)) ? 1 : Number(r.pack);
    var need = par - r.balance;
    if (need <= 0) need = pack;                  // ถึงจุดสั่งแล้วอย่างน้อยต้องสั่ง 1 หน่วยสั่งซื้อ
    var qty = round_(Math.ceil(round_(need / pack)) * pack);

    // แปลงเป็นหน่วยสั่งซื้อ เช่น นับเป็น กก. แต่สั่งเป็น ก้อน (ก้อนละ 2.5 กก.)
    var ounit    = r.ounit || (pack !== 1 ? 'หน่วยสั่ง' : r.unit);
    var orderQty = round_(qty / pack);

    var sup = r.supplier || 'ไม่ระบุซัพพลายเออร์';
    if (!bySup[sup]) bySup[sup] = [];
    bySup[sup].push({
      barcode: r.barcode, name: r.name, unit: r.unit,
      balance: r.balance, min: r.min, par: par, pack: pack,
      qty: qty,               // จำนวนในหน่วยนับ (เช่น 36 ชิ้น)
      orderQty: orderQty,     // จำนวนในหน่วยสั่งซื้อ (เช่น 3 ลัง)
      ounit: ounit
    });
  }

  var groups = [];
  for (var sup2 in bySup) {
    bySup[sup2].sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    groups.push({ supplier: sup2, items: bySup[sup2], count: bySup[sup2].length });
  }
  groups.sort(function (a, b) { return a.supplier < b.supplier ? -1 : 1; });
  return groups;
}

function getRecent_(limit) {
  var sh = sheet_(SH_TRANS);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var n = Math.min(limit, last - 1);
  var v = sh.getRange(last - n + 1, 1, n, 8).getValues();
  var out = [];
  for (var i = v.length - 1; i >= 0; i--) {
    out.push({
      time: v[i][0] instanceof Date ? Utilities.formatDate(v[i][0], TZ, 'dd/MM HH:mm') : String(v[i][0]),
      barcode: String(v[i][1]), name: String(v[i][2]), type: String(v[i][3]),
      qty: Number(v[i][4] || 0), unit: String(v[i][5]), user: String(v[i][6])
    });
  }
  return out;
}

/* =============================================================
 *  ติดตั้ง / อัปเกรดชีต
 * ============================================================= */

var P_HEADERS = ['บาร์โค้ด', 'ชื่อสินค้า', 'หน่วยนับ', 'จำนวนขั้นต่ำ', 'สั่งเติมถึง',
                 'ขนาดบรรจุ', 'ซัพพลายเออร์', 'หน่วยสั่งซื้อ'];
var T_HEADERS = ['วันเวลา', 'บาร์โค้ด', 'ชื่อสินค้า', 'ประเภท', 'จำนวน', 'หน่วย', 'ผู้ทำรายการ', 'หมายเหตุ'];
var S_HEADERS = ['บาร์โค้ด', 'ชื่อสินค้า', 'หน่วยนับ', 'รับเข้า', 'เบิกออก', 'คงเหลือ',
                 'ขั้นต่ำ', 'สั่งเติมถึง', 'ขนาดบรรจุ', 'ซัพพลายเออร์',
                 'ต้องสั่ง', 'หน่วยสั่ง', 'คิดเป็นหน่วยนับ', 'สถานะ'];

/** ติดตั้งใหม่ทั้งหมด (ล้างข้อมูลเดิม) */
function setupSheets() {
  var ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);

  var p = ss.getSheetByName(SH_PRODUCTS) || ss.insertSheet(SH_PRODUCTS);
  p.clear();
  var t = ss.getSheetByName(SH_TRANS) || ss.insertSheet(SH_TRANS);
  t.clear();

  applyProductsFormat_(p);
  applyTransFormat_(t);
  buildStock_(ss);

  // ใช้ toast แทน alert — alert จะไปเด้งที่หน้า Sheet แล้วสคริปต์จะค้างรอจนหมดเวลา
  say_(ss, 'ติดตั้งเรียบร้อย — สร้างชีต Products / Transactions / Stock แล้ว');
}

/** แจ้งผลแบบไม่บล็อกการทำงาน */
function say_(ss, msg) {
  Logger.log(msg);
  try { ss.toast(msg, '📦 ระบบสต็อก', 12); } catch (e) {}
}

/** อัปเกรดจากเวอร์ชันเดิมโดยไม่ลบข้อมูล */
function upgradeSheets() {
  var ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);

  // ลบชีต Stock ทิ้งก่อนเป็นอย่างแรก — สูตรเวอร์ชันเก่ากินเวลาคำนวณมหาศาล
  // ถ้าปล่อยไว้ ทุกคำสั่งหลังจากนี้จะรอการคำนวณจนสคริปต์หมดเวลา
  dropStock();

  var p = ss.getSheetByName(SH_PRODUCTS);
  if (!p) { setupSheets(); return; }
  applyProductsFormat_(p);

  var t = ss.getSheetByName(SH_TRANS) || ss.insertSheet(SH_TRANS);
  if (t.getLastRow() === 0) applyTransFormat_(t);
  else t.getRange(1, 1, 1, T_HEADERS.length).setValues([T_HEADERS])
        .setFontWeight('bold').setBackground('#188038').setFontColor('#ffffff');

  buildStock_(ss);

  say_(ss, 'อัปเกรดเรียบร้อย — ข้อมูลเดิมอยู่ครบ · เพิ่มคอลัมน์ "หน่วยสั่งซื้อ" ในชีต Products · ขั้นต่อไป: Deploy เวอร์ชันใหม่');
}

/* =============================================================
 *  เครื่องมือกรอกสินค้าทีละหลายรายการ
 * ============================================================= */

var CODE_PREFIX = 'SKU';   // รูปแบบรหัสที่สร้างให้ เช่น SKU0001

/**
 * สร้างรหัสสินค้าให้แถวที่มีชื่อสินค้าแต่ยังไม่มีรหัส
 * ใช้หลังจากวางรายการสินค้าใหม่ลงชีต Products แล้วเว้นคอลัมน์ A ว่างไว้
 */
function generateCodes() {
  var ss = SpreadsheetApp.getActive();
  var sh = sheet_(SH_PRODUCTS);
  var last = sh.getLastRow();
  if (last < 2) { say_(ss, 'ยังไม่มีรายการสินค้าในชีต Products'); return; }

  var rng = sh.getRange(2, 1, last - 1, 2);
  var v = rng.getValues();

  var used = {}, maxN = 0;
  var re = new RegExp('^' + CODE_PREFIX + '(\\d+)$');
  for (var i = 0; i < v.length; i++) {
    var c = String(v[i][0]).trim();
    if (!c) continue;
    used[c] = true;
    var m = c.match(re);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }

  var made = 0;
  for (var j = 0; j < v.length; j++) {
    if (String(v[j][0]).trim()) continue;         // มีรหัสอยู่แล้ว
    if (!String(v[j][1]).trim()) continue;        // ไม่มีชื่อสินค้า = แถวว่าง
    var code;
    do {
      maxN++;
      code = CODE_PREFIX + ('0000' + maxN).slice(-4);
    } while (used[code]);
    used[code] = true;
    v[j][0] = code;
    made++;
  }

  if (made) {
    sh.getRange('A:A').setNumberFormat('@');
    rng.setValues(v);
  }
  say_(ss, made ? '✓ สร้างรหัสให้ ' + made + ' รายการแล้ว — ขั้นต่อไปไปพิมพ์สติกเกอร์ QR'
                : 'ทุกรายการมีรหัสอยู่แล้ว ไม่มีอะไรต้องสร้าง');
}

/** ตรวจหารหัสสินค้าซ้ำ — รหัสซ้ำจะทำให้สแกนแล้วได้สินค้าผิดตัว */
function checkDuplicates() {
  var ss = SpreadsheetApp.getActive();
  var sh = sheet_(SH_PRODUCTS);
  if (sh.getLastRow() < 2) { say_(ss, 'ยังไม่มีรายการสินค้า'); return; }

  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  var seen = {}, dup = [];
  for (var i = 0; i < v.length; i++) {
    var c = String(v[i][0]).trim();
    if (!c) continue;
    if (seen[c]) dup.push(c + ' (แถว ' + seen[c] + ' และ ' + (i + 2) + ')');
    else seen[c] = i + 2;
  }
  var msg = dup.length ? '⚠️ พบรหัสซ้ำ ' + dup.length + ' รายการ: ' + dup.slice(0, 5).join(' · ')
                       : '✓ ไม่มีรหัสซ้ำ';
  Logger.log(dup.join('\n'));
  say_(ss, msg);
}

/** ลบชีต Stock ทิ้ง (ใช้แก้อาการสคริปต์ค้าง / Exceeded maximum execution time) */
function dropStock() {
  var ss = SpreadsheetApp.getActive();
  var s = ss.getSheetByName(SH_STOCK);
  if (!s) return;
  if (ss.getSheets().length < 2) ss.insertSheet('temp');
  ss.deleteSheet(s);
  SpreadsheetApp.flush();
}

function applyProductsFormat_(p) {
  p.getRange(1, 1, 1, P_HEADERS.length).setValues([P_HEADERS])
    .setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');
  p.setFrozenRows(1);
  p.getRange('A:A').setNumberFormat('@');
  p.setColumnWidth(1, 160); p.setColumnWidth(2, 260); p.setColumnWidth(3, 80);
  p.setColumnWidth(4, 110); p.setColumnWidth(5, 110); p.setColumnWidth(6, 110);
  p.setColumnWidth(7, 170); p.setColumnWidth(8, 120);

  var notes = [[
    'รหัสบนสติกเกอร์ (บาร์โค้ดหรือ QR)',
    'ชื่อที่จะขึ้นตอนสแกน',
    'หน่วยที่ใช้นับสต็อกและสแกน เช่น ชิ้น ขวด แผ่น',
    'ต่ำกว่าหรือเท่านี้ = ถึงจุดสั่งซื้อ (นับเป็นหน่วยนับ)',
    'สั่งให้เต็มถึงระดับนี้ (นับเป็นหน่วยนับ · เว้นว่าง = ใช้ขั้นต่ำ × 2)',
    '1 หน่วยสั่งซื้อ = กี่หน่วยนับ · ใส่ทศนิยมได้ เช่น 12 (ลังละ 12 ชิ้น) หรือ 2.5 (ก้อนละ 2.5 กก.) · เว้นว่าง = สั่งเป็นหน่วยนับ',
    'ชื่อร้าน/ซัพพลายเออร์ — ใช้แยกใบสั่งซื้อ',
    'หน่วยที่ใช้สั่งกับซัพ เช่น ลัง โหล ก้อน (ใช้คู่กับขนาดบรรจุ)'
  ]];
  p.getRange(1, 1, 1, P_HEADERS.length).setNotes(notes);
}

function applyTransFormat_(t) {
  t.getRange(1, 1, 1, T_HEADERS.length).setValues([T_HEADERS])
    .setFontWeight('bold').setBackground('#188038').setFontColor('#ffffff');
  t.setFrozenRows(1);
  t.getRange('A:A').setNumberFormat('dd/mm/yyyy hh:mm:ss');
  t.getRange('B:B').setNumberFormat('@');
  t.setColumnWidth(1, 150); t.setColumnWidth(2, 160); t.setColumnWidth(3, 260);

  t.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('IN')
      .setBackground('#e6f4ea').setFontColor('#137333')
      .setRanges([t.getRange('D2:D')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('OUT')
      .setBackground('#fce8e6').setFontColor('#c5221f')
      .setRanges([t.getRange('D2:D')]).build()
  ]);
}

/* ขอบเขตสูตร — จำกัดจำนวนแถวเพื่อไม่ให้ Google Sheet คำนวณช้าจนสคริปต์หมดเวลา
 * MAX_P = จำนวนสินค้าสูงสุด, MAX_T = จำนวนรายการเคลื่อนไหวสูงสุด
 * ถ้าข้อมูลใกล้เต็ม ให้เพิ่มตัวเลขแล้วรัน upgradeSheets ใหม่ */
var MAX_P = 2000;
var MAX_T = 100000;

function buildStock_(ss) {
  // ลบชีตเดิมทิ้งก่อน เพื่อไม่ให้สูตรหนักของเวอร์ชันเก่าถูกคำนวณซ้ำระหว่างอัปเกรด
  var old = ss.getSheetByName(SH_STOCK);
  if (old) ss.deleteSheet(old);
  var s = ss.insertSheet(SH_STOCK);

  s.getRange(1, 1, 1, S_HEADERS.length).setValues([S_HEADERS])
    .setFontWeight('bold').setBackground('#e37400').setFontColor('#ffffff');
  s.setFrozenRows(1);

  var P = SH_PRODUCTS, T = SH_TRANS;
  var A = 'A2:A' + MAX_P;
  var PR = P + '!A2:H' + MAX_P;

  var lk = function (col) {
    return '=ARRAYFORMULA(IF(' + A + '="","",IFERROR(VLOOKUP(' + A + ',' + PR + ',' + col + ',FALSE),"")))';
  };
  var C = 'C2:C' + MAX_P;

  // รวมยอดด้วย QUERY ครั้งเดียว แล้วค่อย VLOOKUP — เร็วกว่า SUMIFS รายแถวมาก
  var sumBy = function (type) {
    return 'QUERY(' + T + '!B2:E' + MAX_T +
           ',"select Col1, sum(Col4) where Col3=\'' + type + '\' group by Col1 label sum(Col4) \'\'",0)';
  };
  var totals = function (type) {
    return '=ARRAYFORMULA(IF(' + A + '="","",IFERROR(VLOOKUP(' + A + ',' + sumBy(type) + ',2,FALSE),0)))';
  };

  s.getRange('A2').setFormula('=IFERROR(FILTER(' + P + '!A2:A' + MAX_P + ',' + P + '!A2:A' + MAX_P + '<>""),"")');
  s.getRange('B2').setFormula(lk(2));
  s.getRange('C2').setFormula(lk(3));
  s.getRange('D2').setFormula(totals('IN'));
  s.getRange('E2').setFormula(totals('OUT'));
  s.getRange('F2').setFormula('=ARRAYFORMULA(IF(' + A + '="","",D2:D' + MAX_P + '-E2:E' + MAX_P + '))');
  s.getRange('G2').setFormula(lk(4));   // ขั้นต่ำ
  s.getRange('H2').setFormula(lk(5));   // สั่งเติมถึง
  s.getRange('I2').setFormula(lk(6));   // ขนาดบรรจุ
  s.getRange('J2').setFormula(lk(7));   // ซัพพลายเออร์

  var G = 'G2:G' + MAX_P, H = 'H2:H' + MAX_P, I = 'I2:I' + MAX_P, F = 'F2:F' + MAX_P;
  var par  = 'IF(' + H + '="",' + G + '*2,' + H + ')';
  // ขนาดบรรจุรับทศนิยม เช่น 2.5 หรือ 0.4
  var pack = 'IF(N(' + I + ')>0,' + I + ',1)';
  // จำนวนที่ต้องสั่ง คิดเป็นหน่วยนับ แล้วปัดขึ้นเป็นจำนวนเต็มหน่วยสั่งซื้อ
  var qtyStock =
    'IF(' + F + '>' + G + ',0,' +
      'ROUND(CEILING(ROUND(IF(' + par + '-' + F + '<=0,' + pack + ',' + par + '-' + F + ')/' +
        pack + ',6))*' + pack + ',3))';
  var ou = 'IFERROR(VLOOKUP(' + A + ',' + PR + ',8,FALSE),"")';

  // K = ต้องสั่ง (หน่วยสั่งซื้อ)
  s.getRange('K2').setFormula(
    '=ARRAYFORMULA(IF(' + A + '="","",IF(' + G + '="","",ROUND((' + qtyStock + ')/' + pack + ',3))))');

  // L = ชื่อหน่วยสั่งซื้อ
  s.getRange('L2').setFormula(
    '=ARRAYFORMULA(IF(' + A + '="","",IF(' + ou + '<>"",' + ou + ',' + C + ')))');

  // M = คิดเป็นหน่วยนับ
  s.getRange('M2').setFormula(
    '=ARRAYFORMULA(IF(' + A + '="","",IF(' + G + '="","",' + qtyStock + ')))');

  s.getRange('N2').setFormula(
    '=ARRAYFORMULA(IF(' + A + '="","",IF(' + G + '="","",IF(' + F + '<=' + G + ',"⚠️ ต้องสั่งเพิ่ม","ปกติ"))))');

  s.getRange('A:A').setNumberFormat('@');
  s.setColumnWidth(1, 150); s.setColumnWidth(2, 240); s.setColumnWidth(10, 170);
  s.setColumnWidth(13, 130); s.setColumnWidth(14, 150);

  s.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextContains('ต้องสั่ง')
      .setBackground('#fce8e6').setFontColor('#c5221f')
      .setRanges([s.getRange(2, 1, MAX_P - 1, S_HEADERS.length)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0)
      .setBackground('#fff4e5').setFontColor('#b45309').setBold(true)
      .setRanges([s.getRange(2, 11, MAX_P - 1, 1)]).build()
  ]);
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📦 ระบบสต็อก')
    .addItem('🔢 สร้างรหัสสินค้าอัตโนมัติ', 'generateCodes')
    .addItem('🔍 ตรวจหารหัสซ้ำ', 'checkDuplicates')
    .addSeparator()
    .addItem('อัปเกรดชีต (ไม่ลบข้อมูล)', 'upgradeSheets')
    .addItem('ลบชีต Stock (แก้อาการค้าง)', 'dropStock')
    .addSeparator()
    .addItem('ติดตั้งใหม่ทั้งหมด (ล้างข้อมูล)', 'setupSheets')
    .addToUi();
}
