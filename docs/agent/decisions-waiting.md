# Karar bekleyenler / yokluğunda alınan kararlar

Sahibi AFK olduğunda bu dosya tek gerçek kaynak: **neyi kendim karara
bağladım**, **neyi bekletiyorum**, **neden**.

## Protokol (kendime koyduğum kural)

1. **Objektif olan** (hata, regresyon, bozuk kontrol, veri kaybı, kırık
   çeviri anahtarı): düzeltilir, commit edilir, burada tek satırla bildirilir.
2. **İki makul seçenek varsa**: **geri alması kolay olan** seçilir, seçilmeyen
   alternatif gerekçesiyle buraya yazılır (tek commit ile geri dönülebilsin).
3. **Zevk / yön / sürüm kararı** (görsel dil, sürüm çıkarma, isim, fiyat):
   **tahmin edilmez**. Mevcut davranış korunur ve madde burada bekler.
4. **Asla**: bilgi silinmez, tasarım sistemi bozulmaz, push/release yapılmaz,
   katkı katmanı model kullanılmaz.

## Bekleyen kararlar (sahibinden)

- **Şeffaflık / düz arka plan (TODO §2)**: boşta çekirdeğin ~%11'i şeffaf
  pencereden geliyor. "Düz arka plan" anahtarı görünümü değiştirir (yuvarlak
  şeffaf hava gider), o yüzden karar sahibinin. Ölçüm yapıp sunabilirim.
- **GPU kaydedici (§8)**: 60/120 fps için Desktop Duplication + Media
  Foundation. Büyük iş; ne zaman başlanacağı sahibinin kararı.
- **Sürüm hazırlığı**: 0.1.32 hazırlanmadı, hiçbir şey push edilmedi. "hazırla"
  ve "yayınla" komutları bekleniyor.
- **Topluluk linkleri kapsamı**: Argon 5 sosyal ikon yerine Steam haber/yama
  notları + Resmî site/PCGamingWiki önerdi. Uygulayacağım (geri alması kolay);
  Epic'in oyun başına haber akışı iddiasını **önce doğrulayacağım**.

## Yokluğunda kendim karara bağladıklarım

- **Oyun sayfası ilk ekranı (Argon mockup'ı)** — uygulananlar:
  - **Aşama A** (`0554a4eb`): hero 440 → **340 px**, alt künye 48 px, bar -28 px,
    başlık 30 px, scrim durakları yeni yüksekliğe göre (0.38 → 0.08 → 0.48 →
    0.88 → #000). Künye tek satır: geliştirici · yayıncı (farklıysa) · yıl · yaş
    sınırı · DRM-Free/Aile. **Anti-cheat ve harici başlatıcı önce Özellikler
    kartına eklendi**, sonra hero'dan çıkarıldı (yoksa bilgi kaybolurdu); tam
    çıkış tarihi de oraya taşındı. IGDB kredileri artık yalnızca tür etiketleri +
    "Powered by IGDB".
  - **Aşama D** (`b7dec0b0`): oyun kurulu/oynanmışsa **kişisel içerik üstte**
    (Anların + Sıradaki kupalar), katalog bir kaydırma aşağıda; hiç oynanmamışsa
    tersi. Kupalar artık **3'lü kompakt kart** (tam genişlik satırlar yerine).
    Kişisel alan boşsa "Kendi kaydın buradan başlıyor" kartı.
  - **Aşama C1** (`082f003f`): HLTB kartında **oyuncunun kendi süresi** ortalamayla
    yan yana + ilerleme çubuğu; çok oyunculu oyunda yalnızca kendi süren
    (ölü duran `isMultiplayerOnlyMode` devreye alındı — CS2/DbD'de "Ana Hikâye
    15 sa" saçmalığı olmayacak).
- **Oturum özeti** (`94e4dfd8`): oyun kapanınca "Son oturum: 1 sa 40 dk · 3 saat önce ·
  +2 kupa" kartı. Süre `game-status` olayından, kupa farkı mağaza yanıtından
  (iki adımlı kayıt) — `localStorage`'da oyun başına tek kayıt, 24 saatten eskiyse
  sıfırlanır. "Bir dakikadan kısa ve kupasız" oturum gösterilmez.
- **Durum rozeti** (`263c2932`): künye satırında **türetilmiş** durum — Çevrimiçi
  (yeşil nokta, yalnız oyun çalışırken) / Tamamlandı (%100) / Oynanıyor / Kurulu.
  **Elle işaretleme yok**: Argon'un "ölü özellik" uyarısından sonra "Bırakıldı"
  gibi kullanıcı girdisi isteyen durumlar bilerek eklenmedi — uygulamanın zaten
  bildiği şeylerden türetiliyor.
- **Topluluk linkleri** (`a30d8b54`): krediler bloğunun altında kanal başına bir
  çip — Resmî site · X · Reddit · Discord · Wikipedia. **Yeni ağ isteği yok**:
  IGDB zaten kategorili web sitelerini istiyordu, yalnızca birini saklıyorduk.
  Gömülü akış **yok** (iki incelemenin gerekçesiyle).
- **Steam yama notları** (`50e18692` altyapı, `42fd1715` arayüz): uç doğrulandı
  (`ISteamNews/GetNewsForApp`, anahtarsız), yarım saatlik Rust önbelleği, sayfada
  About'un altında 3 maddelik "Haberler" kartı (yama notu etiketiyle). Epic'in
  oyun başına haber akışı **doğrulanmadı**, o yüzden Steam'de kaydı olmayan oyunda
  kart hiç görünmüyor — uydurma yok.
- **Benzer oyunlar kütüphane farkındalığı** (`e7cc0fbd`): kütüphanede olan benzer
  oyun tarayıcı yerine uygulamadaki sayfasını açıyor; eşleşme `storeKeysForTitle`
  ile kanonik başlık üzerinden (GOTY/Standard farkı sorun değil).
- **SÜRE ipucu** (`26203d4b`): "Son oynama: 12 Ekim 2026" — sayı ne kadar,
  ipucu ne zaman.
- **Kişisel puan (1-10)**: Argon "ölü özellik" dedi, düşürdüm; durum rozeti
  türetilmiş hâliyle kaldı. Geri alması kolay.
- **Benzer oyunlarda IGDB görselleri Genel Bakış'a düşmeyecek**: Argon'un
  gerekçesi (sayfayı daha çok mağaza gibi gösterir + görsel takas olur) kabul.
- **Bekleyen kartlar yer tutar** (sağ panel + kişisel bloklar): uygulandı.
- **Yönet paneli Sistem sekmesinde yaşar**, "Yönet" düğmesi sekme durumuna
  dokunmaz: uygulandı.
- **hidaaan'ın iki raporu** düzeltildi: süre toplamı tüm mağaza kopyalarını
  topluyor (`a790525d`), ekran görüntüsü başlıkları kartın içinde kısaltılıyor
  (`189e128e`, `5bcf55a8`).

## 2026-10-19 — önbellek ve uyumluluk turu

- **Oyun sayfası ön ısıtma:** son 6 oyun, 12 saatte bir, pencere boştayken ve
  ilk kütüphane senkronu bitince. Karar: ağ isteği sayısını 6 oyunla sınırladım;
  daha büyük bir liste ilk açılışta Epic senkronuyla yarışır. İstenirse sabit
  `PREFETCH_GAMES` değeri büyütülebilir.
- **Tek uçuş:** Steam/GOG/Amazon kütüphane yüklemeleri, başarım özeti ve GOG
  detayları aynı anda gelen çağrılarda tek promise paylaşıyor. Bunlar yalnız
  eşzamanlı çağrıları birleştirir; sonraki turları engellemez.
- **Uyumluluk yöneticisi:** 16 araçlık katalog, hedef platform seçici ve gerçek
  GitHub asset'leri. `wine-crossover` yalnız algılanır (Gcenx/winecx 404),
  `vulkan-helper-rs` kaynak-only. DXVK/VKD3D şimdilik yalnız indirilir; prefix'e
  DLL kopyalama ve `WINEDLLOVERRIDES` kurulumu bilerek sonraki tura bırakıldı,
  çünkü Linux/macOS'ta test edilmeden prefix'e yazmak geri alması zor bir risk.
- **Windows'ta uyumluluk:** `launch_spec` Windows'ta boş dönüyor; mevcut
  Windows başlatma yolu birebir korunuyor. Uyumluluk sayfası Windows'tan
  Linux/macOS ağacı indirmeye izin veriyor; bu bir paketleme hazırlığı, Windows
  oyunlarını Wine'a taşımıyor.
- **Sistem çalıştırıcıları:** Steam `compatibilitytools.d`, Lutris ve sistem
  Wine kopyaları algılanınca çalıştırıcı listesine eklenir; seçim
  `compat_runner_path` olarak saklanır ve launcher'ın kendi kopyasından önce
  gelir. Kullanıcı bir klasörü sonradan silerse `launch_spec` sessizce yönetilen
  kopyaya düşer; ayrı bir "bozuk ayar" hatası gösterilmez.
- **IGDB DLC/genişletme listesi:** mağaza DLC satırları kurulum yüzeyi olarak
  kaldı; IGDB yalnız mağazanın adlandırmadığı ekleri ayrı blokta gösteriyor.
  Mağaza başlığıyla aynı olan (kanonik başlık) kayıtlar eleniyor.
- **Dokunulmayan sahip kararları:** şeffaflık/düz arka plan (TODO §2), TV mode
  görsel yönü (TODO §1), GPU kaydedici (TODO §8) ve sürüm hazırlama/yayınlama
  bilerek değiştirilmedi.

## Sırada (yokluğunda devam edenler)

- **Aşama C2 — yapıldı**: sağ paneldeki iki kart tek çerçeveye alındı
  (`gp-scores-card`): başlık ve sıra kartın, puanlar ve süreler **kendi alt
  kutularında** (iki asenkron boyayıcı birbirini silmiyor). Puanlar artık 3'lü
  kompakt ızgarada. Oynanmış oyunda **önce süre, sonra dış puanlar** (Argon
  §8.1). Ayırıcı çizgi yalnızca iki blok da doluyken görünüyor.
- **Aşama B — yapıldı**: eylem satırı sadeleşti. Görünür kalanlar: birincil
  eylem (Oyna/Güncelle/Kur ✓), mağaza seçici ✓ (tek mağazadaysa artık sakin bir
  etiket ✓), Yönet ✓, favori kalbi ✓ ve `⋯` ✓. Menüye girenler: koleksiyonları
  yönet ✓, mağaza sayfası ✓, harici istemciyi aç (yalnız companion ✓), ayırıcı ✓,
  kapak görselini değiştir ✓. Menü durumu `S.isGameMoreMenuOpen` içinde ✓
  (sürüm menüsünün kanıtlanmış kalıbı ✓) — böylece arka planda başarım/DLC yanıtı
  gelince menü kapanmıyor ✓; dışarı tıklayınca kapanıyor ✓.
  **Küçük kalan**: Esc ile kapanma yok (sürüm menüsünde de yok ✓, dışarı tıklama
  yeterli ✓). Bir tur açıp bakılması iyi olur.
- **"Desteklenmiyor" satırlarını gizleme — ertelendi**: Argon'un uyarısı haklı,
  `.muted` sınıfı "Klavye & Fare" gibi *desteklenen* değerlerde de kullanılıyor;
  gizlemek için satır başına açık bir bayrak gerekiyor. Bilgi gizleme riski
  kozmetik kazançtan büyük, o yüzden dokunulmadı.
