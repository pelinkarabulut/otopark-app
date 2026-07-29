-- Supabase SQL Editor'de bir kez çalıştırın (Project > SQL Editor > New query).
-- Bu tablo, uygulamadaki "Kaydedilen Formlar" listesini kalıcı olarak saklar.
--
-- ÖNEMLİ MİMARİ KURALLAR (bkz. App.js):
-- 1) TEKRARLANAN KAYIT SERBESTLİĞİ: plaka/form_no/vb. hiçbir alanda UNIQUE
--    kısıtlama YOKTUR ve OLMAMALIDIR. Aynı form bilgileri 100 kere gönderilse
--    bile her gönderim yeni bir satır (INSERT) olarak eklenir; uygulama
--    tarafında da hiçbir zaman UPSERT/UPDATE ile "üzerine yazma" yapılmaz.
-- 2) YUMUŞAK SİLME (SOFT DELETE): Uygulamadaki "Sil" butonu satırı asla
--    veritabanından KALICI OLARAK silmez (HARD DELETE yapılmaz); sadece
--    aşağıdaki is_deleted alanını true yapar. Böylece hiçbir veri kalıcı
--    olarak kaybolmaz ve Excel'e tam arşiv (bkz. kural 3) hep eksiksiz kalır.
create table if not exists public.otopark_formlari (
  id bigint primary key,
  baslangic_saati text,
  tamamlanma_saati text,
  form_no text,
  plaka text,
  bolum text,
  cikis_tarihi text,
  cikis_saati text,
  cikis_km text,
  donus_tarihi text,
  donus_saati text,
  donus_km text,
  gorev text,
  surucu_adi text,
  archived_uri text,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now()
);

-- Daha önce oluşturulmuş tablolarda is_deleted sütunu olmayabilir; varsa bu
-- iki satır zararsızca hiçbir şey yapmaz, yoksa sütunu ekleyip mevcut TÜM
-- satırları "aktif" (is_deleted = false) olarak işaretler.
alter table if exists public.otopark_formlari
  add column if not exists is_deleted boolean not null default false;

update public.otopark_formlari set is_deleted = false where is_deleted is null;

-- Mobil formdaki "Başlangıç Saati" / "Tamamlanma Saati" alanları (kullanıcı
-- tarafından elle girilir); Excel'de zaten var olan aynı adlı sütunlara
-- akar (bkz. server.js buildExcelRow). Daha önce oluşturulmuş tablolarda bu
-- sütunlar yoksa zararsızca eklenir.
alter table if exists public.otopark_formlari
  add column if not exists baslangic_saati text;
alter table if exists public.otopark_formlari
  add column if not exists tamamlanma_saati text;

-- Uygulama açılışında "sadece aktif kayıtları getir" sorgusu (bkz. App.js
-- useEffect) bu indeksle hızlanır.
create index if not exists idx_otopark_formlari_active
  on public.otopark_formlari (id)
  where is_deleted = false;

-- Row Level Security açık; uygulamada henüz kullanıcı girişi (auth) olmadığı
-- için şimdilik herkese (anon anahtarla) tam erişim veren geçici bir politika
-- tanımlanıyor. Bu sayede uygulama içindeki "Sil" butonu da dahil tüm
-- işlemler (SELECT/INSERT/UPDATE/DELETE) çalışır durumda kalır.
-- GÜVENLİK NOTU: Bu politika anon rolüne (yani uygulamanın gömülü
-- anahtarına) sınırsız erişim veriyor; ileride kullanıcı girişi (auth)
-- eklendiğinde bu politikayı kullanıcı bazlı (ör. "auth.uid() = user_id")
-- bir kurala göre sıkılaştırın.
alter table public.otopark_formlari enable row level security;

drop policy if exists "Gecici: anon tam erisim" on public.otopark_formlari;
drop policy if exists "anon_select_otopark_formlari" on public.otopark_formlari;
drop policy if exists "anon_insert_otopark_formlari" on public.otopark_formlari;
create policy "Gecici: anon tam erisim"
  on public.otopark_formlari
  for all
  to anon
  using (true)
  with check (true);
