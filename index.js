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
async function readStockImage(base64, mediaType) {
  const prompt = `นี่คือรูปฟอร์มบันทึกสต็อกสินค้า (แบบฟอร์ม STK07) ตารางมีหัวคอลัมน์เรียงจากซ้ายไปขวาดังนี้เป๊ะๆ:
1. "หมวดหมู่" - รหัสหมวด เช่น PD09
2. "รายการสินค้า" - ชื่อสินค้า
3. "หน่วยนับ" - หน่วย เช่น ซอง, ถัง, กล่อง
4. "ยกยอดมา" - ยอดที่ยกมาจากวันก่อน
5. "+รับ" - จำนวนที่รับเข้าวันนี้
6. "รวมยอด" - ผลรวมของยกยอดมา+รับ (คอลัมน์นี้ไม่ใช่ยอดเบิกและไม่ใช่ยอดคงเหลือ ห้ามเอาตัวเลขจากคอลัมน์นี้ไปใส่ในคอลัมน์อื่น)
7. "-เบิก" - จำนวนที่เบิกออกใช้วันนี้ (อยู่ตำแหน่งที่ 7 นับจากซ้าย ก่อนคอลัมน์สุดท้าย)
8. "คงเหลือ" - ยอดคงเหลือหลังหักเบิกแล้ว (คอลัมน์ขวาสุด)

กติกาสำคัญ: อ่านตัวเลขแต่ละแถวโดยยึดตำแหน่งคอลัมน์เป็นหลัก นับตำแหน่งคอลัมน์จากซ้ายไปขวาให้ตรงทุกแถว อย่าเดาจากบริบทหรือความสมเหตุสมผลของตัวเลข ถ้าช่องไหนว่างเปล่าไม่มีตัวเลขเขียนไว้ ให้ใส่ 0 (ไม่ใช่ null) เพราะในฟอร์มนี้ช่องว่างหมายถึงไม่มีการเคลื่อนไหว

ตอบกลับเป็น JSON array เท่านั้น ไม่ต้องมีคำอธิบายอื่นใดๆ ทั้งสิ้น รูปแบบแต่ละแถว:
{"หมวดหมู่": "...", "สินค้า": "...", "หน่วยนับ": "...", "ยกยอดมา": ตัวเลข, "รับ": ตัวเลข, "เบิก": ตัวเลข, "คงเหลือ": ตัวเลข}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      thinking: { type: 'disabled' },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: prompt }
        ]
      }]
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

// ตอบข้อความกลับไปใน LINE
async function replyToLine(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_TOKEN}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }]
    })
  });
}

app.post('/webhook', async (req, res) => {
  // ตอบ LINE ก่อนทันที ไม่งั้นถ้าประมวลผลนาน LINE จะคิดว่า error
  res.status(200).send('OK');

  const events = req.body.events || [];
  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'image') {
      try {
        console.log('กำลังดึงรูป messageId:', event.message.id);
        const { base64, mediaType } = await getLineImage(event.message.id);

        console.log('กำลังส่งให้ AI อ่าน...');
        const resultJsonText = await readStockImage(base64, mediaType);
        console.log('ผลลัพธ์:', resultJsonText);

        // แปลงเป็นข้อความอ่านง่าย ส่งกลับให้พนักงานเช็ค
        let displayText;
        try {
          const items = extractJsonArray(resultJsonText);
          displayText = 'อ่านได้ดังนี้ (เช็คให้ตรงก่อนนะครับ):\n\n' +
            items.map(i => `- ${i['สินค้า']} | รับ: ${i['รับ']} | เบิก: ${i['เบิก']} | คงเหลือ: ${i['คงเหลือ']}`).join('\n');
        } catch (e) {
          console.error('parse JSON ไม่ผ่าน:', e.message);
          displayText = 'อ่านได้ผลลัพธ์นี้ (รูปแบบไม่ตรง JSON เช็คด้วยตนเอง):\n' + resultJsonText;
        }

        await replyToLine(event.replyToken, displayText);
      } catch (err) {
        console.error('เกิดข้อผิดพลาด:', err.message);
        await replyToLine(event.replyToken, 'ขออภัย อ่านรูปไม่สำเร็จ ลองถ่ายใหม่อีกครั้งครับ');
      }
    }
  }
});

app.get('/', (req, res) => {
  res.send('LINE Stock Bot server is running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
