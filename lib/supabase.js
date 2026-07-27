import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Expo CLI, .env dosyasındaki EXPO_PUBLIC_ önekli değişkenleri derleme
// sırasında process.env üzerinden statik nokta gösterimiyle (dot notation)
// koda gömer. Bu yüzden process.env.EXPO_PUBLIC_... ifadesi olduğu gibi
// kullanılmalı; process.env['...'] veya destructuring gibi dinamik erişimler
// Expo tarafından inline edilemez.
// .env'deki URL yanlışlıkla "/rest/v1" veya sonda "/" içerirse, supabase-js bu
// yolu kendisi tekrar ekleyip istekleri yanlış (var olmayan) bir adrese
// gönderir; bu da "hata yok ama veri de yok" gibi sinsi bir duruma yol açar.
// Bu yüzden URL'i burada normalize ediyoruz.
const rawSupabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseUrl = rawSupabaseUrl
  ? rawSupabaseUrl.trim().replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '')
  : rawSupabaseUrl;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

// createClient(undefined, undefined) supabase-js içinde SENKRON olarak hata
// fırlatır. Bu satır App.js import edilirken (yani uygulama açılır açılmaz,
// hiçbir ekran render olmadan) çalıştığı için, EXPO_PUBLIC_ değişkenleri
// (ör. bir EAS build'de eas.json'a env eklenmediği için) eksikse uygulama
// anında çöker: kullanıcı sadece beyaz ekran görüp uygulamanın hemen
// kapandığını görür. Bunu önlemek için, değişkenler eksikse gerçek bir
// Supabase istemcisi yerine güvenli/no-crash bir "sahte" istemci
// kullanıyoruz; app.js'teki mevcut try/catch blokları bu durumda normal
// şekilde "buluta kaydedilemedi" hatası gösterir, ama uygulama açılmaya
// devam eder.
function createDisabledSupabaseStub(reason) {
  const disabledError = new Error(reason);
  const CHAIN_METHODS = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'order', 'limit', 'single', 'match'];

  function makeChain() {
    const promise = Promise.resolve({ data: null, error: disabledError });
    CHAIN_METHODS.forEach((name) => {
      promise[name] = makeChain;
    });
    return promise;
  }

  return { from: makeChain };
}

let supabaseClient;
if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    'Supabase URL veya Anon Key bulunamadı. Proje kök dizinindeki .env dosyasına (yerel ' +
      'geliştirme için) veya eas.json > build.<profil>.env içine (EAS build için) ' +
      'EXPO_PUBLIC_SUPABASE_URL ve EXPO_PUBLIC_SUPABASE_ANON_KEY değerlerini ekleyip ' +
      'yeniden build/başlatın. Bulut senkronizasyonu devre dışı bırakıldı, uygulama yerel ' +
      'modda çalışmaya devam edecek.'
  );
  supabaseClient = createDisabledSupabaseStub(
    'Supabase yapılandırılmadı (EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY eksik).'
  );
} else {
  if (rawSupabaseUrl !== supabaseUrl) {
    console.warn(
      `Supabase URL normalize edildi: "${rawSupabaseUrl}" -> "${supabaseUrl}". ` +
        '.env dosyasındaki EXPO_PUBLIC_SUPABASE_URL değerini "/rest/v1" içermeyecek ' +
        'şekilde güncellemeniz önerilir (örn. https://xxxx.supabase.co).'
    );
  }
  try {
    supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    });
  } catch (error) {
    console.error('Supabase istemcisi oluşturulamadı:', error);
    supabaseClient = createDisabledSupabaseStub(
      'Supabase istemcisi oluşturulamadı: ' + (error?.message || error)
    );
  }
}

export const supabase = supabaseClient;
