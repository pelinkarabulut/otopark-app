const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const XLSX = require('xlsx');
const sharp = require('sharp');

// Node bu dosyayı doğrudan `node server.js` ile çalıştırıyor; Expo/Metro'nun
// .env yükleyicisi burada devrede olmadığı için proje kökündeki .env dosyasını
// kendimiz okuyup process.env'e yüklüyoruz. Bu sayede GEMINI_API_KEY gibi gizli
// anahtarlar kaynak koduna değil, git'e gönderilmeyen .env dosyasına yazılır.
function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  });
}
loadDotEnv();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Render.com gibi platformların "servis ayakta mı" kontrolü (health check)
// için ve tarayıcıdan hızlıca test edebilmek için basit bir kök rota.
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Otopark backend çalışıyor.' });
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error(
    'HATA: GEMINI_API_KEY tanımlı değil. Proje kök dizinindeki .env dosyasına ' +
      '"GEMINI_API_KEY=..." satırını ekleyip sunucuyu yeniden başlatın.'
  );
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// --- Hız Sınırlama / Maliyet Koruması ---
// Gemini'ye giden her /analyze isteği ücretli/kotalı olduğu için, tek bir
// cihazın (veya kötü niyetli birinin) sunucuyu/API faturasını aşırı
// yüklemesini önlemek amacıyla iki katmanlı bir koruma uygulanıyor:
//   1) Aynı IP'den kısa sürede gelen aşırı istekleri engelleyen limiter.
//   2) Kaç farklı IP'den gelirse gelsin, sunucunun GÜNLÜK toplam Gemini
//      isteği sayısını sabit bir tavanla sınırlayan basit bellek-içi sayaç.
const analyzeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakika
  max: 15, // Aynı IP'den 15 dakikada en fazla 15 analiz isteği
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Çok fazla analiz isteği gönderdiniz. Lütfen birkaç dakika sonra tekrar deneyin.',
  },
});

const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // Excel üretimi Gemini'ye gitmiyor, bu yüzden daha gevşek bir sınır yeterli.
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Çok fazla Excel isteği gönderdiniz. Lütfen birkaç dakika sonra tekrar deneyin.',
  },
});

const MAX_DAILY_ANALYZE_REQUESTS = Number(process.env.MAX_DAILY_ANALYZE_REQUESTS) || 200;
let dailyAnalyzeCount = 0;
let dailyResetAt = getNextMidnight();

function getNextMidnight() {
  const next = new Date();
  next.setHours(24, 0, 0, 0);
  return next.getTime();
}

function enforceDailyAnalyzeLimit(req, res, next) {
  if (Date.now() >= dailyResetAt) {
    dailyAnalyzeCount = 0;
    dailyResetAt = getNextMidnight();
  }
  if (dailyAnalyzeCount >= MAX_DAILY_ANALYZE_REQUESTS) {
    console.warn(`🛑 Günlük analiz limiti (${MAX_DAILY_ANALYZE_REQUESTS}) doldu, istek reddedildi.`);
    return res.status(429).json({
      success: false,
      error: 'Sunucunun günlük analiz isteği limiti doldu. Lütfen yarın tekrar deneyin.',
    });
  }
  dailyAnalyzeCount += 1;
  next();
}

// Google modelleri sık değiştirdiği/kaldırdığı ve bu API key/hesap için bazı
// modeller 404 (bulunamadı) veya kota=0 hatası verdiği için, ilk çalışan
// modeli bulana kadar sırayla dene.
// Not: "gemini-2.5-flash-lite", "gemini-1.5-flash" ve "gemini-1.5-flash-8b"
// bu API sürümünde kalıcı olarak 404 (artık mevcut değil) döndüğü için listeden
// çıkarıldı; her istekte gereksiz yere denenip konsolu kirletmesinler diye.
const GEMINI_MODEL_CANDIDATES = [
  "gemini-flash-latest",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash",
];

// Bir model denemesinden gelen hatayı, konsolu kilometrelerce JSON ile
// doldurmadan tek satırda anlaşılır şekilde özetler.
function summarizeGeminiError(error) {
  const status = error?.status || error?.response?.status;
  if (status === 429) {
    return 'Kota/hız sınırı aşıldı (429).';
  }
  if (status === 404) {
    return 'Model bulunamadı/artık desteklenmiyor (404).';
  }
  return error?.message ? error.message.split('\n')[0].slice(0, 160) : 'Bilinmeyen hata';
}

// 1. GÖRSEL ANALİZ ENDPOINT'I
app.post('/analyze', enforceDailyAnalyzeLimit, analyzeLimiter, async (req, res) => {
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
  let allQuotaExceeded = true;
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
      const status = error?.status || error?.response?.status;
      if (status !== 429) {
        allQuotaExceeded = false;
      }
      console.warn(`⚠️  "${modelName}" başarısız: ${summarizeGeminiError(error)}`);
      lastError = error;
    }
  }

  const friendlyMessage = allQuotaExceeded
    ? 'Ücretsiz Gemini API kullanım kotanız doldu (günlük/dakikalık istek sınırı aşıldı). Lütfen birkaç dakika sonra ya da yarın tekrar deneyin, veya Google AI Studio üzerinden ücretli bir plana geçin.'
    : 'Hiçbir Gemini modeli görseli analiz edemedi. Lütfen tekrar deneyin.';

  console.warn(`Sunucu: Hiçbir Gemini modeli çalışmadı. Son hata: ${summarizeGeminiError(lastError)}`);
  res.status(503).json({ success: false, error: friendlyMessage });
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
app.post('/export', exportLimiter, (req, res) => {
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

// 3. FORM GÖRSELİ OLUŞTURMA ENDPOINT'I
// Kullanıcı orijinal (taranan kağıt) fotoğrafı değil, form alanlarının
// düz yazı halinde göründüğü beyaz bir "sayfa" görseli istediği için; form
// verilerinden bir SVG oluşturup sharp ile JPEG'e dönüştürüyoruz. Bunu
// Expo Go'nun (native görüntü yakalama modülleri gerektiren react-native-
// view-shot gibi kütüphaneleri desteklemeyen) kısıtlamalarına takılmadan,
// zaten çalışan sunucu tarafında yapmak en güvenilir yöntem.
const FORM_IMAGE_FIELDS = [
  { key: 'formNo', label: 'Form Numarası' },
  { key: 'plaka', label: 'Plaka' },
  { key: 'bolum', label: 'Bölüm / Departman' },
  { key: 'cikisTarihi', label: 'Çıkış Tarihi' },
  { key: 'cikisSaati', label: 'Çıkış Saati' },
  { key: 'cikisKm', label: 'Çıkış Km' },
  { key: 'donusTarihi', label: 'Dönüş Tarihi' },
  { key: 'donusSaati', label: 'Dönüş Saati' },
  { key: 'donusKm', label: 'Dönüş Km' },
  { key: 'gorev', label: 'Görev / Açıklama' },
  { key: 'surucuAdi', label: 'Sürücü Adı' },
];

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&apos;';
    }
  });
}

function buildFormImageSvg(formData) {
  const width = 900;
  const height = 1150;
  const marginX = 60;
  const lineHeight = 96;
  let y = 190;

  const rows = FORM_IMAGE_FIELDS.map((field) => {
    const value = formData?.[field.key];
    const displayValue = value != null && String(value).trim() !== '' ? String(value) : '-';
    const block = `
      <text x="${marginX}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="bold" fill="#4B5160">${escapeXml(field.label)}</text>
      <text x="${marginX}" y="${y + 34}" font-family="Arial, Helvetica, sans-serif" font-size="32" fill="#1A1D29">${escapeXml(displayValue)}</text>
      <line x1="${marginX}" y1="${y + 52}" x2="${width - marginX}" y2="${y + 52}" stroke="#E2E6F0" stroke-width="2" />`;
    y += lineHeight;
    return block;
  }).join('\n');

  const generatedAt = new Date().toLocaleString('tr-TR');

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#FFFFFF" />
    <text x="${marginX}" y="80" font-family="Arial, Helvetica, sans-serif" font-size="44" font-weight="bold" fill="#1A1D29">🅿️ Otopark Formu</text>
    <text x="${marginX}" y="120" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#8A8F9E">Oluşturulma: ${escapeXml(generatedAt)}</text>
    <line x1="${marginX}" y1="140" x2="${width - marginX}" y2="140" stroke="#1A1D29" stroke-width="3" />
    ${rows}
  </svg>`;
}

app.post('/form-image', exportLimiter, async (req, res) => {
  try {
    const { formData } = req.body;
    if (!formData || typeof formData !== 'object') {
      return res.status(400).json({ success: false, error: 'formData alanı eksik.' });
    }

    const svg = buildFormImageSvg(formData);
    const buffer = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();

    res.setHeader('Content-Type', 'image/jpeg');
    res.send(buffer);
  } catch (error) {
    console.error('Form görseli oluşturma hatası:', error.message);
    res.status(500).json({ success: false, error: 'Form görseli oluşturulamadı: ' + error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend Sunucusu ${PORT} Portunda Aktif!`);
});