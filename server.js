const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { GoogleGenerativeAI } = require('@google/generative-ai');
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

// Render.com gibi platformlar istekleri bir ters proxy (reverse proxy)
// arkasından iletir ve X-Forwarded-For başlığı ekler. express-rate-limit,
// "trust proxy" ayarlanmadan bu başlığı gördüğünde güvenlik amacıyla hata
// fırlatıp sunucuyu çökertiyor (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR). Render
// tek bir güvenilir proxy katmanı kullandığı için "1" değeri doğru ve güvenli
// bir ayardır (Express'e yalnızca en yakın proxy'ye güvenmesini söyler).
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Render.com gibi platformların "servis ayakta mı" kontrolü (health check)
// için ve tarayıcıdan hızlıca test edebilmek için basit bir kök rota.
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Otopark backend çalışıyor.',
    excelFeed: '/excel-feed.csv',
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
if (!GEMINI_API_KEY) {
  console.error(
    '❌ GEMINI API KEY BULUNAMADI. .env dosyasına GEMINI_API_KEY=... satırını ekleyip sunucuyu yeniden başlatın.'
  );
  process.exit(1);
}
console.log(`🔑 Gemini API Key yüklendi (ilk 8 karakter): ${GEMINI_API_KEY.slice(0, 8)}...`);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// NOT: Bu projede daha önce Google E-Tablolar (Sheets API) entegrasyonu, yerel
// bilgisayardaki bir .xlsx dosyasına doğrudan yazan bir mekanizma, ve ayrıca
// Windows Görev Zamanlayıcı ile periyodik çalışan bir Python senkronizasyon
// betiği (export_to_excel.py) vardı; ÜÇÜ DE kullanıcı isteğiyle KALDIRILDI.
// Artık arka planda çalışan HİÇBİR zamanlanmış görev/cron/otomatik dosya
// yazma işlemi yoktur. Form kaydedildiğinde tek gerçek veri kaynağı (source
// of truth) Supabase'dir (bkz. App.js handleSaveRecord). Excel dosyası,
// SADECE kullanıcı mobil uygulamada "Excel Dosyasını İndir / Paylaş"
// butonuna bastığında, o anki tüm Supabase kayıtlarıyla isteğe bağlı
// (on-demand) ve bellekte üretilir; hiçbir yerel diske kalıcı yazma yapılmaz
// (bkz. aşağıdaki /export endpoint'i).

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
  "gemini-3.6-flash",
  "gemini-3.1-pro-preview",
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

// Gemini bazen "SADECE JSON yaz" talimatına uymayıp JSON'un öncesine/sonrasına
// açıklama cümlesi ya da ```json bloğu ekleyebiliyor. Bu durumda düz
// JSON.parse başarısız olur ve bu (kotayla ilgisi olmayan) hata yanlışlıkla
// "hiçbir model çalışmadı" genel mesajına yol açardı. Burada önce markdown
// bloklarını temizleyip deniyoruz; o da başarısız olursa metindeki ilk "{" ile
// son "}" arasını çıkarıp tekrar deniyoruz.
function extractJsonFromModelResponse(responseText) {
  if (typeof responseText !== 'string') {
    throw new Error('Model yanıtı string formatında değil.');
  }

  // JSON'u sarmalayan olası markdown kalıplarını temizle.
  const cleaned = responseText
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();

  // Yanıtın içinde ekstra açıklama varsa sadece { ... } kısmını parse etmeye çalış.
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const candidate =
    start !== -1 && end !== -1 && end > start ? cleaned.slice(start, end + 1) : cleaned;

  return JSON.parse(candidate);
}

// 1. GÖRSEL ANALİZ ENDPOINT'I
app.post('/analyze', enforceDailyAnalyzeLimit, analyzeLimiter, async (req, res) => {
  console.log('\n========== [Analyze] /analyze isteği alındı ==========');
  console.log('[Analyze] İstek zamanı:', new Date().toISOString());
  console.log(`[Analyze] API Key aktif: ${GEMINI_API_KEY ? 'Evet (' + GEMINI_API_KEY.slice(0, 8) + '...)' : 'HAYIR'}`);
  console.log(`[Analyze] Denenecek modeller: ${GEMINI_MODEL_CANDIDATES.join(', ')}`);

  if (!GEMINI_API_KEY) {
    console.error('❌ GEMINI API KEY BULUNAMADI - istek reddedildi.');
    return res.status(500).json({
      success: false,
      error: 'Sunucuda Gemini API anahtarı tanımlı değil. Lütfen yöneticiye bildirin.',
    });
  }

  const { base64Image } = req.body;

  if (!base64Image) {
    console.error('[Analyze] Geçersiz istek: base64Image alanı eksik.');
    return res.status(400).json({ success: false, error: 'base64Image alanı eksik.' });
  }
  console.log(`[Analyze] Gelen görsel boyutu (base64): ~${Math.round((base64Image.length * 0.75) / 1024)} KB`);

  const prompt = `Görseldeki otopark formunu oku. JSON döndür: {"form_no":"","plaka":"","bolum":"","cikis_tarihi":"","cikis_saati":"","cikis_km":"","donus_tarihi":"","donus_saati":"","donus_km":"","gorev":"","surucu_adi":""}`;

  const imageParts = [{
    inlineData: {
      data: base64Image,
      mimeType: "image/jpeg"
    }
  }];

  let lastError = null;
  let allQuotaExceeded = true;
  for (const modelName of GEMINI_MODEL_CANDIDATES) {
    console.log(`[Analyze] "${modelName}" modeli deneniyor...`);
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          // JSON ortada kesilip parse hatası vermesin diye yüksek değer.
          maxOutputTokens: 2048,
        },
      });
      const result = await model.generateContent([prompt, ...imageParts]);

      const responseText = result.response.text();
      console.log(`[Analyze] "${modelName}" ham yanıt (ilk 500 karakter):`, responseText.slice(0, 500));

      let data;
      try {
        data = extractJsonFromModelResponse(responseText);
      } catch (parseError) {
        console.error(`[Analyze] "${modelName}" JSON PARSE HATASI: ${parseError.message}`);
        console.error(`[Analyze] "${modelName}" parse edilemeyen tam yanıt:`, responseText);
        // JSON parse hatası kota ile ilgili değildir; bunu ayrı bir "quota
        // değil" sebep olarak işaretleyip bir sonraki modeli deniyoruz.
        allQuotaExceeded = false;
        lastError = parseError;
        continue;
      }

      console.log(`✅ [Analyze] "${modelName}" modeliyle başarıyla analiz edildi. Çıkarılan veri:`, JSON.stringify(data));
      return res.json({ success: true, data, model: modelName });
    } catch (error) {
      const status = error?.status || error?.response?.status || error?.httpErrorCode;
      const errorBody = error?.response?.data || error?.errorDetails || null;
      console.error(`❌ [Analyze] "${modelName}" API HATASI:`);
      console.error(`   status  = ${status}`);
      console.error(`   message = ${error?.message}`);
      if (errorBody) {
        console.error(`   body    = ${JSON.stringify(errorBody).slice(0, 500)}`);
      }
      if (status !== 429) {
        allQuotaExceeded = false;
      }
      lastError = error;
      if (status === 429 || status === 503) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  const friendlyMessage = allQuotaExceeded
    ? 'Ücretsiz Gemini API kullanım kotanız doldu (günlük/dakikalık istek sınırı aşıldı). Lütfen birkaç dakika sonra ya da yarın tekrar deneyin, veya Google AI Studio üzerinden ücretli bir plana geçin.'
    : 'Hiçbir Gemini modeli görseli analiz edemedi. Lütfen tekrar deneyin.';

  console.warn(`[Analyze] Sunucu: Hiçbir Gemini modeli çalışmadı. Son hata: ${summarizeGeminiError(lastError)}`);
  console.log('========== [Analyze] /analyze isteği tamamlandı (başarısız) ==========\n');
  res.status(503).json({ success: false, error: friendlyMessage });
});

// Kullanıcının mobil formda elle girdiği "09:00" / "9:00" gibi bir saat
// metnini, verilen taban tarihin (baseDate) saat/dakikasına uygulayarak yeni
// bir Date döndürür. Metin boşsa veya "SS:DD" formatına uymuyorsa null
// döner (çağıran taraf bu durumda güvenli bir varsayılana düşer).
function combineDateWithTimeString(baseDate, timeString) {
  if (!timeString) return null;
  const match = String(timeString).trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours > 23 || minutes > 59) {
    return null;
  }
  const combined = new Date(baseDate);
  combined.setHours(hours, minutes, 0, 0);
  return combined;
}

// /export için tek kaynak: Excel uygulamasında manuel hazırlanmış, içinde
// https://otopark-app.onrender.com/excel-feed.csv bağlantısı gömülü temiz
// şablon dosyası. Kod ile .xlsx üretimi YOK; sunucu bu dosyayı olduğu gibi
// istemciye servis eder.
// Uygulamadan indirilen Excel: içinde Power/Web Query olarak
// /excel-feed.csv adresine önceden bağlı canlı şablon.
const LIVE_EXPORT_TEMPLATE_PATH = path.join(__dirname, 'assets', 'canli_otopark_sablon.xlsx');

function sendLiveExcelTemplate(res) {
  if (!fs.existsSync(LIVE_EXPORT_TEMPLATE_PATH)) {
    throw new Error(
      'Canlı Excel şablonu (assets/canli_otopark_sablon.xlsx) bulunamadı. ' +
        'Excel uygulamasında manuel olarak oluşturduğunuz temiz şablonu bu konuma kopyalayın.'
    );
  }
  res.setHeader('X-Excel-Mode', 'live-web-query');
  res.setHeader('X-Excel-Feed', 'https://otopark-app.onrender.com/excel-feed.csv');
  res.setHeader('Access-Control-Expose-Headers', 'X-Excel-Mode, X-Excel-Feed');
  res.setHeader('Cache-Control', 'no-store');
  res.download(LIVE_EXPORT_TEMPLATE_PATH, 'HIZMET_ARACLARI_TAKIP_FORMU_CANLI.xlsx');
}

// 2. EXCEL DIŞA AKTARMA ENDPOINT'I ("Excel Dosyasını İndir / Paylaş" butonu)
// Artık kaydı dosyaya "yapıştırıp" göndermiyoruz. Kullanıcıya, içinde
// https://otopark-app.onrender.com/excel-feed.csv web sorgusu gömülü hazır
// bir .xlsx veriyoruz. Dosya bilgisayarda açılınca / "Tümü Yenile" deyince
// Excel bu adresten canlı veriyi çeker; uygulamadan tekrar indirmeye gerek kalmaz.
app.post('/export', exportLimiter, (req, res) => {
  try {
    sendLiveExcelTemplate(res);
  } catch (error) {
    console.error('Sunucu Excel Hatası:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/export', exportLimiter, (req, res) => {
  try {
    sendLiveExcelTemplate(res);
  } catch (error) {
    console.error('Sunucu Excel Hatası:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Telefona indirilen .xlsx dosyası bir ANLIK GÖRÜNTÜDÜR; kendi kendine
// güncellenemez. Bilgisayardaki Excel'i bir kez aşağıdaki URL'ye bağlarsanız
// "Veriyi Yenile" (veya dosyayı açınca otomatik yenileme) ile Supabase'deki
// en güncel kayıtlar aynı Excel dosyasına akar; uygulamadan tekrar indirmeye
// gerek kalmaz.
//
// URL: GET https://otopark-app.onrender.com/excel-feed.csv
const feedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Çok fazla Excel beslemesi isteği. Lütfen biraz sonra tekrar deneyin.' },
});

const EXCEL_FEED_HEADERS = [
  'Id',
  'Başlangıç saati',
  'Tamamlama saati',
  'E-posta',
  'Ad',
  'Form Numarası',
  'Sütun1',
  'Aracın Çıkış Tarihi',
  'Plaka',
  'Sürücü Adı Soyadı',
  'Departman',
  'Kullanım Amacı',
  'Çıkış Km',
  'Çıkış Saati',
  'Dönüş Km',
  'Dönüş Saati',
  'Aracın Dönüş Tarihi',
  'Silindi mi',
  'Kayıt Zamanı',
];

function csvEscape(value) {
  if (value == null || value === '') return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatTrDateTime(isoOrDate) {
  if (!isoOrDate) return '';
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return String(isoOrDate);
  return d.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
}

function mapSupabaseRowToFeedRecord(row) {
  return {
    id: String(row.id),
    baslangicSaati: row.baslangic_saati || '',
    tamamlanmaSaati: row.tamamlanma_saati || '',
    formNo: row.form_no || '',
    plaka: row.plaka || '',
    bolum: row.bolum || '',
    cikisTarihi: row.cikis_tarihi || '',
    cikisSaati: row.cikis_saati || '',
    cikisKm: row.cikis_km || '',
    donusTarihi: row.donus_tarihi || '',
    donusSaati: row.donus_saati || '',
    donusKm: row.donus_km || '',
    gorev: row.gorev || '',
    surucuAdi: row.surucu_adi || '',
    isDeleted: row.is_deleted === true,
    createdAt: row.created_at || '',
  };
}

async function fetchAllSupabaseFormRecords() {
  const supabaseUrl = (
    process.env.EXPO_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    ''
  )
    .trim()
    .replace(/\/rest\/v1\/?$/i, '')
    .replace(/\/+$/, '');
  const anonKey =
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

  if (!supabaseUrl || !anonKey) {
    throw new Error(
      'Sunucuda EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY (veya SUPABASE_*) tanımlı değil.'
    );
  }

  const pageSize = 1000;
  const allRows = [];
  let from = 0;

  for (;;) {
    const to = from + pageSize - 1;
    const endpoint = `${supabaseUrl}/rest/v1/otopark_formlari?select=*&order=id.asc`;
    const response = await fetch(endpoint, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        Range: `${from}-${to}`,
        Prefer: 'count=exact',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Supabase okuma hatası (${response.status}): ${body.slice(0, 300)}`);
    }

    const chunk = await response.json();
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    allRows.push(...chunk);
    if (chunk.length < pageSize) break;
    from += pageSize;
  }

  return allRows.map(mapSupabaseRowToFeedRecord);
}

function buildExcelFeedCsv(records) {
  const lines = [EXCEL_FEED_HEADERS.map(csvEscape).join(',')];

  records.forEach((record, index) => {
    const createdAtMs = Number(record.id);
    const createdAt = Number.isFinite(createdAtMs) ? new Date(createdAtMs) : new Date(record.createdAt || Date.now());
    const baslangic = combineDateWithTimeString(createdAt, record.baslangicSaati) || createdAt;
    const tamamlanma = combineDateWithTimeString(createdAt, record.tamamlanmaSaati) || createdAt;

    const row = [
      index + 1,
      formatTrDateTime(baslangic),
      formatTrDateTime(tamamlanma),
      'anonymous',
      '',
      record.formNo || '',
      '',
      record.cikisTarihi || '',
      record.plaka || '',
      record.surucuAdi || '',
      record.bolum || '',
      record.gorev || '',
      record.cikisKm || '',
      record.cikisSaati || '',
      record.donusKm || '',
      record.donusSaati || '',
      record.donusTarihi && record.donusTarihi !== record.cikisTarihi ? record.donusTarihi : '',
      record.isDeleted ? 'Evet' : 'Hayır',
      formatTrDateTime(record.createdAt || createdAt),
    ];
    lines.push(row.map(csvEscape).join(','));
  });

  // Excel TR için UTF-8 BOM
  return `\uFEFF${lines.join('\r\n')}`;
}

app.get('/excel-feed.csv', feedLimiter, async (req, res) => {
  try {
    const records = await fetchAllSupabaseFormRecords();
    const csv = buildExcelFeedCsv(records);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="otopark_formlari_canli.csv"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  } catch (error) {
    console.error('Excel feed hatası:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/excel-feed', feedLimiter, async (req, res) => {
  res.redirect(302, '/excel-feed.csv');
});

// 3. FORM GÖRSELİ OLUŞTURMA ENDPOINT'I
// Kullanıcı orijinal (taranan kağıt) fotoğrafı değil, form alanlarının
// düz yazı halinde göründüğü beyaz bir "sayfa" görseli istediği için; form
// verilerinden bir SVG oluşturup sharp ile JPEG'e dönüştürüyoruz. Bunu
// Expo Go'nun (native görüntü yakalama modülleri gerektiren react-native-
// view-shot gibi kütüphaneleri desteklemeyen) kısıtlamalarına takılmadan,
// zaten çalışan sunucu tarafında yapmak en güvenilir yöntem.
const FORM_IMAGE_FIELDS = [
  { key: 'baslangicSaati', label: 'Başlangıç Saati' },
  { key: 'tamamlanmaSaati', label: 'Tamamlanma Saati' },
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