-- Supabase SQL Editor'de bir kez çalıştırın (Project > SQL Editor > New query).
-- Bu tablo, uygulamadaki "Kaydedilen Formlar" listesini kalıcı olarak saklar.

create table if not exists public.otopark_formlari (
  id bigint primary key,
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
  created_at timestamptz not null default now()
);

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
