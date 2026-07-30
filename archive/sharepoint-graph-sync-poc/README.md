# Arşiv: SharePoint / Microsoft Graph API Senkronizasyonu (Şu An Kullanılmıyor)

Bu klasör, Supabase → SharePoint Excel dosyası arasında **gerçek zamanlı,
tam otomatik bulut-bulut senkronizasyon** kurmak için hazırlanmış ama
**şu an için devre dışı bırakılmış** çalışmayı içerir.

## Neden arşivlendi?

Bu entegrasyon; IT departmanından Azure AD App Registration, API izni
(`Sites.Selected` veya `Files.ReadWrite.All`) ve admin onayı gerektiriyordu.
Karar: IT bu tarafı ileride kendisi ele alacak. Şimdilik daha basit bir
çözüm (proje kökündeki `export_to_excel.py` betiği) kullanılıyor — Supabase
verilerini doğrudan "HİZMET ARAÇLARI TAKİP FORMU.xlsx" dosyasına yazıyor.

## İçindekiler

- `it-microsoft-graph-gereksinimleri.md` — IT departmanına iletilmek üzere
  hazırlanmış, Azure AD/Graph API kurulum adımlarını içeren doküman.
- `supabase-functions/sync-to-sharepoint-excel/index.ts` — Microsoft Graph
  API üzerinden SharePoint'teki Excel dosyasına satır ekleyen, hiç deploy
  edilmemiş Supabase Edge Function taslağı.

## İleride tekrar devreye almak isterseniz

1. `it-microsoft-graph-gereksinimleri.md` dosyasını IT departmanına iletin.
2. IT'den gelen bilgilerle `supabase-functions/sync-to-sharepoint-excel`
   klasörünü `supabase/functions/sync-to-sharepoint-excel` altına geri taşıyın.
3. Supabase'de gerekli "secrets" değerlerini tanımlayıp fonksiyonu deploy edin
   ve bir Database Webhook ile bağlayın (dokümandaki Bölüm 7).

Bu klasördeki kod/doküman şu anki `export_to_excel.py` akışını **etkilemez**;
tamamen bağımsızdır.
