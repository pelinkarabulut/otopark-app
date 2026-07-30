import React, { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  ScrollView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Image,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File, Directory, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library';
import * as SplashScreen from 'expo-splash-screen';
import axios from 'axios';
import { supabase } from './lib/supabase';

SplashScreen.preventAutoHideAsync().catch(() => {});

// Üretim (production) sunucu adresi. Yerel geliştirmede geçici olarak
// farklı bir URL denemek isterseniz EXPO_PUBLIC_SERVER_URL ortam değişkenini
// kullanın; aksi halde her zaman canlı Render backend'e bağlanır.
// Form kayıtları doğrudan Supabase'e yazılır; Excel dosyası yalnızca
// "Excel Dosyasını İndir / Paylaş" butonuyla isteğe bağlı üretilir.
const SERVER_BASE_URL = (
  process.env.EXPO_PUBLIC_SERVER_URL || 'https://otopark-app.onrender.com'
).replace(/\/+$/, '');
const SERVER_ANALYZE_URL = `${SERVER_BASE_URL}/analyze`;
const SERVER_EXPORT_URL = `${SERVER_BASE_URL}/export`;
const SERVER_FORM_IMAGE_URL = `${SERVER_BASE_URL}/form-image`;

// Render'ın ücretsiz katmanı, sunucu ~15 dakika hiç istek almazsa onu
// uyutuyor; bir sonraki istek sunucuyu uyandırırken bazen 60 saniyeyi bile
// aşabiliyor. Bu yüzden zaman aşımını cömert (90 sn) tutuyoruz.
const SERVER_REQUEST_TIMEOUT_MS = 90000;

// axios bir zaman aşımına (timeout) uğradığında error.response HİÇ olmaz;
// bu da gerçekte "sunucu var ama uyanması uzun sürdü" durumunu, sunucuya hiç
// ulaşılamadığı ya da internetin kapalı olduğu durumdan ayırt edemememize yol
// açardı. Bu fonksiyon, zaman aşımı durumunda kullanıcıya çok daha isabetli
// ("sunucu uyanıyor olabilir, tekrar dene") bir mesaj gösterir.
function getServerConnectionErrorMessage(error) {
  const isTimeout =
    error?.code === 'ECONNABORTED' || /timeout/i.test(error?.message || '');
  if (isTimeout) {
    return (
      `Sunucu (${SERVER_BASE_URL}) şu anda "uyku modundan" uyanıyor olabilir ` +
      '(ücretsiz sunucu barındırma, uzun süre kullanılmayınca uykuya geçiyor). ' +
      'Lütfen 30-60 saniye bekleyip tekrar deneyin; genelde ikinci denemede sorunsuz çalışır.'
    );
  }
  return (
    `Sunucuya (${SERVER_BASE_URL}) erişilemedi. İnternet bağlantını ve sunucunun ` +
    'çalışır durumda olduğunu kontrol et.'
  );
}

const EMPTY_FORM = {
  baslangicSaati: '',
  tamamlanmaSaati: '',
  formNo: '',
  plaka: '',
  bolum: '',
  cikisTarihi: '',
  cikisSaati: '',
  cikisKm: '',
  donusTarihi: '',
  donusSaati: '',
  donusKm: '',
  gorev: '',
  surucuAdi: '',
};

// Gemini'ye/sunucuya göndermeden önce görseli küçültüp sıkıştırmak için
// kullanılan sınırlar. 1280px + %70-80 JPEG kalitesi, plaka/el yazısı gibi
// ince metinlerin okunabilirliğini bozmadan dosya boyutunu (genelde 8-10 MB
// -> 300-500 KB) ciddi oranda düşürüyor ve yükleme/analiz süresini kısaltıyor.
const MAX_ANALYSIS_DIMENSION = 1280;
const ANALYSIS_JPEG_QUALITY = 0.75;

const SUPABASE_TABLE = 'otopark_formlari';

// KURAL: Aynı form bilgileri (aynı plaka/form no vb.) 100 kere bile
// gönderilse, her gönderim BAĞIMSIZ ve BENZERSİZ bir satır olarak eklenir;
// hiçbir alanda UNIQUE kısıtlama yoktur ve hiçbir yerde UPSERT/UPDATE ile
// "üzerine yazma" yapılmaz (bkz. handleSaveRecord, her zaman .insert()).
//
// id, Date.now() (milisaniye) + 3 haneli rastgele bir sayıdan üretilir. Salt
// Date.now() kullanmak, aynı milisaniyede (ör. çok hızlı art arda basma veya
// iki farklı cihazdan eşzamanlı gönderim) teorik bir çakışma riski taşırdı;
// rastgele son ek bu riski pratikte sıfıra indirir. Yine de (çok düşük
// ihtimalle) bir çakışma olursa handleSaveRecord bunu Postgres'in "23505"
// (unique violation) hatasından yakalayıp yeni bir id ile otomatik tekrar
// dener; böylece bir kayıt asla sessizce kaybolmaz.
function generateUniqueRecordId() {
  const randomSuffix = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0');
  return Number(`${Date.now()}${randomSuffix}`);
}

// records state'indeki alanlar camelCase (formNo, cikisTarihi...), Supabase
// tablosundaki sütunlar ise snake_case (form_no, cikis_tarihi...). Bu iki
// fonksiyon aralarında dönüşüm yapar.
function mapRecordToSupabaseRow(record) {
  return {
    id: Number(record.id),
    baslangic_saati: record.baslangicSaati || null,
    tamamlanma_saati: record.tamamlanmaSaati || null,
    form_no: record.formNo || null,
    plaka: record.plaka || null,
    bolum: record.bolum || null,
    cikis_tarihi: record.cikisTarihi || null,
    cikis_saati: record.cikisSaati || null,
    cikis_km: record.cikisKm || null,
    donus_tarihi: record.donusTarihi || null,
    donus_saati: record.donusSaati || null,
    donus_km: record.donusKm || null,
    gorev: record.gorev || null,
    surucu_adi: record.surucuAdi || null,
    archived_uri: record.archivedUri || null,
  };
}

function mapSupabaseRowToRecord(row) {
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
    archivedUri: row.archived_uri || null,
  };
}

function mapServerResponseToFormData(data) {
  return {
    // Başlangıç/Tamamlanma saati kağıt formda yer almaz; kullanıcı bu iki
    // alanı analiz sonrası elle girer. Yine de kontrolsüz (uncontrolled)
    // TextInput uyarısı almamak için boş string ile başlatıyoruz.
    baslangicSaati: '',
    tamamlanmaSaati: '',
    formNo: data?.form_no != null ? String(data.form_no).trim() : '',
    plaka: data?.plaka != null ? String(data.plaka).trim() : '',
    bolum: data?.bolum != null ? String(data.bolum).trim() : '',
    cikisTarihi: data?.cikis_tarihi != null ? String(data.cikis_tarihi).trim() : '',
    cikisSaati: data?.cikis_saati != null ? String(data.cikis_saati).trim() : '',
    cikisKm: data?.cikis_km != null ? String(data.cikis_km).trim() : '',
    donusTarihi: data?.donus_tarihi != null ? String(data.donus_tarihi).trim() : '',
    donusSaati: data?.donus_saati != null ? String(data.donus_saati).trim() : '',
    donusKm: data?.donus_km != null ? String(data.donus_km).trim() : '',
    gorev: data?.gorev != null ? String(data.gorev).trim() : '',
    surucuAdi: data?.surucu_adi != null ? String(data.surucu_adi).trim() : '',
  };
}

const FIELD_LABELS = [
  { key: 'baslangicSaati', label: 'Başlangıç Saati', placeholder: '09:00' },
  { key: 'tamamlanmaSaati', label: 'Tamamlanma Saati', placeholder: '17:30' },
  { key: 'formNo', label: 'Form Numarası', placeholder: '006430', keyboardType: 'number-pad' },
  { key: 'plaka', label: 'Plaka', placeholder: '34 PVY 009', autoCapitalize: 'characters' },
  { key: 'bolum', label: 'Bölüm / Departman', placeholder: 'Paketleme - İd. İşler' },
  { key: 'cikisTarihi', label: 'Çıkış Tarihi', placeholder: '21.7.2026' },
  { key: 'cikisSaati', label: 'Çıkış Saati', placeholder: '11:10' },
  { key: 'cikisKm', label: 'Çıkış Km', placeholder: '1695', keyboardType: 'number-pad' },
  { key: 'donusTarihi', label: 'Dönüş Tarihi', placeholder: '21.7.2026' },
  { key: 'donusSaati', label: 'Dönüş Saati', placeholder: '12:20' },
  { key: 'donusKm', label: 'Dönüş Km', placeholder: '1750', keyboardType: 'number-pad' },
  { key: 'gorev', label: 'Görev / Açıklama', placeholder: 'Milas Devlet Hastanesi Per. Bır.' },
  { key: 'surucuAdi', label: 'Sürücü Adı', placeholder: 'Ceyhan Serin' },
];

function sanitizeForFileName(value) {
  if (!value) return 'form';
  return (
    value
      .toString()
      .trim()
      .replace(/[^a-zA-Z0-9]/g, '')
      .toUpperCase() || 'form'
  );
}

function timestampSuffix() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function AppContent() {
  const [selectedAsset, setSelectedAsset] = useState(null);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [hasResult, setHasResult] = useState(false);
  const [records, setRecords] = useState([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isLoadingRecords, setIsLoadingRecords] = useState(true);

  // Uygulama açılışında, daha önce kaydedilmiş formları Supabase'den çek.
  // Bu sayede kayıtlar sadece bu oturumda değil, uygulama kapatılıp açılsa
  // da (hatta başka bir cihazda) kalıcı olarak görünür.
  // NOT: Burada SADECE aktif kayıtlar (is_deleted = false) çekilir; "Sil"
  // butonuyla yumuşak-silinmiş (soft-deleted) kayıtlar bu listede ASLA
  // görünmez, ama veritabanından da hiçbir zaman kalıcı olarak silinmezler
  // (bkz. handleDeleteRecord ve /excel-feed.csv canlı dışa aktarma akışı).
  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const { data, error } = await supabase
          .from(SUPABASE_TABLE)
          .select('*')
          .eq('is_deleted', false)
          .order('id', { ascending: false });
        if (error) throw error;
        if (isMounted && data) {
          setRecords(data.map(mapSupabaseRowToRecord));
        }
      } catch (error) {
        // Liste boş kalır; kullanıcı Alert ile ayrıca bilgilendirilmez (sessiz
        // açılış). Ağ yoksa yerel boş liste ile devam edilir.
      } finally {
        if (isMounted) {
          setIsLoadingRecords(false);
          SplashScreen.hideAsync().catch(() => {});
        }
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  const updateField = (key, value) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  const handlePickImage = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('İzin Gerekli', 'Fotoğraf seçebilmek için galeri erişim izni vermelisiniz.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.8,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      setSelectedAsset(result.assets[0]);
      setFormData(EMPTY_FORM);
      setHasResult(false);
    } catch (error) {
      Alert.alert('Hata', 'Fotoğraf seçilirken bir sorun oluştu: ' + error.message);
    }
  };

  // Analiz için gönderilecek görseli, okuma (OCR) hassasiyetini bozmadan
  // küçültüp sıkıştırır: en uzun kenar MAX_ANALYSIS_DIMENSION ile sınırlanır
  // (küçük görseller büyütülmez, en-boy oranı korunur) ve %75 JPEG kalitesiyle
  // yeniden kodlanır. Form yapısı/okuma mantığı değişmez; sadece iletilen
  // dosyanın boyutu küçülür.
  const optimizeImageForAnalysis = async (asset) => {
    const context = ImageManipulator.manipulate(asset.uri);
    const { width, height } = asset;

    if (width && height) {
      if (width >= height && width > MAX_ANALYSIS_DIMENSION) {
        context.resize({ width: MAX_ANALYSIS_DIMENSION });
      } else if (height > width && height > MAX_ANALYSIS_DIMENSION) {
        context.resize({ height: MAX_ANALYSIS_DIMENSION });
      }
      // İki boyut da sınırın altındaysa hiç resize uygulanmaz (büyütme yok).
    } else {
      // Boyut bilgisi gelmemişse güvenli tarafta kalıp genişliği sınırla;
      // tek boyut verildiği için en-boy oranı otomatik korunur.
      context.resize({ width: MAX_ANALYSIS_DIMENSION });
    }

    const renderedImage = await context.renderAsync();
    const result = await renderedImage.saveAsync({
      compress: ANALYSIS_JPEG_QUALITY,
      format: SaveFormat.JPEG,
    });

    context.release();
    renderedImage.release();

    return result;
  };

  const handleAnalyze = async () => {
    if (!selectedAsset) {
      Alert.alert('Uyarı', 'Önce galeriden bir otopark formu fotoğrafı seçin.');
      return;
    }

    setIsAnalyzing(true);

    try {
      const optimized = await optimizeImageForAnalysis(selectedAsset);
      const imageFile = new File(optimized.uri);
      const base64Image = await imageFile.base64();
      if (!base64Image) {
        throw new Error('Görsel base64 formatına dönüştürülemedi.');
      }

      const response = await axios.post(
        SERVER_ANALYZE_URL,
        { base64Image },
        { timeout: SERVER_REQUEST_TIMEOUT_MS }
      );

      const payload = response.data;
      if (!payload || payload.success !== true || !payload.data || typeof payload.data !== 'object') {
        throw new Error('Sunucudan geçersiz yanıt alındı.');
      }

      setFormData(mapServerResponseToFormData(payload.data));
      setHasResult(true);
    } catch (error) {
      setFormData(EMPTY_FORM);
      setHasResult(true);

      // Sunucu gerçekten yanıt verdiyse (ör. Gemini kota hatası nedeniyle 503),
      // bu bir bağlantı sorunu değildir; kullanıcıya sunucunun bildirdiği asıl
      // sebebi göstermek "sunucuya bağlanılamadı" demekten çok daha doğru olur.
      const serverMessage = error?.response?.data?.error;
      if (serverMessage) {
        Alert.alert('Analiz Başarısız', serverMessage);
      } else {
        Alert.alert('Sunucuya Bağlanılamadı', getServerConnectionErrorMessage(error));
      }
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Kullanıcı orijinal (taranan kağıt) fotoğrafı değil, form alanlarının
  // düz yazıyla göründüğü beyaz bir "sayfa" görseli istiyor. Bunu, sunucunun
  // /form-image uç noktasından JPEG olarak alıp yerel arşiv klasörüne
  // kaydediyoruz. Sunucuya ulaşılamazsa, en azından bir şey kaydedilmiş olsun
  // diye orijinal fotoğrafla devam ediyoruz.
  const generateFormImageFile = async () => {
    const archiveDir = new Directory(Paths.document, 'otopark_arsiv');
    if (!archiveDir.exists) {
      archiveDir.create({ intermediates: true, idempotent: true });
    }
    const fileName = `${sanitizeForFileName(formData.plaka || formData.formNo)}_${timestampSuffix()}.jpeg`;

    try {
      const response = await axios.post(
        SERVER_FORM_IMAGE_URL,
        { formData },
        { timeout: SERVER_REQUEST_TIMEOUT_MS, responseType: 'arraybuffer' }
      );
      const bytes = new Uint8Array(response.data);
      if (!bytes || bytes.length < 100) {
        throw new Error('Sunucudan gelen form görseli boş/bozuk.');
      }

      const imageFile = new File(archiveDir, fileName);
      if (imageFile.exists) {
        imageFile.delete();
      }
      imageFile.create();
      imageFile.write(bytes);
      return imageFile.uri;
    } catch (error) {
      Alert.alert(
        'Form Görseli Oluşturulamadı',
        'Form bilgilerinden beyaz sayfa görseli oluşturulamadı (sunucuya ulaşılamamış olabilir); onun yerine orijinal fotoğraf kullanılacak.'
      );

      // Yedek plan: orijinal fotoğrafı kopyala.
      try {
        const sourceFile = new File(selectedAsset.uri);
        const destinationFile = new File(archiveDir, fileName);
        sourceFile.copySync(destinationFile, { overwrite: true });
        return destinationFile.uri;
      } catch (copyError) {
        return selectedAsset.uri;
      }
    }
  };

  // Verilen görseli önce doğrudan (sessizce) telefonun galerisine kaydetmeyi
  // dener; Expo Go'nun Android'de tam medya kütüphanesi erişimini engellediği
  // durumlarda (bkz. requestPermissionsAsync reddi), kullanıcının görseli
  // manuel olarak kaydedebilmesi için sistemin paylaşım ekranına düşer.
  const saveImageToGalleryOrShare = async (localUri, dialogTitle) => {
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync(false, ['photo']);
      if (status === 'granted') {
        await MediaLibrary.createAssetAsync(localUri);
        return;
      }
    } catch (e) {
      // Expo Go / kısıtlı izinlerde doğrudan galeri kaydı başarısız olabilir;
      // aşağıdaki paylaşım ekranına düşülür.
    }

    try {
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await new Promise((resolve) => {
          Alert.alert(
            'Galeriye Kaydet',
            'Açılacak ekrandan "Kaydet", "Dosyalara Kaydet" veya "Fotoğraflar/Galeri" seçeneğine dokunarak görseli telefonunuza .jpeg olarak kaydedebilirsiniz.',
            [{ text: 'Devam Et', onPress: resolve }],
            { cancelable: false }
          );
        });
        await Sharing.shareAsync(localUri, { mimeType: 'image/jpeg', dialogTitle });
      } else {
        Alert.alert(
          'Paylaşım Kullanılamıyor',
          `Görsel otomatik olarak galeriye kaydedilemedi. Dosya şu konumda saklanıyor: ${localUri}`
        );
      }
    } catch (e) {
      Alert.alert('Paylaşım Hatası', e?.message || 'Paylaşım ekranı açılamadı.');
    }
  };

  const archiveImage = async () => {
    const localUri = await generateFormImageFile();
    await saveImageToGalleryOrShare(localUri, 'Form Görselini Galeriye Kaydet / Paylaş');
    return localUri;
  };

  const handleSaveRecord = async () => {
    if (!selectedAsset) {
      Alert.alert('Uyarı', 'Kaydedilecek bir fotoğraf bulunamadı.');
      return;
    }

    const isEmpty = FIELD_LABELS.every((field) => !formData[field.key]?.trim());
    if (isEmpty) {
      Alert.alert('Uyarı', 'Kaydetmeden önce en az bir alanı doldurun.');
      return;
    }

    // Not: Aşağıdaki adımlar (arşivleme, Supabase) BİLEREK ayrı try/catch
    // bloklarına ayrıldı. Böylece biri başarısız olsa diğeri yine denenebilir.

    // 1) Fotoğrafı/form görselini arşivle. Başarısız olursa akışı DURDURMUYORUZ;
    // en azından Supabase kaydı denensin diye archivedUri'yi boş bırakıp devam ediyoruz.
    let archivedUri = null;
    try {
      archivedUri = await archiveImage();
    } catch (archiveError) {
      Alert.alert(
        'Arşivleme Uyarısı',
        'Form görseli telefona kaydedilemedi ancak form verisi buluta kaydedilmeye devam edilecek: ' +
          (archiveError?.message || 'Bilinmeyen hata')
      );
    }

    const newRecord = {
      id: `${generateUniqueRecordId()}`,
      ...formData,
      archivedUri,
    };

    // 2) Supabase'e kaydet. DİKKAT: Burada HER ZAMAN .insert() kullanılır;
    // aynı plaka/form no daha önce onlarca kez girilmiş olsa bile bu KESİNLİKLE
    // yeni bir satır olarak eklenir (asla var olan bir satırı güncellemez).
    let supabaseRow = mapRecordToSupabaseRow(newRecord);
    let cloudSaveError = null;
    try {
      let { error } = await supabase.from(SUPABASE_TABLE).insert(supabaseRow);

      // "23505" = Postgres unique_violation. id üretimi (bkz.
      // generateUniqueRecordId) çakışma ihtimalini pratikte sıfıra
      // indiriyor olsa da, olası bir çakışmada kaydın sessizce kaybolmaması
      // için yeni bir id ile BİR KEZ daha deniyoruz.
      if (error?.code === '23505') {
        newRecord.id = `${generateUniqueRecordId()}`;
        supabaseRow = mapRecordToSupabaseRow(newRecord);
        ({ error } = await supabase.from(SUPABASE_TABLE).insert(supabaseRow));
      }

      if (error) {
        cloudSaveError = error;
      }
    } catch (error) {
      cloudSaveError = error;
    }

    setRecords((prev) => [newRecord, ...prev]);
    setSelectedAsset(null);
    setFormData(EMPTY_FORM);
    setHasResult(false);

    if (cloudSaveError) {
      Alert.alert('Supabase Hatası', cloudSaveError.message);
    } else {
      Alert.alert('Başarılı', 'Form başarıyla arşivlendi, listeye eklendi ve buluta kaydedildi!');
    }
    // NOT: Excel'e otomatik/arka planda yazma YOKTUR. Kayıt burada sadece
    // Supabase'e düşer; Excel dosyası ancak kullanıcı "Excel Dosyasını İndir /
    // Paylaş" butonuna bastığında, o anki tüm Supabase verisiyle anlık olarak
    // üretilir (bkz. handleExportExcel).
  };

  // YUMUŞAK SİLME (SOFT DELETE): "Sil" butonu veriyi veritabanından KALICI
  // OLARAK asla silmez (HARD DELETE yapılmaz). Sadece is_deleted = true
  // olarak işaretlenir; böylece kayıt "Kaydedilen Formlar" listesinden
  // kaybolur ama veritabanında ve Excel canlı arşivinde (bkz. /excel-feed.csv)
  // kalıcı olarak kalmaya
  // devam eder.
  const handleDeleteRecord = async (id) => {
    setRecords((prev) => prev.filter((record) => record.id !== id));
    try {
      const { error } = await supabase
        .from(SUPABASE_TABLE)
        .update({ is_deleted: true })
        .eq('id', Number(id));
      if (error) throw error;
    } catch (error) {
      Alert.alert(
        'Bulut Silme Başarısız',
        'Kayıt listeden kaldırıldı ancak buluttaki durumu güncellenemedi: ' + (error?.message || 'Bilinmeyen hata')
      );
    }
  };

  const handleExportExcel = async () => {
    setIsExporting(true);
    try {
      // Artık /export endpoint'i, içinde canlı web sorgusu gömülü hazır .xlsx
      // dosyasını doğrudan döndürüyor. Kullanıcı dosyayı bir kez indirip
      // bilgisayarda "Tümü Yenile" ile güncel veriyi çekebilir.
      const response = await axios.get(
        SERVER_EXPORT_URL,
        { timeout: SERVER_REQUEST_TIMEOUT_MS, responseType: 'arraybuffer' }
      );

      const outBytes = new Uint8Array(response.data);
      if (!outBytes || outBytes.length < 1000) {
        throw new Error('Sunucudan gelen Excel dosyası beklenenden çok küçük/boş.');
      }

      // Sabit dosya adı: kullanıcı bu dosyayı bir kez indirip bilgisayarda
      // kullanır. Dosyanın içinde canlı web sorgusu gömülü olduğu için
      // (excel-feed.csv), uygulamadan her seferinde tekrar indirmeye gerek
      // kalmadan Excel'de "Tümü Yenile" ile güncel veri çekilebilir.
      const excelFile = new File(Paths.cache, 'HİZMET ARAÇLARI TAKİP FORMU.xlsx');
      if (excelFile.exists) {
        excelFile.delete();
      }
      excelFile.create();
      excelFile.write(outBytes);

      Alert.alert(
        'Excel Hazır',
        'Bu dosya canlı veriye bağlıdır. Bilgisayarda dosyayı açtıktan sonra "Veri > Tümü Yenile" ile Supabase\'deki en güncel kayıtları çekebilirsiniz.'
      );

      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(excelFile.uri, {
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          dialogTitle: 'Excel Dosyasını İndir / Paylaş',
        });
      } else {
        Alert.alert('Kaydedildi', `Excel dosyası kaydedildi: ${excelFile.uri}`);
      }
    } catch (error) {
      Alert.alert(
        'Sunucuya Bağlanılamadı',
        `Excel oluşturulamadı. ${getServerConnectionErrorMessage(error)}`
      );
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right', 'bottom']}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        style={styles.flex1}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Text style={styles.headerTitle}>🅿️ Otopark Formu Tarama</Text>
            <Text style={styles.headerSubtitle}>
              Fotoğrafı seç, oku, bilgileri kontrol et ve Excel'e dök
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>1. Form Fotoğrafı</Text>
            <View style={styles.imagePreviewWrapper}>
              {selectedAsset ? (
                <Image
                  source={{ uri: selectedAsset.uri }}
                  style={styles.imagePreview}
                  resizeMode="contain"
                />
              ) : (
                <View style={styles.imagePlaceholder}>
                  <Text style={styles.imagePlaceholderText}>📷</Text>
                  <Text style={styles.imagePlaceholderLabel}>Henüz fotoğraf seçilmedi</Text>
                </View>
              )}
            </View>

            <TouchableOpacity style={styles.secondaryButton} onPress={handlePickImage}>
              <Text style={styles.secondaryButtonText}>Galeriden Fotoğraf Seç</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.primaryButton,
                (!selectedAsset || isAnalyzing) && styles.disabledButton,
              ]}
              onPress={handleAnalyze}
              disabled={!selectedAsset || isAnalyzing}
            >
              {isAnalyzing ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.primaryButtonText}>✨ Formu Oku</Text>
              )}
            </TouchableOpacity>
          </View>

          {hasResult && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>2. Form Bilgileri</Text>
              <Text style={styles.cardHint}>
                Okunan bilgileri kontrol edin ve gerekirse elle düzenleyin.
              </Text>

              {FIELD_LABELS.map((field) => (
                <View key={field.key} style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>{field.label}</Text>
                  <TextInput
                    style={styles.input}
                    value={formData[field.key]}
                    onChangeText={(text) => updateField(field.key, text)}
                    placeholder={field.placeholder}
                    placeholderTextColor="#A0A6B8"
                    keyboardType={field.keyboardType}
                    autoCapitalize={field.autoCapitalize}
                  />
                </View>
              ))}

              <TouchableOpacity style={styles.successButton} onPress={handleSaveRecord}>
                <Text style={styles.successButtonText}>💾 Kaydet ve Arşivle</Text>
              </TouchableOpacity>
            </View>
          )}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              3. Kaydedilen Formlar ({records.length})
            </Text>
            {isLoadingRecords ? (
              <ActivityIndicator color="#4F46E5" style={{ marginVertical: 12 }} />
            ) : records.length === 0 ? (
              <Text style={styles.cardHint}>Henüz kaydedilmiş form yok.</Text>
            ) : (
              records.map((record) => (
                <View key={record.id} style={styles.recordRow}>
                  <View style={styles.recordInfo}>
                    <Text style={styles.recordPlate}>
                      #{record.formNo || '-'} · {record.plaka || 'Plaka yok'}
                    </Text>
                    <Text style={styles.recordSub}>
                      {record.cikisSaati || '--:--'} → {record.donusSaati || '--:--'} ·{' '}
                      {record.surucuAdi || '-'}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.deleteButton}
                    onPress={() => handleDeleteRecord(record.id)}
                  >
                    <Text style={styles.deleteButtonText}>Sil</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}

            <TouchableOpacity
              style={[
                styles.exportButton,
                isExporting && styles.disabledButton,
              ]}
              onPress={handleExportExcel}
              disabled={isExporting}
            >
              {isExporting ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.exportButtonText}>
                  📊 Excel Dosyasını İndir / Paylaş
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#F2F4F9' },
  flex1: { flex: 1 },
  scrollContent: { padding: 20, paddingBottom: 40 },
  header: { marginBottom: 20 },
  headerTitle: { fontSize: 24, fontWeight: '700', color: '#1A1D29' },
  headerSubtitle: { fontSize: 14, color: '#6B7280', marginTop: 4 },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 18,
    marginBottom: 18,
    shadowColor: '#1A1D29',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 3,
  },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#1A1D29', marginBottom: 6 },
  cardHint: { fontSize: 13, color: '#8A8F9E', marginBottom: 12 },
  imagePreviewWrapper: {
    width: '100%',
    height: 260,
    borderRadius: 14,
    backgroundColor: '#EEF1F7',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  imagePreview: {
    width: '100%',
    height: '100%',
  },
  imagePlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#E2E6F0',
    borderStyle: 'dashed',
    borderRadius: 14,
  },
  imagePlaceholderText: { fontSize: 36, marginBottom: 6 },
  imagePlaceholderLabel: { fontSize: 13, color: '#9AA0B4' },
  primaryButton: {
    backgroundColor: '#4F46E5',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  secondaryButton: {
    backgroundColor: '#EEF1FF',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  secondaryButtonText: { color: '#4F46E5', fontSize: 15, fontWeight: '600' },
  successButton: {
    backgroundColor: '#16A34A',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 6,
  },
  successButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  exportButton: {
    backgroundColor: '#EA580C',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  exportButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  disabledButton: { opacity: 0.5 },
  fieldGroup: { marginBottom: 14 },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: '#4B5160', marginBottom: 6 },
  input: {
    backgroundColor: '#F7F8FC',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: '#1A1D29',
    borderWidth: 1,
    borderColor: '#E2E6F0',
  },
  recordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F7F8FC',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
  },
  recordInfo: { flex: 1, marginRight: 10 },
  recordPlate: { fontSize: 15, fontWeight: '700', color: '#1A1D29' },
  recordSub: { fontSize: 12, color: '#8A8F9E', marginTop: 2 },
  deleteButton: {
    backgroundColor: '#FEE2E2',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  deleteButtonText: { color: '#DC2626', fontSize: 12, fontWeight: '700' },
});