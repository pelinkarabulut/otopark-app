// Supabase Edge Function: sync-to-sharepoint-excel
//
// AMAÇ
// -----
// "otopark_formlari" tablosuna yeni bir kayıt eklendiğinde, bu kaydı
// SharePoint/OneDrive üzerindeki "HİZMET ARAÇLARI TAKİP FORMU.xlsx"
// dosyasındaki bir Excel Tablosuna (Table) Microsoft Graph API üzerinden
// OTOMATİK olarak ekler. Tamamen bulut-bulut (cloud-to-cloud) çalışır;
// şirketin yerel ağına/firewall'una hiçbir şekilde dokunmaz.
//
// TETİKLENME YOLLARI
// -------------------
// 1) Gerçek zamanlı: Supabase Database Webhook, "otopark_formlari"
//    tablosuna INSERT olduğunda bu fonksiyonu çağırır (bkz. proje kökündeki
//    docs/it-microsoft-graph-gereksinimleri.md -> "Supabase tarafı" bölümü).
//    Webhook body'si şu şekle sahiptir: { type: "INSERT", record: {...} }.
// 2) Güvenlik ağı (reconciliation): "?mode=sweep" ile çağrıldığında,
//    excel_synced_at değeri NULL olan (yani webhook'un kaçırmış olabileceği)
//    TÜM kayıtları bulup TEK bir Graph API isteğiyle toplu ekler. Bu modu
//    ücretsiz bir dış zamanlayıcıyla (cron-job.org, GitHub Actions schedule,
//    ya da ileride pg_cron ile) periyodik çağırmanız önerilir.
//
// GEREKLİ SUPABASE "SECRETS" (Dashboard > Edge Functions > Secrets, ya da
// `supabase secrets set` ile):
//   AZURE_TENANT_ID            Azure AD (Entra ID) kiracı (tenant) ID'si
//   AZURE_CLIENT_ID            App Registration'ın "Application (client) ID"
//   AZURE_CLIENT_SECRET        App Registration'da oluşturulan client secret
//   SHAREPOINT_SITE_ID         Hedef SharePoint sitesinin Graph "site id"si
//   SHAREPOINT_DRIVE_ITEM_ID   HİZMET ARAÇLARI TAKİP FORMU.xlsx dosyasının
//                              Graph "drive item id"si
//   EXCEL_TABLE_NAME           Excel'de Ctrl+T ile oluşturulan tablonun adı
//                              (örn. "HizmetAraclariTablosu")
//   SYNC_WEBHOOK_SECRET        Bu fonksiyonu çağırırken Supabase Webhook'unun
//                              göndereceği paylaşılan gizli anahtar (rastgele,
//                              uzun bir metin siz üretin)
//   (SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY, Edge Functions ortamında
//   Supabase tarafından OTOMATİK olarak sağlanır; elle eklemenize gerek yok.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

function getEnvOrThrow(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Eksik ortam değişkeni (Supabase secret): ${name}`);
  }
  return value;
}

function createSupabaseServiceClient() {
  const supabaseUrl = getEnvOrThrow("SUPABASE_URL");
  const serviceRoleKey = getEnvOrThrow("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(supabaseUrl, serviceRoleKey);
}

// Türkiye saatine (UTC+3) çevrilmiş, Excel'in "seri gün sayısı" formatına
// uygun bir sayı üretir (server.js'teki excelSerialFromDate ile aynı mantık).
function excelSerialFromIsoDate(isoDate: string | null): number {
  const date = isoDate ? new Date(isoDate) : new Date();
  const TR_OFFSET_MS = 3 * 60 * 60 * 1000;
  const EXCEL_EPOCH_OFFSET_DAYS = 25569;
  const MS_PER_DAY = 86400000;
  const localMs = date.getTime() + TR_OFFSET_MS;
  return localMs / MS_PER_DAY + EXCEL_EPOCH_OFFSET_DAYS;
}

// Tek bir Supabase satırını, Excel tablosundaki 16 sütunluk (Id hariç, Id
// Graph tarafında otomatik satır numarası olarak DEĞİL, kendimiz A sütununa
// yazdığımız için burada da üretiyoruz) diziye çevirir. Şablonun tam sütun
// sırası: Id, Başlangıç saati, Tamamlama saati, E-posta, Ad, Form No,
// Sütun1, Çıkış Tarihi, Plaka, Sürücü Adı, Bölüm, Görev, Çıkış Km,
// Çıkış Saati, Dönüş Km, Dönüş Saati, Dönüş Tarihi, Talep Kanalı,
// Talep Tarihi, Soru (toplam 20 sütun).
function buildExcelRow(record: Record<string, unknown>, nextId: number): unknown[] {
  const createdAt = (record.created_at as string) ?? null;
  const excelDateTime = excelSerialFromIsoDate(createdAt);
  const cikisTarihi = (record.cikis_tarihi as string) || "";
  const donusTarihi = (record.donus_tarihi as string) || "";

  return [
    nextId,
    excelDateTime,
    excelDateTime,
    "anonymous",
    null,
    record.form_no || "",
    null,
    cikisTarihi,
    record.plaka || "",
    record.surucu_adi || "",
    record.bolum || "",
    record.gorev || "",
    record.cikis_km || "",
    record.cikis_saati || "",
    record.donus_km || "",
    record.donus_saati || "",
    donusTarihi && donusTarihi !== cikisTarihi ? donusTarihi : "",
    null,
    null,
    null,
  ];
}

async function getGraphAccessToken(): Promise<string> {
  const tenantId = getEnvOrThrow("AZURE_TENANT_ID");
  const clientId = getEnvOrThrow("AZURE_CLIENT_ID");
  const clientSecret = getEnvOrThrow("AZURE_CLIENT_SECRET");

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Azure AD token alınamadı (status ${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.access_token as string;
}

// Excel Tablosuna (birden fazla olabilecek) satırları TEK bir Graph API
// isteğiyle ekler. Tablo kullanmak (düz aralık yerine), Graph'ın satırı her
// zaman tablonun DOĞRU son satırının altına eklemesini garanti eder; elle
// satır/aralık hesaplamaya gerek kalmaz.
async function addRowsToExcelTable(accessToken: string, rows: unknown[][]): Promise<void> {
  const siteId = getEnvOrThrow("SHAREPOINT_SITE_ID");
  const itemId = getEnvOrThrow("SHAREPOINT_DRIVE_ITEM_ID");
  const tableName = getEnvOrThrow("EXCEL_TABLE_NAME");

  const url =
    `${GRAPH_BASE_URL}/sites/${siteId}/drive/items/${itemId}` +
    `/workbook/tables/${encodeURIComponent(tableName)}/rows/add`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: rows }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Graph API'ye satır eklenemedi (status ${response.status}): ${errorText}`);
  }
}

// A sütunundaki (Id) en büyük değeri Graph API üzerinden okuyup +1 döndürür.
// Not: Çok yoğun eşzamanlı yazımlarda yarış durumu (race condition) teorik
// olarak mümkündür; bu şirket-içi araç takip senaryosu için (dakikada
// birkaç kayıt) risk kabul edilebilir düzeydedir.
async function getNextExcelId(accessToken: string): Promise<number> {
  const siteId = getEnvOrThrow("SHAREPOINT_SITE_ID");
  const itemId = getEnvOrThrow("SHAREPOINT_DRIVE_ITEM_ID");
  const tableName = getEnvOrThrow("EXCEL_TABLE_NAME");

  const url =
    `${GRAPH_BASE_URL}/sites/${siteId}/drive/items/${itemId}` +
    `/workbook/tables/${encodeURIComponent(tableName)}/columns/Id/range`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Id sütunu okunamadı (status ${response.status}): ${errorText}`);
  }
  const data = await response.json();
  const values: unknown[][] = data.values ?? [];
  let maxId = 0;
  for (const [cell] of values) {
    const numeric = Number(cell);
    if (Number.isFinite(numeric) && numeric > maxId) maxId = numeric;
  }
  return maxId + 1;
}

async function markRecordsAsSynced(recordIds: (string | number)[]) {
  if (recordIds.length === 0) return;
  const supabase = createSupabaseServiceClient();
  const { error } = await supabase
    .from("otopark_formlari")
    .update({ excel_synced_at: new Date().toISOString() })
    .in("id", recordIds);
  if (error) {
    throw new Error(`Supabase'de excel_synced_at güncellenemedi: ${error.message}`);
  }
}

async function handleSingleRecordSync(record: Record<string, unknown>) {
  const accessToken = await getGraphAccessToken();
  const nextId = await getNextExcelId(accessToken);
  const row = buildExcelRow(record, nextId);
  await addRowsToExcelTable(accessToken, [row]);
  await markRecordsAsSynced([record.id as string | number]);
  console.log(`[sync-to-sharepoint-excel] Kayıt senkronize edildi. Supabase id=${record.id}, Excel Id=${nextId}`);
}

async function handleSweep() {
  const supabase = createSupabaseServiceClient();
  const { data: pendingRecords, error } = await supabase
    .from("otopark_formlari")
    .select("*")
    .is("excel_synced_at", null)
    .order("id", { ascending: true });

  if (error) {
    throw new Error(`Bekleyen kayıtlar okunamadı: ${error.message}`);
  }
  if (!pendingRecords || pendingRecords.length === 0) {
    console.log("[sync-to-sharepoint-excel] Sweep: senkronize edilecek kayıt yok.");
    return { synced: 0 };
  }

  const accessToken = await getGraphAccessToken();
  let nextId = await getNextExcelId(accessToken);
  const rows: unknown[][] = [];
  for (const record of pendingRecords) {
    rows.push(buildExcelRow(record, nextId));
    nextId += 1;
  }

  await addRowsToExcelTable(accessToken, rows);
  await markRecordsAsSynced(pendingRecords.map((r: Record<string, unknown>) => r.id as string | number));
  console.log(`[sync-to-sharepoint-excel] Sweep: ${pendingRecords.length} kayıt senkronize edildi.`);
  return { synced: pendingRecords.length };
}

function isAuthorized(req: Request): boolean {
  const expectedSecret = Deno.env.get("SYNC_WEBHOOK_SECRET");
  if (!expectedSecret) return false;
  const providedSecret = req.headers.get("x-webhook-secret");
  return providedSecret === expectedSecret;
}

Deno.serve(async (req: Request) => {
  try {
    if (!isAuthorized(req)) {
      return new Response(JSON.stringify({ success: false, error: "Yetkisiz istek (geçersiz/eksik X-Webhook-Secret)." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const url = new URL(req.url);
    const isSweep = url.searchParams.get("mode") === "sweep";

    if (isSweep) {
      const result = await handleSweep();
      return new Response(JSON.stringify({ success: true, ...result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const payload = await req.json();
    const record = payload?.record;
    if (!record || typeof record !== "object") {
      return new Response(
        JSON.stringify({ success: false, error: "İstek gövdesinde 'record' alanı bulunamadı." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    await handleSingleRecordSync(record);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[sync-to-sharepoint-excel] HATA:", error);
    return new Response(JSON.stringify({ success: false, error: (error as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
