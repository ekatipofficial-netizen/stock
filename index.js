// เซิร์ฟเวอร์รับ Webhook จาก LINE + อ่านรูปด้วย Claude (OCR)
// ขั้นนี้: รับรูป -> ดึงไฟล์จริงจาก LINE -> ส่งให้ Claude อ่าน -> ตอบสรุปกลับไปให้เช็ค
// ยังไม่บันทึกลง Google Sheet (ขั้นถัดไป)

const express = require('express');
const app = express();

app.use(express.json());

// ค่าลับ ดึงมาจาก Environment Variables (ตั้งใน Render) ห้ามเขียนค่าจริงในไฟล์นี้เด็ดขาด
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

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
  const prompt = `นี่คือรูปฟอร์มบันทึกสต็อกสินค้า (แบบฟอร์ม STK07) จำนวน ${images.length} รูป อาจเป็นคนละหน้าหรือครึ่งบน-ครึ่งล่างของตารางเดียวกัน ให้อ่านทีละรูปแยกจากกัน ตารางมีหัวคอลัมน์เรียงจากซ้ายไปขวาดังนี้เป๊ะๆ:
1. "หมวดหมู่" - รหัสหมวด เช่น PD09
2. "รายการสินค้า" - ชื่อสินค้า
3. "หน่วยนับ" - หน่วย เช่น ซอง, ถัง, กล่อง
4. "ยกยอดมา" - ยอดที่ยกมาจากวันก่อน
5. "+รับ" - จำนวนที่รับเข้าวันนี้
6. "รวมยอด" - ผลรวมของยกยอดมา+รับ (คอลัมน์นี้ไม่ใช่ยอดเบิกและไม่ใช่ยอดคงเหลือ ห้ามเอาตัวเลขจากคอลัมน์นี้ไปใส่ในคอลัมน์อื่น)
7. "-เบิก" - จำนวนที่เบิกออกใช้วันนี้ (อยู่ตำแหน่งที่ 7 นับจากซ้าย ก่อนคอลัมน์สุดท้าย)
8. "คงเหลือ" - ยอดคงเหลือหลังหักเบิกแล้ว (คอลัมน์ขวาสุด)

กติกาสำคัญ: ตารางนี้มีเส้นตีกรอบแบ่งแถวและคอลัมน์ชัดเจน ให้ไล่อ่านทีละแถวจากบนลงล่างอย่างเป็นระบบในแต่ละรูป ก่อนอ่านตัวเลขในแต่ละแถว ให้ระบุชื่อสินค้าของแถวนั้นก่อน แล้วค่อยลากสายตาไปทางขวาตามแนวเส้นตารางเดียวกันเพื่ออ่านตัวเลขแต่ละคอลัมน์ ห้ามข้ามไปอ่านตัวเลขจากแถวบนหรือแถวล่างเด็ดขาด นับจำนวนแถวทั้งหมดในแต่ละรูปก่อน แล้วให้แน่ใจว่าจำนวนรายการที่ตอบกลับตรงกับจำนวนแถวที่นับได้ อย่าเดาจากบริบทหรือความสมเหตุสมผลของตัวเลข ถ้าช่องไหนว่างเปล่าไม่มีตัวเลขเขียนไว้ ให้ใส่ 0 (ไม่ใช่ null) เพราะในฟอร์มนี้ช่องว่างหมายถึงไม่มีการเคลื่อนไหว

ตอบกลับเป็น JSON array เท่านั้น รวมทุกรูปไว้ใน array เดียว ไม่ต้องมีคำอธิบายอื่นใดๆ ทั้งสิ้น รูปแบบแต่ละแถว:
{"รูปที่": ลำดับรูป(เริ่มจาก1), "ลำดับ": ตัวเลขลำดับแถวในรูปนั้น, "หมวดหมู่": "...", "สินค้า": "...", "หน่วยนับ": "...", "ยกยอดมา": ตัวเลข, "รับ": ตัวเลข, "รวมยอด": ตัวเลข, "เบิก": ตัวเลข, "คงเหลือ": ตัวเลข}`;

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
      max_tokens: 8000,
      messages: [{ role: 'user', content }]
    })
  });

  const data = await res.json();
  console.log('Anthropic API raw response:', JSON.stringify(data).slice(0, 500));
  if (!data.content) {
    console.error('Anthropic API error:', JSON.stringify(data));
    throw new Error('อ่านรูปไม่สำเร็จ');
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

// ตรวจสอบสูตร: ยกยอดมา+รับ = รวมยอด และ รวมยอด-เบิก = คงเหลือ
// คืนค่า item เดิม พร้อมเพิ่ม field "ผิดปกติ" (true/false) และ "เหตุผล" (คำอธิบายสั้นๆ)
function validateItem(item) {
  const yok = Number(item['ยกยอดมา']) || 0;
  const rap = Number(item['รับ']) || 0;
  const ruam = Number(item['รวมยอด']) || 0;
  const bik = Number(item['เบิก']) || 0;
  const kong = Number(item['คงเหลือ']) || 0;

  const problems = [];
  if (yok + rap !== ruam) {
    problems.push(`ยกยอดมา(${yok})+รับ(${rap})=${yok + rap} แต่รวมยอดเขียน ${ruam}`);
  }
  if (ruam - bik !== kong) {
    problems.push(`รวมยอด(${ruam})-เบิก(${bik})=${ruam - bik} แต่คงเหลือเขียน ${kong}`);
  }

  return { ...item, ผิดปกติ: problems.length > 0, เหตุผล: problems.join(' / ') };
}

// สร้าง Flex Message แสดงรายการทั้งหมด แถวไหนสูตรไม่ตรงจะขึ้นตัวหนังสือสีแดง
// แบ่งเป็นหลายบับเบิล (การ์ด) บับเบิลละไม่เกิน 20 แถว รวมเป็น carousel เดียว
function buildValidationFlex(items) {
  const chunkSize = 20;
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }

  const bubbles = chunks.map((chunk, chunkIdx) => ({
    type: 'bubble',
    size: 'giga',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        {
          type: 'text',
          text: `รายการที่ ${chunkIdx * chunkSize + 1}-${chunkIdx * chunkSize + chunk.length}`,
          weight: 'bold',
          size: 'sm',
          color: '#888888'
        },
        { type: 'separator', margin: 'sm' },
        ...chunk.map(item => {
          const label = item['ผิดปกติ']
            ? `⚠️ ${item['ลำดับ']}. ${item['สินค้า']}`
            : `${item['ลำดับ']}. ${item['สินค้า']}`;
          const detail = `รับ:${item['รับ']} รวม:${item['รวมยอด']} เบิก:${item['เบิก']} คงเหลือ:${item['คงเหลือ']}`;
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
              text: item['เหตุผล'],
              wrap: true,
              size: 'xxs',
              color: '#FF0000'
            });
          }
          return { type: 'box', layout: 'vertical', margin: 'md', contents };
        })
      ]
    }
  }));

  const problemCount = items.filter(i => i['ผิดปกติ']).length;
  const altText = problemCount > 0
    ? `อ่านได้ ${items.length} รายการ พบ ${problemCount} รายการที่ยอดไม่ตรง กรุณาเช็ค`
    : `อ่านได้ ${items.length} รายการ ยอดตรงกันทุกแถว`;

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

    let displayText;
    try {
      const items = extractJsonArray(resultJsonText);
      const multiImage = imageEvents.length > 1;
      displayText = 'อ่านได้ดังนี้ (เช็คให้ตรงก่อนนะครับ):\n\n' +
        items.map(i => {
          const tag = multiImage ? `[รูป ${i['รูปที่']}] ` : '';
          return `${tag}${i['ลำดับ']}. ${i['สินค้า']} | รับ: ${i['รับ']} | เบิก: ${i['เบิก']} | คงเหลือ: ${i['คงเหลือ']}`;
        }).join('\n');
    } catch (e) {
      console.error('parse JSON ไม่ผ่าน:', e.message);
      displayText = 'อ่านได้ผลลัพธ์นี้ (รูปแบบไม่ตรง JSON เช็คด้วยตนเอง):\n' + resultJsonText;
    }

    await replyToLine(replyToken, displayText);
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
