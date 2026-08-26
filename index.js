// เซิร์ฟเวอร์เริ่มต้นสำหรับรับ Webhook จาก LINE
// ตอนนี้แค่รับ event แล้ว log ไว้ดู ยังไม่ทำ OCR หรือบันทึกลง Sheet
// เป้าหมายตอนนี้คือให้ LINE "Verify" ผ่านก่อน

const express = require('express');
const app = express();

// LINE จะส่งข้อมูลมาเป็น JSON ต้องใช้ express.json() แปลงให้อ่านได้
app.use(express.json());

// LINE จะยิง POST มาที่ path นี้ทุกครั้งที่มีคนส่งข้อความ/รูปเข้า OA
app.post('/webhook', (req, res) => {
  const events = req.body.events || [];

  events.forEach((event) => {
    console.log('ได้รับ event ประเภท:', event.type);

    if (event.type === 'message' && event.message.type === 'image') {
      console.log('มีรูปภาพส่งเข้ามา! messageId:', event.message.id);
      // ขั้นตอนถัดไป: ดึงรูปจริงมาเก็บ แล้วส่งไปทำ OCR
    }
  });

  // ต้องตอบ 200 กลับไปเสมอ ไม่งั้น LINE จะคิดว่าระบบเรา error
  res.status(200).send('OK');
});

// route เช็คว่าเซิร์ฟเวอร์ยังทำงานอยู่ (เข้าผ่านเบราว์เซอร์ได้)
app.get('/', (req, res) => {
  res.send('LINE Stock Bot server is running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
