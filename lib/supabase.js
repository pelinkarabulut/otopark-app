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

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    'Supabase URL veya Anon Key bulunamadı. Proje kök dizinindeki .env dosyasına ' +
      'EXPO_PUBLIC_SUPABASE_URL ve EXPO_PUBLIC_SUPABASE_ANON_KEY değerlerini girip ' +
      'uygulamayı (npx expo start -c ile) yeniden başlatın.'
  );
} else if (rawSupabaseUrl !== supabaseUrl) {
  console.warn(
    `Supabase URL normalize edildi: "${rawSupabaseUrl}" -> "${supabaseUrl}". ` +
      '.env dosyasındaki EXPO_PUBLIC_SUPABASE_URL değerini "/rest/v1" içermeyecek ' +
      'şekilde güncellemeniz önerilir (örn. https://xxxx.supabase.co).'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
