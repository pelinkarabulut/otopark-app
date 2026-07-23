const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const XLSX = require('xlsx');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Buraya kendi API Key'ini yapıştır
const GEMINI_API_KEY = "AQ.Ab8RN6Kd-t4BVovF38lwCWIBEAzLK5DhlPAn6AIecVgYW-7ezA";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Google modelleri sık değiştirdiği/kaldırdığı ve bu API key/hesap için bazı
// modeller 404 (bulunamadı) veya kota=0 hatası verdiği için, ilk çalışan
// modeli bulana kadar sırayla dene.
const GEMINI_MODEL_CANDIDATES = [
  "gemini-flash-latest",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
];

// 1. GÖRSEL ANALİZ ENDPOINT'I
app.post('/analyze', async (req, res) => {
  const { base64Image } = req.body;

  if (!base64Image) {
    return res.status(400).json({ success: false, error: 'base64Image alanı eksik.' });
  }

  const prompt = `Bu bir otopark araç görev formudur. Görseldeki el yazısı verilerini oku ve SADECE aşağıdaki JSON formatında yanıt ver. Ekstra hiçbir açıklama veya markdown bloğu yazma:
    {
      "form_no": "form numarası",
      "plaka": "plaka",
      "bolum": "departman / bölüm",
      "cikis_tarihi": "tarih",
      "cikis_saati": "çıkış saati",
      "cikis_km": "çıkış km",
      "donus_tarihi": "dönüş tarihi",
      "donus_saati": "dönüş saati",
      "donus_km": "dönüş km",
      "gorev": "araç kullanım amacı / görev",
      "surucu_adi": "sürücü adı soyadı"
    }`;

  const imageParts = [{
    inlineData: {
      data: base64Image,
      mimeType: "image/jpeg"
    }
  }];

  let lastError = null;
  for (const modelName of GEMINI_MODEL_CANDIDATES) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent([prompt, ...imageParts]);
      const responseText = result.response.text();

      const cleanJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
      const data = JSON.parse(cleanJson);

      console.log(`✅ "${modelName}" modeliyle başarıyla analiz edildi.`);
      return res.json({ success: true, data, model: modelName });
    } catch (error) {
      console.error(`⚠️  "${modelName}" modeli başarısız oldu:`, error.message);
      lastError = error;
    }
  }

  console.error("Sunucu Hatası: Hiçbir Gemini modeli çalışmadı.", lastError);
  res
    .status(500)
    .json({ success: false, error: lastError ? lastError.message : 'Bilinmeyen sunucu hatası.' });
});

// Şablonun Id/Başlangıç saati/Tamamlama saati sütunları için: JS Date'i
// Excel'in kullandığı seri gün sayısına çevirir (1899-12-30 taban tarihi).
const EXCEL_EPOCH_OFFSET_DAYS = 25569;
const MS_PER_DAY = 86400000;
const DATE_TIME_NUMBER_FORMAT = 'm/d/yy h:mm';

function excelSerialFromDate(date) {
  const localMs = date.getTime() - date.getTimezoneOffset() * 60000;
  return localMs / MS_PER_DAY + EXCEL_EPOCH_OFFSET_DAYS;
}

// Excel Şablonuna Satır Dizilimi
// NOT: 0-4. sütunlar (Id, Başlangıç saati, Tamamlama saati, E-posta, Ad)
// Microsoft Forms'un kendi otomatik ürettiği alanlardır. Mobil uygulamadan
// gelen kayıtlar gerçek bir form gönderimi olmadığı için buradaki değerler
// (kimlik, e-posta, ad) makul varsayılanlarla dolduruluyor; asıl form verisi
// 5. sütundan itibaren başlıyor.
function buildExcelRow(record, nextId) {
  const row = new Array(20).fill(null);

  const createdAtMs = Number(record.id);
  const createdAt = Number.isFinite(createdAtMs) ? new Date(createdAtMs) : new Date();
  const excelDateTime = excelSerialFromDate(createdAt);

  row[0] = nextId;
  row[1] = excelDateTime;
  row[2] = excelDateTime;
  row[3] = 'anonymous';
  row[4] = null;
  row[5] = record.formNo || '';
  row[7] = record.cikisTarihi || '';
  row[8] = record.plaka || '';
  row[9] = record.surucuAdi || '';
  row[10] = record.bolum || '';
  row[11] = record.gorev || '';
  row[12] = record.cikisKm || '';
  row[13] = record.cikisSaati || '';
  row[14] = record.donusKm || '';
  row[15] = record.donusSaati || '';
  row[16] = record.donusTarihi && record.donusTarihi !== record.cikisTarihi ? record.donusTarihi : '';
  return row;
}

function findMaxExistingId(worksheet, range) {
  let maxId = 0;
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const cell = worksheet[XLSX.utils.encode_cell({ r, c: 0 })];
    if (cell && typeof cell.v === 'number' && cell.v > maxId) {
      maxId = cell.v;
    }
  }
  return maxId;
}

// 2. EXCEL DIŞA AKTARMA ENDPOINT'I
app.post('/export', (req, res) => {
  try {
    const { records } = req.body;
    if (!records || !Array.isArray(records)) {
      return res.status(400).json({ success: false, error: 'Kayıt bulunamadı.' });
    }

    const templatePath = path.join(__dirname, 'assets', 'sablon.xlsx');
    if (!fs.existsSync(templatePath)) {
      throw new Error(`assets/sablon.xlsx dosyası bulunamadı: ${templatePath}`);
    }

    // Sheet1 hatasını önlemek için güvenli okuma seçenekleri
    const workbook = XLSX.readFile(templatePath, {
      cellStyles: true,
      cellFormulas: true,
      cellDates: true
    });

    const sheetName = workbook.SheetNames[0] || 'Sheet1';
    const worksheet = workbook.Sheets[sheetName];

    const rangeBeforeAppend = XLSX.utils.decode_range(worksheet['!ref']);
    const firstNewRowIndex = rangeBeforeAppend.e.r + 1; // 0-tabanlı
    let nextId = findMaxExistingId(worksheet, rangeBeforeAppend) + 1;

    const rows = records.map((record) => buildExcelRow(record, nextId++));
    XLSX.utils.sheet_add_aoa(worksheet, rows, { origin: -1 });

    // Başlangıç/Tamamlama saati sütunlarını, şablondaki diğer tarih
    // hücreleriyle aynı görünecek şekilde (ör. "7/22/26 12:08") biçimlendir;
    // aksi halde yeni satırlar ham sayı (46225.51 gibi) olarak görünüp
    // diğer satırlarla hizasız/tutarsız dururdu.
    for (let i = 0; i < rows.length; i++) {
      const rowIndex = firstNewRowIndex + i;
      [1, 2].forEach((colIndex) => {
        const cellRef = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
        if (worksheet[cellRef]) {
          worksheet[cellRef].t = 'n';
          worksheet[cellRef].z = DATE_TIME_NUMBER_FORMAT;
        }
      });
    }

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellStyles: true });

    // Kullanıcı, şablondaki (aynı plaka/form no tekrar edebilen) binlerce eski
    // satır arasında yeni kaydını "Bul" (Ctrl+F) ile ararken kafası karışmasın
    // diye, yeni verinin tam olarak hangi Excel satırına düştüğünü de
    // özel bir header ile bildiriyoruz (1-tabanlı Excel satır numarası).
    const newRange = XLSX.utils.decode_range(worksheet['!ref']);
    const lastRowExcelNumber = newRange.e.r + 1; // 0-tabanlı -> 1-tabanlı
    const firstNewRowExcelNumber = lastRowExcelNumber - rows.length + 1;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('X-New-Row-Start', String(firstNewRowExcelNumber));
    res.setHeader('X-New-Row-End', String(lastRowExcelNumber));
    res.setHeader('Access-Control-Expose-Headers', 'X-New-Row-Start, X-New-Row-End');
    res.send(buffer);
  } catch (error) {
    console.error("Sunucu Excel Hatası:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(3000, '0.0.0.0', () => {
  console.log("🚀 Local Backend Sunucusu 3000 Portunda Aktif!");
});