// เซิร์ฟเวอร์รับ Webhook จาก LINE + อ่านรูปด้วย Claude (OCR)
// ขั้นนี้: รับรูป -> ดึงไฟล์จริงจาก LINE -> ส่งให้ Claude อ่าน -> ตอบสรุปกลับไปให้เช็ค
// ยังไม่บันทึกลง Google Sheet (ขั้นถัดไป)

const express = require('express');
const app = express();

app.use(express.json());

// ค่าลับ ดึงมาจาก Environment Variables (ตั้งใน Render) ห้ามเขียนค่าจริงในไฟล์นี้เด็ดขาด
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// เชื่อมต่อ Google Sheets ด้วย Service Account
const { google } = require('googleapis');
let sheetsClient = null;
function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

// ดึงชื่อชีตจริงจากไฟล์ (กันปัญหาชื่อชีตไม่ตรงเป๊ะกับที่ hardcode ไว้ เช่น เคสตัวพิมพ์ใหญ่เล็ก/ช่องว่าง)
let cachedTitles = null;
async function resolveSheetTitles() {
  if (cachedTitles) return cachedTitles;
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets.properties.title'
  });
  const titles = meta.data.sheets.map(s => s.properties.title);
  const find = (needle) => titles.find(t => t.trim().toLowerCase() === needle.toLowerCase());

  const movementLogTitle = find('Movement Log');
  const masterTitle = find('Master');
  if (!movementLogTitle) {
    throw new Error(`ไม่พบชีตชื่อ "Movement Log" ในไฟล์ Google Sheet (ชีตที่มีอยู่จริง: ${titles.join(', ')})`);
  }
  if (!masterTitle) {
    throw new Error(`ไม่พบชีตชื่อ "Master" ในไฟล์ Google Sheet (ชีตที่มีอยู่จริง: ${titles.join(', ')})`);
  }
  cachedTitles = { movementLogTitle, masterTitle };
  console.log('พบชื่อชีตจริง:', JSON.stringify(cachedTitles));
  return cachedTitles;
}

// ใส่เครื่องหมายคำพูดครอบชื่อชีตเสมอ (กันกรณีชื่อมีช่องว่างหรืออักขระพิเศษ)
function quoteSheetName(name) {
  return `'${name.replace(/'/g, "''")}'`;
}
async function appendMovementLog(items) {
  const sheets = getSheetsClient();
  const { movementLogTitle } = await resolveSheetTitles();
  const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  const rows = items.map(i => [
    now, i['stk'] || '', i['หมวดหมู่'] || '', i['สินค้า'] || '', i['หน่วยนับ'] || '',
    i['ยกยอดมา'], i['รับ'], i['เบิก'], i['คงเหลือ'], i['เหตุผล'] || ''
  ]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${quoteSheetName(movementLogTitle)}!A:J`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows }
  });
}

// อัปเดตคอลัมน์ "คงเหลือปัจจุบัน" (คอลัมน์ G) ในชีต Master ให้ตรงกับยอดล่าสุดของวันนี้
// จับคู่ด้วยชื่อสินค้า (คอลัมน์ B) ถ้าหาไม่เจอในชีต Master จะข้ามและแจ้งใน log
async function updateMasterCurrentStock(items) {
  const sheets = getSheetsClient();
  const { masterTitle } = await resolveSheetTitles();

  // ดึงรายชื่อสินค้าทั้งหมดในชีต Master มาก่อน เพื่อหาว่าแต่ละชื่ออยู่แถวไหน
  const masterData = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${quoteSheetName(masterTitle)}!A:H`
  });
  const rows = masterData.data.values || [];
  const nameToRow = {}; // ชื่อสินค้า -> เลขแถว (1-indexed ตรงกับ Google Sheet)
  rows.forEach((row, idx) => {
    if (idx === 0) return; // ข้ามหัวตาราง
    const name = (row[1] || '').trim();
    if (name) nameToRow[name] = idx + 1;
  });

  const updates = [];
  const unmatched = [];
  for (const item of items) {
    const name = (item['สินค้า'] || '').trim();
    const rowNum = nameToRow[name];
    if (rowNum) {
      updates.push({ range: `${quoteSheetName(masterTitle)}!G${rowNum}`, values: [[item['คงเหลือ']]] });
    } else {
      unmatched.push(name);
    }
  }

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: updates }
    });
  }
  if (unmatched.length > 0) {
    console.warn('⚠️ ไม่พบสินค้าเหล่านี้ในชีต Master (ไม่ได้อัปเดตยอด):', unmatched.join(', '));
  }
  return { updatedCount: updates.length, unmatched };
}

// ดึงไฟล์รูปจริงจากเซิร์ฟเวอร์ LINE โดยใช้ messageId
async function getLineImage(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_TOKEN}` }
  });
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  const mediaType = res.headers.get('content-type') || 'image/jpeg';
  return { base64, mediaType };
}

// ส่งรูปให้ Claude อ่านตัวหนังสือ แล้วแปลงเป็นข้อมูลสต็อก
// รับได้หลายรูปพร้อมกัน (images = array ของ {base64, mediaType})
async function readStockImages(images) {
  const prompt = `นี่คือรูปฟอร์มบันทึกสต็อกสินค้า (แบบฟอร์ม STK) จำนวน ${images.length} รูป แต่ละรูปมีรหัสฟอร์มเขียนกำกับไว้มุมขวาบน (เช่น STK01, STK02, ... STK07) ให้อ่านรหัสนี้ของแต่ละรูปด้วย แล้วใส่กำกับไว้ในทุกแถวที่มาจากรูปนั้น ตารางมีหัวคอลัมน์เรียงจากซ้ายไปขวา แต่ให้อ่านเก็บข้อมูลเฉพาะ 4 คอลัมน์ตัวเลขนี้เท่านั้น:
1. "ยกยอดมา" - ยอดที่ยกมาจากวันก่อน
2. "+รับ" - จำนวนที่รับเข้าวันนี้
3. "-เบิก" - จำนวนที่เบิกออกใช้วันนี้
4. "คงเหลือ" - ยอดคงเหลือหลังหักเบิกแล้ว (คอลัมน์ขวาสุด)
(ข้ามคอลัมน์ "รวมยอด" ไม่ต้องอ่าน)

กติกาสำคัญ: ตารางนี้มีเส้นตีกรอบแบ่งแถวและคอลัมน์ชัดเจน ให้ไล่อ่านทีละแถวจากบนลงล่างอย่างเป็นระบบในแต่ละรูป ก่อนอ่านตัวเลขในแต่ละแถว ให้ระบุชื่อสินค้าของแถวนั้นก่อน แล้วค่อยลากสายตาไปทางขวาตามแนวเส้นตารางเดียวกันเพื่ออ่านตัวเลขแต่ละคอลัมน์ ห้ามข้ามไปอ่านตัวเลขจากแถวบนหรือแถวล่างเด็ดขาด นับจำนวนแถวทั้งหมดในแต่ละรูปก่อน แล้วให้แน่ใจว่าจำนวนรายการที่ตอบกลับตรงกับจำนวนแถวที่นับได้ อย่าเดาจากบริบทหรือความสมเหตุสมผลของตัวเลข

สำหรับคอลัมน์ "ยกยอดมา", "รับ", "คงเหลือ": ถ้าช่องว่างเปล่าไม่มีตัวเลขเขียนไว้ ให้ใส่ 0
สำหรับคอลัมน์ "เบิก" เท่านั้น: ต้องแยกแยะให้ชัดระหว่างช่องที่ไม่มีลายมือเขียนอะไรเลย (ว่างจริง) กับช่องที่เขียนเลข 0 ไว้ ถ้าไม่มีลายมือเขียนอะไรในช่องเบิกเลย ให้ใส่ค่า null (ห้ามใส่ 0 แทน) ถ้ามีคนเขียนตัวเลขไว้จริง (รวมถึงเลข 0) ให้ใส่ตัวเลขนั้นตามที่เขียนจริง

ตอบกลับเป็น JSON array เท่านั้น รวมทุกรูปไว้ใน array เดียว ไม่ต้องมีคำอธิบายอื่นใดๆ ทั้งสิ้น รูปแบบแต่ละแถว:
{"stk": "รหัสฟอร์มเช่น STK04", "รูปที่": ลำดับรูป(เริ่มจาก1), "ลำดับ": ตัวเลขลำดับแถวในรูปนั้น, "หมวดหมู่": "...", "สินค้า": "...", "หน่วยนับ": "...", "ยกยอดมา": ตัวเลข, "รับ": ตัวเลข, "เบิก": ตัวเลขหรือnull, "คงเหลือ": ตัวเลข}`;

  const content = [];
  images.forEach((img, idx) => {
    content.push({ type: 'text', text: `รูปที่ ${idx + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
  });
  content.push({ type: 'text', text: prompt });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 16000,
      messages: [{ role: 'user', content }]
    })
  });

  const data = await res.json();
  console.log('stop_reason:', data.stop_reason, '| usage:', JSON.stringify(data.usage));
  console.log('Anthropic API raw response:', JSON.stringify(data).slice(0, 500));
  if (!data.content) {
    console.error('Anthropic API error:', JSON.stringify(data));
    throw new Error('อ่านรูปไม่สำเร็จ');
  }
  if (data.stop_reason === 'max_tokens') {
    console.warn('⚠️ คำตอบถูกตัดเพราะเกิน max_tokens คำตอบอาจไม่สมบูรณ์');
  }
  return data.content.map(b => b.text || '').join('');
}

// ตัดส่วนที่ไม่ใช่ JSON ออก เผื่อ Claude ห่อด้วย ```json ... ``` หรือมีข้อความอื่นปนมา
function extractJsonArray(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('ไม่พบ JSON array ในคำตอบ');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// แสดงตัวเลข: ถ้าเป็นจำนวนเต็มคงเดิม ถ้ามีทศนิยมให้ปัดเหลือ 2 ตำแหน่ง
function fmtNum(n) {
  const num = Number(n);
  if (isNaN(num)) return n;
  return Number.isInteger(num) ? String(num) : num.toFixed(2);
}

// เช็คและปรับปรุงค่า "เบิก" จาก 3 ค่าที่ยึดตามกระดาษ (ห้ามแก้): ยกยอดมา, รับ, คงเหลือ
// สูตร: ยกยอดมา + รับ - เบิก = คงเหลือ  =>  เบิกที่ถูกต้อง = ยกยอดมา + รับ - คงเหลือ
function reconcileItem(item) {
  const yok = Number(item['ยกยอดมา']) || 0;
  const rap = Number(item['รับ']) || 0;
  const kong = Number(item['คงเหลือ']) || 0;
  const correctBik = yok + rap - kong;

  const writtenBik = item['เบิก']; // null = ช่องว่างจริง, ตัวเลข = มีคนเขียนไว้
  const wasBlank = writtenBik === null || writtenBik === undefined;
  const mismatch = !wasBlank && Number(writtenBik) !== correctBik;

  let เหตุผล = '';
  if (wasBlank) {
    เหตุผล = `ช่องเบิกว่าง คำนวณให้จาก ${fmtNum(yok)}+${fmtNum(rap)}-${fmtNum(kong)} = ${fmtNum(correctBik)}`;
  } else if (mismatch) {
    เหตุผล = `เบิกเดิมเขียน ${fmtNum(writtenBik)} แต่คำนวณจาก ${fmtNum(yok)}+${fmtNum(rap)}-${fmtNum(kong)} ได้ ${fmtNum(correctBik)} (แก้ไขแล้ว)`;
  }

  return {
    ...item,
    เบิก: wasBlank || mismatch ? correctBik : Number(writtenBik),
    ผิดปกติ: mismatch,      // สีแดง: มีคนเขียนไว้แต่ผิด ต้องแก้
    autoFilled: wasBlank,   // ช่องว่าง ไม่ถือว่าผิด แค่กรอกให้
    เหตุผล
  };
}

// สร้าง Flex Message แสดงรายการทั้งหมด แถวไหนสูตรไม่ตรงจะขึ้นตัวหนังสือสีแดง
// แบ่งเป็นหลายบับเบิล (การ์ด) บับเบิลละไม่เกิน 20 แถว รวมเป็น carousel เดียว
function buildValidationFlex(items, saveResult = {}) {
  // เรียงตามรหัสฟอร์ม STK01 -> STK07 (ดึงตัวเลขจากรหัสมาเทียบ) แล้วตามด้วยลำดับแถวเดิมในฟอร์มนั้น
  const stkNum = (stk) => {
    const m = String(stk || '').match(/\d+/);
    return m ? parseInt(m[0], 10) : 999;
  };
  const sorted = [...items].sort((a, b) => {
    const diff = stkNum(a['stk']) - stkNum(b['stk']);
    if (diff !== 0) return diff;
    return (Number(a['ลำดับ']) || 0) - (Number(b['ลำดับ']) || 0);
  });

  // แบ่งเป็นการ์ด: ขึ้นการ์ดใหม่ทุกครั้งที่เปลี่ยน STK หรือครบ chunkSize
  const chunkSize = 20;
  const chunks = [];
  let current = [];
  let currentStk = null;
  for (const item of sorted) {
    if (current.length === 0) currentStk = item['stk'];
    if (item['stk'] !== currentStk || current.length >= chunkSize) {
      chunks.push(current);
      current = [];
      currentStk = item['stk'];
    }
    current.push(item);
  }
  if (current.length > 0) chunks.push(current);

  const bubbles = chunks.map((chunk) => ({
    type: 'bubble',
    size: 'giga',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        {
          type: 'text',
          text: `${chunk[0]['stk'] || 'ไม่ทราบฟอร์ม'} (${chunk.length} รายการ)`,
          weight: 'bold',
          size: 'sm',
          color: '#888888'
        },
        { type: 'separator', margin: 'sm' },
        ...chunk.map(item => {
          const label = item['ผิดปกติ']
            ? `⚠️ ${item['ลำดับ']}. ${item['สินค้า']}`
            : `${item['ลำดับ']}. ${item['สินค้า']}`;
          const detail = `ยกมา:${fmtNum(item['ยกยอดมา'])}  รับ:${fmtNum(item['รับ'])}  เบิก:${fmtNum(item['เบิก'])}  คงเหลือ:${fmtNum(item['คงเหลือ'])}`;
          const contents = [
            {
              type: 'text',
              text: label,
              wrap: true,
              size: 'sm',
              weight: 'bold',
              color: item['ผิดปกติ'] ? '#FF0000' : '#111111'
            },
            {
              type: 'text',
              text: detail,
              wrap: true,
              size: 'xs',
              color: item['ผิดปกติ'] ? '#FF0000' : '#666666'
            }
          ];
          if (item['ผิดปกติ']) {
            contents.push({
              type: 'text',
              text: '⚠️ ' + item['เหตุผล'],
              wrap: true,
              size: 'xxs',
              color: '#FF0000'
            });
          } else if (item['autoFilled']) {
            contents.push({
              type: 'text',
              text: '📝 ' + item['เหตุผล'],
              wrap: true,
              size: 'xxs',
              color: '#1E7FD9'
            });
          }
          return { type: 'box', layout: 'vertical', margin: 'md', contents };
        })
      ]
    }
  }));

  const problemCount = items.filter(i => i['ผิดปกติ']).length;
  const filledCount = items.filter(i => i['autoFilled']).length;
  const parts = [`อ่านได้ ${items.length} รายการ`];
  if (problemCount > 0) parts.push(`พบ ${problemCount} รายการยอดผิด (แก้ไขให้แล้ว)`);
  if (filledCount > 0) parts.push(`กรอกช่องเบิกที่ว่างให้ ${filledCount} รายการ`);
  if (problemCount === 0 && filledCount === 0) parts.push('ถูกต้องตรงกันทุกแถว');
  if (saveResult.updatedCount !== undefined) parts.push(`บันทึกลง Sheet แล้ว ${saveResult.updatedCount} รายการ`);
  if (saveResult.unmatched && saveResult.unmatched.length > 0) parts.push(`หาไม่เจอในระบบ ${saveResult.unmatched.length} รายการ`);
  const altText = parts.join(' | ');

  return {
    type: 'flex',
    altText,
    contents: { type: 'carousel', contents: bubbles }
  };
}

// ส่งข้อความกลับไปใน LINE รองรับทั้งข้อความธรรมดาและ Flex Message
async function replyToLine(replyToken, message) {
  const messages = typeof message === 'string' ? [{ type: 'text', text: message }] : [message];
  const lineRes = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_TOKEN}`
    },
    body: JSON.stringify({ replyToken, messages })
  });
  if (!lineRes.ok) {
    console.error('LINE reply error:', await lineRes.text());
  }
}

app.post('/webhook', async (req, res) => {
  // ตอบ LINE ก่อนทันที ไม่งั้นถ้าประมวลผลนาน LINE จะคิดว่า error
  res.status(200).send('OK');

  const events = req.body.events || [];
  const imageEvents = events.filter(e => e.type === 'message' && e.message.type === 'image');
  if (imageEvents.length === 0) return;

  // ใช้ replyToken ของรูปสุดท้ายในชุดนี้ ส่งข้อความสรุปกลับไปครั้งเดียว
  const replyToken = imageEvents[imageEvents.length - 1].replyToken;

  try {
    console.log(`กำลังดึงรูปทั้งหมด ${imageEvents.length} รูป...`);
    const images = [];
    for (const event of imageEvents) {
      images.push(await getLineImage(event.message.id));
    }

    console.log('กำลังส่งให้ AI อ่านพร้อมกัน...');
    const resultJsonText = await readStockImages(images);
    console.log('ผลลัพธ์:', resultJsonText);

    let replyMessage;
    try {
      const items = extractJsonArray(resultJsonText).map(reconcileItem);

      console.log('กำลังบันทึกลง Google Sheet...');
      await appendMovementLog(items);
      const { updatedCount, unmatched } = await updateMasterCurrentStock(items);
      console.log(`บันทึกสำเร็จ: อัปเดตยอดคงเหลือ ${updatedCount} รายการ, หาไม่เจอ ${unmatched.length} รายการ`);

      replyMessage = buildValidationFlex(items, { updatedCount, unmatched });
    } catch (e) {
      console.error('parse JSON หรือบันทึก Sheet ไม่ผ่าน:', e.message);
      const raw = 'บันทึกลง Sheet ไม่สำเร็จ: ' + e.message + '\n\nข้อมูลที่อ่านได้ (ตัดบางส่วน):\n' + resultJsonText;
      replyMessage = raw.length > 4900 ? raw.slice(0, 4900) + '\n...(ตัดเพราะยาวเกิน)' : raw;
    }

    await replyToLine(replyToken, replyMessage);
  } catch (err) {
    console.error('เกิดข้อผิดพลาด:', err.message);
    await replyToLine(replyToken, 'ขออภัย อ่านรูปไม่สำเร็จ ลองถ่ายใหม่อีกครั้งครับ');
  }
});

app.get('/', (req, res) => {
  res.send('LINE Stock Bot server is running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
