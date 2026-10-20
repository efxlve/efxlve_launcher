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
  `PREFETCH_GAMES` değeri büyütülebilir. Son oynananlarda olmayan bir kartın
  üzerinde 700 ms durmak da o oyunu bir kez ısıtır; fareyle hızlı tarama istek
  üretmez.
- **Tek uçuş:** Steam/GOG/Amazon kütüphane yüklemeleri, başarım özeti ve GOG
  detayları aynı anda gelen çağrılarda tek promise paylaşıyor. Bunlar yalnız
  eşzamanlı çağrıları birleştirir; sonraki turları engellemez.
- **Uyumluluk yöneticisi:** 16 araçlık katalog, hedef platform seçici ve gerçek
  GitHub asset'leri. `wine-crossover` yalnız algılanır (Gcenx/winecx 404),
  `vulkan-helper-rs` kaynak-only. DXVK/VKD3D artık Compatibility sayfasından
  açılırsa prefix'e kopyalanıyor ve `WINEDLLOVERRIDES` ayarlanıyor; varsayılan
  kapalı, çünkü Linux/macOS'ta gerçek oyunla test edilmedi ve render yolunu
  değiştiriyor. Açıkken her oyun prefix'inde `.efxlve-layers.json` işareti
  tutuluyor; aynı katmanlar tekrar kopyalanmıyor.
- **Windows'ta uyumluluk:** `launch_spec` Windows'ta boş dönüyor; mevcut
  Windows başlatma yolu birebir korunuyor. Uyumluluk sayfası Windows'tan
  Linux/macOS ağacı indirmeye izin veriyor; bu bir paketleme hazırlığı, Windows
  oyunlarını Wine'a taşımıyor.
- **Sistem çalıştırıcıları:** Steam `compatibilitytools.d`, Lutris ve sistem
  Wine kopyaları algılanınca çalıştırıcı listesine eklenir; seçim
  `compat_runner_path` olarak saklanır ve launcher'ın kendi kopyasından önce
  gelir. Açık seçim yoksa önce yönetilen, sonra sistemdeki ilk çalıştırıcı
  kullanılır. Kullanıcı bir klasörü sonradan silerse `launch_spec` sırayla
  yönetilen kopyaya ve sistem kopyasına düşer; ayrı bir "bozuk ayar" hatası
  gösterilmez. "Kapalı" artık `compat_runner_enabled = false` ile gerçekten
  kapalıdır; eski sürümde `runner = null` yönetilen çalıştırıcıyı otomatik
  seçiyordu, bu bir hataydı.
- **Steam metadata cache:** `appinfo.vdf` her açılışta yeniden yürümek yerine
  ayrıştırılmış harita `<app_data>/steam/appinfo_metadata.json` içinde saklanıyor.
  Anahtar kaynak yol + dosya mtime + boyut; Steam güncellemesi ya da taşınan
  kurulum kopyayı geçersiz kılıyor. Ölçüm: soğuk ayrıştırma + yazma 134 ms,
  sıcak okuma 29 ms (1.820 uygulama); yalnız ayrıştırma 132 ms. Dosya ~125 kB,
  kaynak VDF 5,4 MB.
- **Geç gelen başarım:** Başarım özeti geldiğinde tüm oyun sayfası yeniden
  çizilmiyor. Hero çipleri, açık başarımlar sekmesinin gövdesi ve ana sayfadaki
  personal blok yerinde güncelleniyor; böylece okuma konumu ve sekme çubuğu
  korunuyor. Başarımlar sekmesindeki liste zaten sekme açılırken kurulduğundan
  yalnız gövde değişimi yeterli. DLC yanıtı da yalnız DLC sekmesinin gövdesini
  yeniliyor; iki kez tam sayfa çizen eski yol kaldırıldı. EOS taraması da yalnız
  "bu bilgisayardaki kopya" kartını tazeliyor; sonuç gelene kadar sayfa açık
  kalırsa artık tüm oyun sayfası yeniden kurulmuyor.
- **Oyun bazlı çalıştırıcı:** Oyun sayfasının Sistem sekmesinde "Genel ayarı
  kullan" varsayılanıyla bir seçim eklendi; yalnız istisnalar
  `<app_data>/compat/games.json` içine yazılıyor. Açık bir oyun seçimi global
  "kapalı" anahtarını aşar, böylece tek oyun için uyumluluk açılabilir; diğer
  oyunlar etkilenmez. Oyun kartındaki DXVK/VKD3D anahtarları da yalnız o oyun
  için yazılır; seçim genel seçimle aynı hale gelince kayıt silinip devralmaya
  dönülür. Oyun bazlı prefix klasörü tam yol olarak saklanır ve olduğu gibi
  kullanılır; boş bırakılırsa genel kök + oyun adı geçerlidir. Böylece var olan
  bir Steam `compatdata` prefix'i yeniden kullanılabilir. Katmanlar artık
  `system.reg` oluşmadan yazılmıyor ve Proton'un gerçek prefix'i olan `pfx`
  algılanırsa oraya kopyalanıyor; ilk açılışta prefix kurulursa katmanlar ancak
  sonraki açılışta devreye giriyor. Otomatik `wineboot` hâlâ açık. Gerçek prefix
  testi Linux/macOS donanımı istiyor.
- **Prefix hazırlama:** Oyun kartına "Prefix'i hazırla" düğmesi eklendi. Seçili
  çalıştırıcıyla `wineboot -u` çalışıyor; başlangıç/çalışıyor/bitti/hata
  aşamaları `compat-prefix-progress` olayıyla, saniye sayacıyla geliyor.
  180 saniye sonra süreç öldürülüp yeniden denenebilir bir hata dönüyor. Stderr
  ayrı iş parçacığında boşaltılıyor, böylece dolu boru wineboot'u kilitlemiyor.
  Düğme, kaydedilmemiş prefix alanını önce yazıyor; hızlı çalıştırıcı
  değişiklikleri için config kayıtları sıraya alındı. Aynı hazırlık, katman
  açık bir oyun Epic/GOG/Amazon normal yolundan başlatılırken de oyun süreci
  doğmadan önce çalışıyor; böylece ilk açılış katmanları alıyor. Katman yoksa
  preflight yapılmıyor. Hazırlık başarısız olursa oyun yine normal yoldan
  başlıyor ve katmanlar sonraki açılışta yeniden deneniyor. `spawn_blocking` ve
  tek bir süreç-içi kilit, aynı anda iki `wineboot` çalışmasını engelliyor.
  Başlatma bildirimi artık zamanlayıcısız bir toast: `compat-prefix-progress`
  geldikçe aynı kutuda "hazırlanıyor… N sn" yazıyor, oyun başlayınca kapanıyor.
  Böylece ilk katmanlı açılışın 30 saniyeye çıkabilen beklemesi "dondu" gibi
  görünmüyor.
- **ProtonDB rozeti:** Steam oyun sayfasındaki kopya kartına topluluk derecesi
  eklendi. `protondb.com` özet uç noktası kullanılıyor; uygulama kimliği yalnız
  rakamlardan oluşmalı. Yanıt `<app_data>/steam/protondb/<appid>.json` içinde
  bir gün cache'leniyor; ağ hatasında eski kopya, o da yoksa satır gizli kalıyor.
  Steam Deck "Verified" verisi Valve'de olduğu için eklenmedi; bu rozet yalnız
  ProtonDB derecesini gösteriyor.
- **Are We Anti-Cheat Yet?:** Steam oyun kartına Linux/Wine hile koruması durumu
  eklendi. Tüm katalog tek `games.json` dosyasında geldiği için bir kez indirilip
  `<app_data>/steam/awacy/games.json` altında günlük cache'leniyor. Steam
  kimliği yalnız rakam; Epic tarafında katalog ad alanı (`fn`, 32 karakterli
  hex) eşleştiriliyor. Durum, anti-cheat adları ve oyunun AWACY sayfası
  gösteriliyor. Kayıt yoksa veya ağ hatasında eski kopya yoksa satır gizli.
- **Steam Deck rozeti:** Valve'nin mağaza uyumluluk uç noktası kullanılıyor;
  `resolved_category` 1/2/3 sırasıyla desteklenmiyor/oynanabilir/doğrulanmış.
  Yanıt uygulama başına `<app_data>/steam/deck/<appid>.json` altında günlük
  cache'leniyor; bilinmeyen kategori veya ağ hatasında satır gizli.
- **Oyun prefix'ini aç:** Oyun kartındaki "Aç" düğmesi
  `compat_open_game_prefix` çağırıyor. `game_prefix` yardımcısı başlatma ve bu
  komut arasında paylaşılıyor; prefix hazırsa Proton'un `pfx` klasörü, değilse
  compatdata kökü açılıyor. Klasör yoksa oluşturuluyor; tarayıcı harness'inde
  çağrı ve "Klasör açıldı" bildirimi doğrulandı.
- **Oyun tanılaması:** `compat_game_diagnostics` çalıştırıcı seçimini, prefix
  yolunu, `system.reg` durumunu, `launch_spec` ortamını ve katman klasörlerini
  düz metin olarak döndürüyor. Oyun kartındaki düğme bunu panoya kopyalıyor;
  kimlik bilgisi içermiyor. Linux/macOS donanım testinde hata bildirimini
  hızlandırmak için eklendi. Settings → Uyumluluk sayfasındaki genel
  `compat_diagnostics` ise platform, hedef, araç kökü, yönetilen sürümler,
  algılanan sistem çalıştırıcıları ve başlatma ayarlarını listeliyor.
- **Prefix durumu:** `compat_game_prefix_state` oyunun gerçek prefix yolunu ve
  `system.reg` var mı bilgisini döndürüyor. Kart bunu "Prefix hazır." /
  "Prefix henüz oluşturulmadı." olarak gösteriyor; prefix kaydı ve hazırlama
  sonrası durum yeniden okunuyor.
- **Oyun sayfası sahibi turu:** Sahip, benzer oyunların altta kalmasını seçti;
  eylem satırı, tek künye satırı ve tek koleksiyon girişi zaten mevcut kodda
  böyleydi (eski ekran görüntüsü yanıltıcıydı). Takip turunda kişisel bilgiler
  iki ayrı sidebar widget'ına ayrıldı: "İstatistikler" (SÜRE/KUPA) en üstte,
  başarımların üstünde; "Bulut" ikinci widget. Dış mağazalarda bulut sahibi
  adıyla gösteriliyor ("EA Cloud tarafından yönetilir", "Steam Cloud tarafından
  yönetilir"; Rockstar/Xbox/Battle.net/Riot için kendi adları). Launcher'ın
  yönettiği kopyalarda senkron durumu, yoksa "Yerel Kayıt" gösteriliyor. Puan
  kartı yeniden yalnız puanlardan oluşuyor; Steam tür yedeği aynı Türkçe
  sözlükten geçiyor.
- **Çevrimdışı rozetler:** Steam Deck, ProtonDB ve AWACY komutları çevrimdışı
  modda `offline: true` ile çağrılıyor; backend ağa çıkmıyor, yalnız disk
  cache'ini okuyor. Cache varsa rozet eski veriyle görünüyor, yoksa satır gizli
  kalıyor. Çevrimdışıyken gelen boş yanıt oturum boyunca "başarısız" olarak
  saklanmıyor; sonraki açılışta veya bağlantı geri gelince yeniden deneniyor.
  Böylece oyun sayfası açılırken üç ayrı ağ zaman aşımı beklenmiyor.
- **Yarıda kalan indirme:** ağ hatası/iptal `.part` dosyasını silmez; sonraki
  deneme Range ile devam eder. Bu, 500 MB'lık GE-Proton indirmesini baştan
  başlatmamak için seçildi. Compatibility sayfasında araç klasörünün boyutu ve
  "yarım indirmeleri temizle" düğmesi var; indirme sürerken temizlik reddediliyor.
  Araç kaldırma da o araca ait yarım parçaları temizliyor.
- **IGDB DLC/genişletme listesi:** mağaza DLC satırları kurulum yüzeyi olarak
  kaldı; IGDB yalnız mağazanın adlandırmadığı ekleri ayrı blokta gösteriyor.
  Mağaza başlığıyla aynı olan (kanonik başlık) kayıtlar eleniyor.
- **Oyun sayfası sağ üst bilgisi:** Launcher oturumu yoksa mağazanın
  `last_played_timestamp` değeri "Son oynanma" olarak gösteriliyor; hiç
  oynanmamış oyunda uzun "oturum kaydedilmedi" satırı yerine kısa
  "Henüz oynanmadı" durumu var.
- **Tema seçimi:** Siyah ve Yumuşak Siyah'ın yanına **Beyaz Mod** ve **Frutiger
  Aero** eklendi. İkisi de aynı token sözlüğünü değiştiriyor; Aero ek olarak
  gökyüzü gradyanı, cam yüzeyler ve parlak mavi birincil düğme getiriyor.
  Seçim `efxlve-surface` altında saklanıyor ve `index.html` ilk boyamadan önce
  okuyor; beyaz temada segment düğmesi siyah, Aero'da mavi tonlu seçili görünüyor.
  Aero'nun üst bar/kenar çubuğu artık blur kullanmıyor; aynı görünüm opak beyaz
  gradyanla korunuyor.
- **TV ana ekranı:** komut çubuğu, sahne ve raf yeniden düzenlendi; raf başlığı,
  oyun adları ve odak etiketi eklendi. TV paleti `body.tv-mode` üzerinde sabit
  koyu; masaüstünde Beyaz/Aero seçili olsa bile hub kartları beyaza dönmüyor.
  Kategoriler artık kumandayla değiştiğinde rafı ve başlığı yeniden çiziyor.
- **Oyun içi overlay:** panel artık tarayıcı penceresinin bookmark yardımcılarını
  `browser-window.ts` üzerinden almıyor; bu import overlay açılırken tarayıcı
  chrome'unu da başlatıyor ve sahte `overlay_browser_show` çağrıları üretiyordu.
  Varsayılan yerleşim performans solda, ekran görüntüleri dar yüzeyde altında,
  müzik sağda olacak şekilde döşeniyor; gizli 1×1 pencereden gelen 8/8 kayıtları
  onarılıyor. Gizli panelde clock/media/clip/gamepad döngüleri duruyor; kumanda
  yokken oyun kolu döngüsü 250 ms'de bir kontrol ediyor. Overlay yüzeylerinden
  blur kaldırıldı. Ayarlar → Görünüm'deki **Düzeni sıfırla** kayıtlı widget
  konumlarını temizleyip açık widget'ları varsayılan döşemeye döndürüyor.
  Gerçek oyun sanatıyla 1280×800 ve 1920×1080 görsel turu sahibe kalıyor.
- **TV oyun merkezi:** ana ekranla aynı dil için başlığın üstüne "Oyun Merkezi"
  etiketi, beyaz aktif sekme ve kısaltılmış "İnceleme" istatistiği eklendi;
  sıradaki kupalar kartı ikinci bir çerçevenin içinden çıkarıldı. Profil ve
  mağaza/indirme panelleri eski düzenini koruyor.
- **TV mağaza/indirme panelleri:** panel yüzeyi düz `#05070a` oldu; sekiz mağaza
  sekmesi dar ekranda ikon + tooltip'e düşüyor ve L1/R1 ile çakışmıyor. Geri
  düğmesi dar üst barda da "Geri" etiketini koruyor. Profil paneli eski
  düzeninde bırakıldı.
- **Açık temalarda koyu katman metni:** Beyaz/Aero seçiliyken hero araçları,
  kapak rozetleri, ekran görüntüsü düğmeleri, SGDB etiketleri, profil banner
  çipleri, sürüm seçici ve hesap geçiş perdesi artık `--text` yerine açık renk
  kullanıyor. Koyu zeminli bu katmanlar bilinçli olarak koyu kalıyor.
- **Dokunulmayan sahip kararları:** şeffaflık/düz arka plan (TODO §2), TV
  profil panelinin görsel turu (TODO §1), GPU kaydedici (TODO §8) ve sürüm
  hazırlama/yayınlama bilerek değiştirilmedi.

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
