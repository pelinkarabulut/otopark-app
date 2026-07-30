# Otopark Formu → SharePoint Excel Otomatik Senkronizasyonu
### IT / Bilgi İşlem Departmanı için Teknik Gereksinim ve Kurulum Belgesi

## 1. Amaç

Mobil "Otopark Formu" uygulamasından girilen araç kullanım kayıtları şu anda
bulut veritabanımız olan **Supabase**'e (`otopark_formlari` tablosu) anlık
olarak yazılıyor. Bu belgenin amacı, bu kayıtların **hiçbir manuel işlem
(script çalıştırma, kopyala-yapıştır) olmadan**, otomatik olarak şirketin
SharePoint/OneDrive üzerinde duran **"HİZMET ARAÇLARI TAKİP FORMU.xlsx"**
dosyasına yazılmasını sağlamaktır.

## 2. Mimari Özeti (Cloud-to-Cloud)

```
[Mobil Uygulama]
      │  (yeni kayıt)
      ▼
[Supabase Veritabanı] ──(Database Webhook, INSERT anında)──▶ [Supabase Edge Function]
                                                                     │
                                                                     │  Microsoft Graph API
                                                                     │  (OAuth2 Client Credentials)
                                                                     ▼
                                                    [SharePoint / OneDrive]
                                                    HİZMET ARAÇLARI TAKİP FORMU.xlsx
                                                    (Excel Tablosuna yeni satır eklenir)
```

Ayrıca, ağ kesintisi vb. nadir bir durumda webhook'un kaçırdığı bir kayıt
olursa diye **periyodik bir "güvenlik ağı" (reconciliation sweep)** taraması
da aynı fonksiyon üzerinden çalışacak şekilde tasarlandı: Supabase'de henüz
Excel'e yazılmamış (`excel_synced_at IS NULL`) kayıtları bulup toplu olarak
tamamlar.

## 3. Önemli: Ağ/Firewall Tarafında HİÇBİR Değişiklik Gerekmiyor

Bu mimarideki her iki taraf da (**Supabase** ve **Microsoft 365/SharePoint**)
bulut servisidir; aralarındaki iletişim tamamen internet üzerinden,
bulut-to-bulut gerçekleşir. Yani:

- Şirketin **yerel ağında/firewall'unda hiçbir port açılmasına** gerek yoktur.
- Şirket bilgisayarlarının **sürekli açık/çalışır** olması gerekmez.
- Herhangi bir sunucunun şirket binasında barındırılmasına gerek yoktur.

IT departmanından istenen tek şey, aşağıdaki **Azure AD (Microsoft Entra ID)**
yapılandırmasıdır — bu tamamen bir "kimlik/izin" (identity) işlemidir, ağ
altyapısıyla ilgisi yoktur.

## 4. IT Departmanından İstenen Somut Adımlar

### 4.1. Azure AD (Entra ID) App Registration Oluşturma

1. [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. İsim: `Otopark Formu - Excel Sync` (veya kurumsal standardınıza uygun bir ad).
3. "Supported account types": **Single tenant** (sadece bu kuruluş) seçilmeli.
4. Redirect URI: **Gerekli değil** (bu uygulama kullanıcı girişi yapmayacak, arka planda "app-only" çalışacak).
5. Kaydettikten sonra şu 2 değeri not edin (bize iletilecek — bkz. Bölüm 6):
   - **Application (client) ID**
   - **Directory (tenant) ID**

### 4.2. Client Secret Oluşturma

1. Oluşturulan App Registration → **Certificates & secrets** → **New client secret**.
2. Açıklama: `otopark-excel-sync` ve son kullanma tarihi (öneri: 12-24 ay; süresi
   dolduğunda IT'nin bize haber vermesi ve yeni bir secret oluşturması gerekir).
3. Oluşturulan **secret DEĞERİNİ** (Value, sadece bir kez gösterilir) not edin.

### 4.3. API İzni (Permission) Ekleme — İki Seçenek

Uygulamanın Excel dosyasına yazabilmesi için **Application permission**
(kullanıcı girişi olmadan, "app-only") türünde bir Microsoft Graph izni
gerekiyor. İki seçenek var; **A seçeneği önerilir** (en az yetki prensibi):

**A) `Sites.Selected` (ÖNERİLEN — güvenli, dar kapsamlı)**
Uygulamaya SADECE belirteceğimiz TEK bir SharePoint sitesine erişim izni
verir; tenant'taki diğer hiçbir dosya/siteye erişemez.

1. App Registration → **API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions** → `Sites.Selected` seçilir → **Add permissions**.
2. **Grant admin consent for [Kuruluş Adı]** butonuna basılır (Global/Application Administrator yetkisi gerekir).
3. Bu izin sadece "izin verilebilir" hale getirir; hangi siteye erişileceğini belirtmek için AŞAĞIDAKİ ek adım gerekir (bu, portalde değil PowerShell/Graph Explorer üzerinden yapılır):

```powershell
# PnP.PowerShell modülü ile (Install-Module PnP.PowerShell)
Connect-PnPOnline -Url "https://<kuruluşadı>.sharepoint.com/sites/<site-adi>" -Interactive
Grant-PnPAzureADAppSitePermission `
  -AppId "<Application (client) ID>" `
  -DisplayName "Otopark Formu - Excel Sync" `
  -Site "https://<kuruluşadı>.sharepoint.com/sites/<site-adi>" `
  -Permissions Write
```

**B) `Files.ReadWrite.All` (DAHA BASİT, ama daha geniş kapsamlı)**
Uygulamaya tenant'taki (izin verilen kullanıcılar kadar) TÜM SharePoint/
OneDrive dosyalarına erişim izni verir. Kurulumu daha hızlıdır (tek tıkla
admin consent yeterli, 4.3.A'daki ek PowerShell adımı gerekmez) ama güvenlik
açısından daha geniş yetki verir. IT, hız/güvenlik dengesine göre bu
seçeneği tercih edebilir.

1. App Registration → **API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions** → `Files.ReadWrite.All` → **Add permissions**.
2. **Grant admin consent** butonuna basılır.

### 4.4. Hedef Dosyanın Kimliklerini Bulma

Aşağıdaki bilgiler bizim (geliştirici) tarafımızdan [Microsoft Graph
Explorer](https://developer.microsoft.com/en-us/graph/graph-explorer) ile
bulunabilir; IT'nin bunu yapması ZORUNLU DEĞİLDİR, sadece dosyanın tam
SharePoint site adresini bize iletmesi yeterlidir:

- **HİZMET ARAÇLARI TAKİP FORMU.xlsx** dosyasının bulunduğu SharePoint site
  adresi (örn. `https://<kuruluşadı>.sharepoint.com/sites/<site-adi>`).

## 5. Excel Dosyası Tarafında Gereken Tek Hazırlık (IT değil, dosya sahibi yapar)

Microsoft Graph API'nin satır ekleyebilmesi için, verinin bulunduğu aralığın
bir **Excel Tablosu (Table)** olarak tanımlanmış olması gerekir (düz veri
aralığı yeterli değildir):

1. Excel'de veri aralığını seçin → **Ekle (Insert) → Tablo (Table)** (veya `Ctrl+T`).
2. Oluşan tabloya **Tablo Tasarımı (Table Design) → Tablo Adı** kısmından
   anlaşılır bir ad verin (örn. `HizmetAraclariTablosu`).
3. Bu tablo adını bize iletin (Edge Function'ın `EXCEL_TABLE_NAME` ayarına
   girilecek).

## 6. Bize (Geliştirici) İletilmesi Gereken Bilgiler — Özet Kontrol Listesi

- [ ] Directory (Tenant) ID
- [ ] Application (Client) ID
- [ ] Client Secret değeri (güvenli bir kanaldan — örn. şifreli e-posta/parola yöneticisi ile)
- [ ] Seçilen izin modeli: `Sites.Selected` mi yoksa `Files.ReadWrite.All` mi?
- [ ] SharePoint site adresi (`https://<kuruluşadı>.sharepoint.com/sites/<site-adi>`)
- [ ] Excel dosyasındaki tablo adı (Bölüm 5'te verilen ad)
- [ ] Client secret'ın son kullanma tarihi (yenileme takibi için)

## 7. Bizim (Geliştirici) Tarafımızda Yapılacaklar (IT bilgisi için referans)

Bu bölüm sadece bilgilendirme amaçlıdır, IT'nin bir aksiyonu gerekmez:

1. Yukarıdaki bilgiler Supabase projesine "secret" (şifreli ortam değişkeni)
   olarak eklenecek (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
   `AZURE_CLIENT_SECRET`, `SHAREPOINT_SITE_ID`, `SHAREPOINT_DRIVE_ITEM_ID`,
   `EXCEL_TABLE_NAME`).
2. Hazırlanmış olan `supabase/functions/sync-to-sharepoint-excel` fonksiyonu
   Supabase'e deploy edilecek.
3. Supabase Dashboard'da bir **Database Webhook** tanımlanacak: `otopark_formlari`
   tablosuna INSERT olduğunda bu fonksiyonu çağırır.
4. (Opsiyonel, ek güvenlik ağı) Periyodik bir "sweep" çağrısı (örn. her 15
   dakikada bir) ayarlanacak; böylece webhook'un kaçırdığı olası bir kayıt da
   otomatik tamamlanır.

## 8. Güvenlik Notları

- Client secret, sadece Supabase'in şifreli "Secrets" deposunda saklanacak;
  koda veya git deposuna asla eklenmeyecektir.
- `Sites.Selected` modeli seçilirse, uygulama SADECE belirtilen tek siteye
  erişebilir — bu, "en az yetki" (least privilege) prensibine uygundur ve
  önerilen seçenektir.
- Client secret'ın belirli bir son kullanma tarihi vardır; süresi dolmadan
  IT'nin yeni bir secret oluşturup bize iletmesi gerekecektir.
