import React, { useState } from 'react';
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
import { File, Directory, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library';
import axios from 'axios';

const GALLERY_ALBUM_NAME = 'Otopark Formları';

// Gerçek Wi-Fi IPv4 Adresin (192.168.8.104) güncellendi.
const SERVER_BASE_URL = 'http://192.168.8.104:3000';
const SERVER_ANALYZE_URL = `${SERVER_BASE_URL}/analyze`;
const SERVER_EXPORT_URL = `${SERVER_BASE_URL}/export`;

const EMPTY_FORM = {
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

function mapServerResponseToFormData(data) {
  return {
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

  const handleAnalyze = async () => {
    if (!selectedAsset) {
      Alert.alert('Uyarı', 'Önce galeriden bir otopark formu fotoğrafı seçin.');
      return;
    }

    setIsAnalyzing(true);

    try {
      const imageFile = new File(selectedAsset.uri);
      const base64Image = await imageFile.base64();
      if (!base64Image) {
        throw new Error('Görsel base64 formatına dönüştürülemedi.');
      }

      const response = await axios.post(
        SERVER_ANALYZE_URL,
        { base64Image },
        { timeout: 35000 }
      );

      const payload = response.data;
      if (!payload || payload.success !== true || !payload.data || typeof payload.data !== 'object') {
        throw new Error('Sunucudan geçersiz yanıt alındı.');
      }

      setFormData(mapServerResponseToFormData(payload.data));
      setHasResult(true);
    } catch (error) {
      console.error(
        'Sunucu isteği başarısız oldu:',
        error?.response?.data || error?.message || error
      );
      setFormData(EMPTY_FORM);
      setHasResult(true);
      Alert.alert(
        'Sunucuya Bağlanılamadı',
        'Bilgisayarındaki sunucuya (192.168.8.104:3000) erişilemedi. Terminalde "node server.js" komutunun açık olduğundan ve telefonunla bilgisayarının aynı Wi-Fi ağına bağlı olduğundan emin ol.'
      );
    } finally {
      setIsAnalyzing(false);
    }
  };

  const archiveImage = () => {
    try {
      const archiveDir = new Directory(Paths.document, 'otopark_arsiv');
      if (!archiveDir.exists) {
        archiveDir.create({ intermediates: true, idempotent: true });
      }

      const fileName = `${sanitizeForFileName(formData.plaka || formData.formNo)}_${timestampSuffix()}.jpeg`;
      const sourceFile = new File(selectedAsset.uri);
      const destinationFile = new File(archiveDir, fileName);
      sourceFile.copySync(destinationFile, { overwrite: true });
      return destinationFile.uri;
    } catch (e) {
      return selectedAsset.uri;
    }
  };

  const saveImageToGallery = async (localUri) => {
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync(true);
      if (status !== 'granted') {
        console.warn('Galeri izni verilmedi:', status);
        return { ok: false, reason: 'İzin verilmedi.' };
      }

      // Not: expo-media-library'nin yeni sınıf tabanlı Asset/Album API'si
      // (Asset.create, Album.get/create) henüz yayınlanan pakette yok;
      // bu yüzden mevcut fonksiyon tabanlı (legacy) API kullanılıyor.
      const asset = await MediaLibrary.createAssetAsync(localUri);
      const existingAlbum = await MediaLibrary.getAlbumAsync(GALLERY_ALBUM_NAME);
      if (existingAlbum) {
        await MediaLibrary.addAssetsToAlbumAsync([asset], existingAlbum, false);
      } else {
        await MediaLibrary.createAlbumAsync(GALLERY_ALBUM_NAME, asset, false);
      }
      return { ok: true };
    } catch (e) {
      console.error('Galeriye kaydetme hatası:', e?.message || e);
      return { ok: false, reason: e?.message || 'Bilinmeyen hata' };
    }
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

    try {
      const archivedUri = archiveImage();
      const galleryResult = await saveImageToGallery(archivedUri);

      const newRecord = {
        id: `${Date.now()}`,
        ...formData,
        archivedUri,
      };
      setRecords((prev) => [newRecord, ...prev]);
      setSelectedAsset(null);
      setFormData(EMPTY_FORM);
      setHasResult(false);
      Alert.alert(
        'Başarılı',
        galleryResult.ok
          ? `Form listeye eklendi ve fotoğraf telefonunuzun galerisine "${GALLERY_ALBUM_NAME}" albümüne .jpeg olarak kaydedildi.`
          : `Form listeye eklendi ancak fotoğraf galeriye kaydedilemedi: ${galleryResult.reason}`
      );
    } catch (error) {
      Alert.alert('Hata', 'Form kaydedilirken bir sorun oluştu: ' + error.message);
    }
  };

  const handleDeleteRecord = (id) => {
    setRecords((prev) => prev.filter((record) => record.id !== id));
  };

  const handleExportExcel = async () => {
    if (records.length === 0) {
      Alert.alert('Uyarı', 'Excel oluşturmak için en az bir kayıtlı form gerekli.');
      return;
    }

    setIsExporting(true);
    try {
      // Excel'i telefonda değil, bilgisayardaki sunucuda (Node.js) oluşturuyoruz.
      // SheetJS bu boyuttaki (binlerce satırlı) şablonu React Native/Hermes
      // ortamında güvenilir işleyemiyor; sunucuda ise defalarca doğrulandı.
      const chronologicalRecords = [...records].reverse();

      const response = await axios.post(
        SERVER_EXPORT_URL,
        { records: chronologicalRecords },
        { timeout: 60000, responseType: 'arraybuffer' }
      );

      const outBytes = new Uint8Array(response.data);
      if (!outBytes || outBytes.length < 1000) {
        throw new Error('Sunucudan gelen Excel dosyası beklenenden çok küçük/boş.');
      }

      // Sunucu, yeni kaydın şablonda tam olarak hangi satır(lar)a düştüğünü
      // header'larla bildiriyor. Aynı plaka/form no şablonda daha önce onlarca
      // kez geçebildiği için (Ctrl+F ile ararken eski bir kayda denk gelinebilir),
      // bunu kullanıcıya açıkça göstermek karışıklığı önlüyor.
      const rowStart = response.headers?.['x-new-row-start'];
      const rowEnd = response.headers?.['x-new-row-end'];
      const rowInfo =
        rowStart && rowEnd
          ? rowStart === rowEnd
            ? `Yeni kaydınız Excel'in ${rowStart}. satırına eklendi.`
            : `Yeni kayıtlarınız Excel'in ${rowStart}-${rowEnd}. satırlarına eklendi.`
          : null;

      const excelFile = new File(Paths.cache, `otopark_formlari_${timestampSuffix()}.xlsx`);
      if (excelFile.exists) {
        excelFile.delete();
      }
      excelFile.create();
      excelFile.write(outBytes);

      if (rowInfo) {
        Alert.alert(
          'Excel Hazır',
          `${rowInfo}\n\nNot: Aynı plaka/form no şablonda daha önce de geçmiş olabilir; "Bul" (Ctrl+F) ile ararsanız eski bir kayda denk gelebilirsiniz. En güvenilir yöntem doğrudan bu satır numarasına gitmek veya Ctrl+End ile dosyanın sonuna atlamaktır.`
        );
      }

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
      console.error('Excel export hatası:', error?.response?.data || error?.message || error);
      Alert.alert(
        'Sunucuya Bağlanılamadı',
        'Excel oluşturulamadı. Bilgisayarındaki sunucuya (192.168.8.104:3000) erişilemedi olabilir. Terminalde "node server.js" komutunun açık olduğundan ve telefonunla bilgisayarının aynı Wi-Fi ağına bağlı olduğundan emin ol.'
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
            {records.length === 0 ? (
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
                (records.length === 0 || isExporting) && styles.disabledButton,
              ]}
              onPress={handleExportExcel}
              disabled={records.length === 0 || isExporting}
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