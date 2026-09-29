# Genel Proje Denetimi

**Tarih:** 30.09.2026

**İncelenen ağaç:** `main` (`de96263`) ve denetim başında mevcut olan yerel düzenlemeler

**Kapsam:** Rust/Tauri backend, TypeScript/Vite frontend, güvenlik sınırları, performans, test/CI, dokümantasyon ve açık özellikler.

> Bu bir statik kod ve dokümantasyon incelemesidir; bu denetimde uygulama penceresi veya kurulu paket canlı olarak açılmadı. Çalışma ağacında önceden var olan değişikliklere dokunulmadı. Derleme ve test sonuçları denetim anındaki mevcut çalışma ağacına aittir.

## Kısa sonuç

Proje işlev bakımından geniş ve modüler frontend, disk önbelleği, kademeli kütüphane çizimi, O(1) seçiciler ve çok sayıda Rust testi iyi temeller oluşturuyor. Denetimde önce ele alınması gerekenler:

1. Epic/GOG hesap kasalarında IPC'den gelen kimlikler dosya yolu olarak doğrulanmadan kullanılıyor; hesap silme yolunun kasa dışına çıkma riski var.
2. Steam QR girişi oturumu daima diske kaydediyor; hesap kartındaki “oturumu bu cihazda tut” tercihi QR akışına aktarılmıyor.
3. Hakkında ekranı tüm oturum belirteçlerinin DPAPI ile mühürlendiğini söylüyor; uygulama kodu bunu yalnız Steam yenileme belirteci için yapıyor.
4. İndirme ilerlemesi her animasyon karesinde tüm oyun listesini yeniden filtreleyip sıralayan bir sidebar yolunu tetikliyor.

## Doğrulama ve ölçülen durum

| Kontrol | Sonuç |
|---|---|
| `npm.cmd run build` | Başarılı; TypeScript kontrolü ve Vite üretim derlemesi geçti. |
| `cargo check --manifest-path src-tauri/Cargo.toml` | Başarılı, uyarı yok. |
| `cargo test --manifest-path src-tauri/Cargo.toml` | **173 geçti, 16 yok sayıldı, 0 başarısız.** Yok sayılanlar canlı/ağ veya makineye bağlı testler. |
| Yerelleştirme anahtarları | 15 dosyanın her birinde **1.433** anahtar; eksik, fazla veya boş değer yok. Bu sayım çeviri kalitesini doğrulamaz. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | **Başarısız:** `src-tauri/src/steam_auth.rs` rustfmt çıktısından farklı. |
| Frontend giriş paketi | `index-BL6PIdiQ.js`: **647,74 KB minified / 188,35 KB gzip**. Vite uyarı eşiği `vite.config.ts` içinde 650 KB; paket eşiğe çok yakın. |

## Öncelikli bulgular

### P1 — Hesap kimlikleri dosya sınırında doğrulanmıyor

- `src-tauri/src/legendary/commands.rs:372-380` ve `src-tauri/src/gogdl/commands.rs:321-338`, istemciden gelen `account_id` / `user_id` değerini doğrudan hesap modüllerine iletiyor.
- `src-tauri/src/legendary/accounts.rs:237, 280-284` ile `src-tauri/src/gogdl/accounts.rs:160, 193-196` bu değerleri `Path::join` ile dizine ekliyor; kaldırma yolları ardından `remove_dir_all` çağırıyor.
- Mutlak yol veya `..` içeren kötü biçimli bir IPC girdisi, hedefi hesap kasasının dışına taşıyabilir ve amaçlanmayan bir dizinin silinmesine yol açabilir. Hesap değiştirme yolları da beklenmeyen `user.json` dosyasına erişebilir. Bu, kötüye kullanımı kanıtlanmış bir uzaktan açık değil; fakat IPC sınırında kapatılması gereken bir dosya sistemi güven sınırı.
- Aynı sınır kontrolü `steam_get_game_details` için de gerekli: `app_id` doğrulanıyor ama `language` doğrudan cache dosya adına ekleniyor (`src-tauri/src/steam.rs:727-730, 752-762`). Ayraç içeren IPC girdisi cache kökünün dışına taşabilir; dili desteklenen Steam kodlarıyla sınırlandırın.
- Steam tarafında `steam_auth.rs:774-780, 1357-1367` için SteamID64 doğrulaması zaten var; Epic/GOG tarafında aynı sınır kontrolü yok.
- **Öneri:** kimliği komut sınırında mağazaya uygun allowlist ile doğrulayın, oluşturulan hedefin kasa kökü altında kaldığını garanti edin ve traversal/absolute-path regresyon testleri ekleyin. Testler yalnız kendi geçici dizinlerinde çalışmalı.

### P1 — Bildirim tercihi dışında Steam QR oturumu kalıcılaştırılıyor

- Hesap ekranındaki normal giriş akışı `steam-remember` seçeneğini sunuyor (`src/features/accounts/accounts-view.ts:371-374`). QR düğmesi (`:401`) ayrı akışa gidiyor; `src/features/auth/steam-auth-actions.ts:113-123` bu tercihi okumadan QR başlatıyor.
- `src-tauri/src/steam_auth.rs:1149` QR oturumunun `remember` alanını sabit `true` yapıyor; onaylanınca token `persist_session` ile DPAPI kasasına yazılıyor.
- Sonuç: QR akışında kalıcı saklamayı kapatma seçeneği yok ve oturumun kalıcı olacağı açıkça sorulmuyor. Bu davranış, “oturumu koru” tercihiyle tutarlı değil.
- **Öneri:** QR akışına da aynı tercihi taşıyın veya QR ekranında ayrı, varsayılanı açıkça belirlenmiş bir saklama seçeneği gösterin. “Kapalı” durumunda eski vault kaydının yeniden etkinleşmediğini test edin.

### P1 — İndirme ilerlemesi oyun listesini kare başına taratıyor

- İndirme olayları `scheduleDlDomUpdate` ile animasyon karesinde birleştiriliyor (`src/features/events/ipc-listeners.ts:92-106`); `applyDlDomUpdate` her karede `updateBadge()` çağırıyor.
- `src/core/nav.ts:61-68` her çağrıda güncelleme sayısını tarıyor ve `updateSidebarGames()` çalıştırıyor. Bu fonksiyon `:145-169` içinde kurulu oyunların tamamını filtreliyor, yakın zamanda oynananları ayırıyor, kalanları sıralıyor; imza kontrolü ancak bu işten sonra yapılıyor.
- 500+ oyun ve saniyede çok sayıda ilerleme olayı olduğunda DOM yeniden çizilmese de O(N log N) CPU işi tekrar ediyor. Badge sayısı indirme yüzdesi değiştikçe değişmediği için bu iş ilerleme akışında gereksiz.
- **Öneri:** ilerleme olayı ile badge/sidebar üyelik güncellemesini ayırın; üyelik/durum imzasını pahalı filtre/sıralamadan önce kontrol edin veya kurulu sidebar adaylarını revizyon numarasıyla önbelleğe alın. 500–800 oyunluk ilerleme yükü için performans regresyon testi ekleyin.

### P1 — Gizlilik metni gerçek token saklama davranışını olduğundan güçlü anlatıyor

- `src/locales/en.json:1179` ve diğer 14 dildeki `settings.aboutPrivacy`, oturum belirteçlerinin cihazda Windows DPAPI ile mühürlendiğini söylüyor.
- Steam yenileme belirteçleri DPAPI ile korunuyor (`src-tauri/src/steam_auth.rs:627-718, 800-813`). Buna karşılık Epic `user.json` dosyası olduğu gibi hesap klasörüne kopyalanıyor (`src-tauri/src/legendary/accounts.rs:65-70`); GOG `auth.json` token içeren JSON olarak yazılıyor/kopyalanıyor (`src-tauri/src/gogdl/cache.rs:24-38`, `gogdl/accounts.rs:104-106`). SteamGridDB ve Steam Web API anahtarları da `settings.json` içinde tutuluyor (`src-tauri/src/main.rs:91-105, 137-144`).
- Bu dosyalar kullanıcının yerel profilinde kalıyor; ancak hepsi DPAPI ile korunmuyor. Hakkında metni bu nedenle mevcut uygulamayla birebir doğru değil.
- **Öneri:** kısa vadede metni mağaza bazında doğru kapsamla düzeltin; uzun vadede CLI uyumluluğunu bozmadan Epic/GOG sırlarının disk korumasını tasarlayın. API anahtarlarının saklanma biçimini de aynı açıklamada belirtin.

## Önemli sağlamlaştırma ve performans işleri

### P2 — Steam dosya taramaları ve ekran görüntüsü aktarımı senkron IPC yolunda

- `steam_get_achievements_summary` senkron Tauri komutu (`src-tauri/src/steam.rs:1445-1495`); önbellek süresi dolunca 150+ yerel şema dosyasını okuyor (`read_local_achievement_totals`).
- `steam_sync_playtime` her çağrıda en yeni `localconfig.vdf` dosyasını açıp ayrıştırıyor (`steam.rs:348-397`).
- `steam_get_game_screenshots` senkron biçimde küçük resimleri ve orijinalleri data URL/base64 olarak tek IPC yanıtında hazırlıyor (`steam.rs:1525-1586`). Büyük ekran görüntüsü koleksiyonlarında disk gecikmesi, kopya bellek ve UI yanıt süresi büyüyebilir.
- **Öneri:** ağır dosya işlerini `spawn_blocking`/asenkron komutlara taşıyın; VDF sonucunu mtime ile önbelleğe alın; galeri yalnız küçük resimleri alsın, orijinal görsel kullanıcı açınca ayrı komutla yüklensin.

### P2 — Üretim JS paketi tek ve eşik değerine yakın

`src/main.ts` statik olarak çok sayıda ekran/özellik içe aktarıyor. Üretim ana paketi 647,74 KB; yalnız dil dosyaları ayrı chunk'lara bölünmüş. `vite.config.ts:17-21` uyarı sınırını 650 KB yapıyor; bu, ilk ekrana gerek olmayan özelliklerin yükünü azaltmıyor.

**Öneri:** Ayarlar, hesap bağlama, ekran görüntüsü yönetimi ve nadir kullanılan Steam/mağaza araçlarını kullanıcı ilgili ekrana girdiğinde dinamik import ile yüklemeyi değerlendirin. Diskten açılan yerel chunk'ların ilk boyama/parse süresini düşük donanımda ölçün; yalnız gzip boyutuna göre karar vermeyin.

### P2 — Beş Rust dosyası proje sınırını aşıyor

`AGENTS.md` §4.8 yaklaşık 1.500 satır üst sınırı koyuyor. Güncel sayım:

| Dosya | Satır |
|---|---:|
| `src-tauri/src/legendary/commands.rs` | 2.792 |
| `src-tauri/src/legendary/transfers.rs` | 2.508 |
| `src-tauri/src/main.rs` | 2.137 |
| `src-tauri/src/steam.rs` | 1.954 |
| `src-tauri/src/steam_auth.rs` | 1.797 |

**Öneri:** dosyaları mekanik değil sorumluluk bazında ayırın: IPC grupları; transfer kuyruğu/progress/kurulum; uygulama başlatma-mağaza-tepsi; Steam VDF/API/başarım/ekran görüntüsü; Steam auth/protobuf/DPAPI kasa. Her parça için mevcut `cargo test` ve davranış testlerini koruyun.

### P2 — Testler yerelde var, PR/release kapısında otomatik değil

- `package.json` yalnız `build` script'i sunuyor; TypeScript davranış/UI testi veya lint script'i yok.
- `.github/workflows/release.yml` yalnız `v*` etiketi ve elle çalıştırma ile yayın işi yapıyor; yayınlamadan önce `cargo test`, frontend build, i18n/IPC denetimi veya `cargo fmt --check` çalıştıran ayrı PR CI görünmüyor.
- Denetimde `cargo fmt --check` `steam_auth.rs` için başarısız oldu. Normal build ve testin yeşil olması biçimlendirme kontrolünü garanti etmiyor.
- **Öneri:** PR CI'a `npm ci && npm run build`, `cargo fmt --check`, `cargo check`, `cargo test` ve deterministik i18n/IPC parity denetimi ekleyin. İndirme ilerlemesi, hesap kasası, kütüphane DOM yaması ve hesap geçişi için küçük frontend davranış testleri oluşturun.

### P2 — Dosya yazımları sessiz ve atomik değil

Hesap kasası ve yan dosya kopyaları/yazımları (`legendary/accounts.rs`, `gogdl/accounts.rs`) birçok noktada `let _ = ...` ile hata bastırıyor. `save_settings` de (`main.rs:137-144`) yazma sonucunu döndürmüyor; bazı çağıranlar başarısız kayıtta bile başarı yanıtı verebilir. Ani kapanma veya disk/izin hatasında kullanıcı hesabı ya da ayarı kaybedebilir.

**Öneri:** kritik auth/account metadata yazımlarını geçici dosyaya yazıp atomik rename ile tamamlayın; hata durumunu IPC/UI'a iletin. Özellikle hesap arşivleme ve değiştirme akışlarını dosya izni/dolu disk senaryolarıyla test edin.

### P2 — Güvenlik politikası ek savunma sağlamıyor

`src-tauri/tauri.conf.json:26-28` CSP'yi `null` bırakıyor. Bu tek başına bir XSS kanıtı değildir; ancak uygulama yerel HTML şablonları, mağaza/veri kaynaklı içerikler ve güçlü Tauri IPC komutları taşıyor. Hesap kimliği yol doğrulamasıyla birlikte savunma derinliği açısından değerlendirilmelidir.

**Öneri:** ana uygulama WebView'i için uygulanabilir CSP belirleyin; mağaza child webview'larının gereksinimlerini ana arayüzden ayrı değerlendirin ve dinamik HTML'e giren katalog/oyun metinlerinin kaçış testlerini ekleyin.

### P3 — Açılış optimizasyonu henüz hedef donanım/paket üzerinde doğrulanmadı

Çalışma günlüğü aynı makinede 820 kayıt için soğuk açılış yolunun yaklaşık 5 sn'den 0,7 sn'ye indiğini bildiriyor; mevcut çalışma ağacındaki frontend build, `cargo check` ve `cargo test` başarılı. Bu sonuç tek makine ve geliştirme akışı için raporlanmış; 8 GB RAM + HDD referansında **kurulu paketle**, ilk açılış ve sıcak önbellek ayrılarak ölçüm bu denetimde yapılmadı.

Ayrıca henüz düzenlenmemiş çalışma ağacındaki `binary_stamp()` (`src-tauri/src/legendary/downloader.rs:75-85`) mtime'ı saniyeye yuvarlıyor. Aynı boyutlu binary aynı saniye içinde değişirse damga aynı kalabilir; mevcut test dosya boyutunu değiştirdiği için bu durumu yakalamıyor. Mtime nanosaniyesi veya güvenilir bir dosya kimliği/hash'i ve aynı-boyut regresyon testi eklenebilir.

## Yarım kalan işler ve bilinçli kapsam sınırları

Bu maddeler hata olarak değil, planın uygulanmamış veya kapsamı sınırlı parçaları olarak görülmeli:

1. **Birleşik hesap kütüphanesi:** v1 sahip etiketi ve “Hesaba Geç” var. Hesap bazlı başarı/oynama süresi, `account:` arama filtresi ve koleksiyon/favori davranışı hâlâ açık (`docs/ROADMAP.md` §7.3).
2. **EA / Ubisoft / Xbox:** algılama ve harici istemciye başlatma var; bu oyunların Epic/GOG/Steam gibi birleşik kütüphaneye eklenmesi Faz 2 olarak duruyor. Battle.net mağaza gezinmesi sunuyor; oyun algılama entegrasyonu yok.
3. **Steam hesap tutarlılığı:** sahip olunan oyun listesi launcher'da seçili Steam hesabından; yerel başarı, görüntü ve oyun süresi Windows Steam istemcisinin hesabından geliyor. Ayrıca süre seçimi en yeni `localconfig.vdf` mtime'ına, başarı/görüntü hesabı `loginusers.vdf` `MostRecent` alanına göre olduğundan çoklu yerel Steam hesabında eşleşme garantisi yok.
4. **GOG Galaxy:** registry senkronu en iyi çaba; HKLM yazımı yönetici gerektirebilir. Galaxy'nin kendi SQLite veritabanına yazma ve `.info` senkronu planlanmış/riski değerlendirilmemiş durumda.
5. **Discord Social SDK:** mevcut Discord Rich Presence'tan ayrı bir sosyal katman; portal/SDK hazırlığı ve kullanıcı kararı bekliyor. Arkadaş özelliklerinin kaldırılması ise bilinçli ürün kararı, geri getirilmesi gereken iş değil.
6. **Kontrolcü Faz 2:** yerleşik sanal gamepad/ViGEmBus eşleme planı henüz uygulanmadı. Faz 1 yalnız algılama ve yönlendirme sunuyor.
7. **Linux/macOS:** `docs/CROSS_PLATFORM.md` mimari araştırma; mevcut ürün/CI Windows x86_64 hedefinde. Platform desteği başlamış sayılmamalı.
8. **Steam indirme/kaldırma:** kurulum, güncelleme, doğrulama ve kaldırma Steam istemcisine `steam://` ile devrediliyor; Efxlve'nin kendi indirme kuyruğuna entegre değil. Bu dokümanda bilinçli kapsam kararı olarak işaretli.

## Dokümantasyon ve yayın akışı uyumsuzlukları

- `README.md:21-25` sürümü **0.1.16** gösteriyor; uygulama metadata'sı **0.1.17**. README GOG'u “coming soon”, profili “friends” içeriyor ve TV Mode'u “coming soon” yazıyor; GOG/TV Mode mevcut, arkadaş ekranı ise kaldırıldı.
- `CONTRIBUTING.md:20` TV Mode'u gelmemiş gibi tarif ediyor; `docs/OPENCODE.md:7-11` de güncel sürümü 0.1.16 gösteriyor.
- `AGENTS.md` üst özeti **1.307** i18n anahtarı diyor; `docs/CODEBASE_MAP.md` **1.421**, `docs/REFACTOR_PLAN.md` **1.361** diyor; güncel locale sayımı **1.433**. `CODEBASE_MAP` ve refactor handoff ayrıca modül/faz/satır sayılarını güncellemeli.
- `docs/TAURI_IPC_REFERENCE.md:64`, önbellek kütüphanesinin `<15ms` olduğunu iddia ediyor; güncel çalışma günlüğündeki ölçüm 820 oyun için yaklaşık **0,67–0,69 sn**.
- `docs/ROADMAP.md` eski arkadaş/i18n backlog maddelerini hâlâ aktif gibi tutuyor; `GOG_SUPPORT_PLAN.md` uygulama bekliyor, `GOG_DEV_STATUS.md` Faz 0 gösteriyor. Gerçek durumla tekrar hizalanmalılar.
- `release.yml:70` her yayın için genel bir Türkçe placeholder release body kullanıyor. Sürüm notları İngilizce ve changelog ile eşleşecekse workflow bunu sağlamıyor.
- `AGENTS.md` commit zorunluluğu koyarken `docs/OPENCODE.md:5` bu kuralı OpenCode oturumlarında geçersiz sayıyor ve açık kullanıcı isteği olmadan commit'i yasaklıyor. Ajan iş akışı kuralı tekleştirilmeli.
- `AGENTS.md` yaklaşık **620 satır** ve tarihçe/tekrar içeriyor; dosyanın kendi “kısa tut” kuralıyla çelişiyor. Operasyonel kurallar kısa tutulup tarihçe `CHANGELOG_INTERNAL.md`'ye bırakılmalı.

## İyi çalışan temeller

- Rust testleri geniş: 173 deterministik test geçti; canlı/ağ testlerinin 16'sı `ignored` olarak ayrılmış.
- 15 dilde anahtar paritesi ve boş değer kontrolü temiz.
- Kütüphane için 48 kartlık ilk grup ve 36'lık ek gruplar; indirme olaylarında yerinde DOM yamalama; cache-first açılış ve O(1) haritalar korunuyor.
- Gamepad ve indirme çizelgesi döngüleri yalnızca ilgili etkileşim/iş varken çalışıyor; CSS taramasında tekrarlanan kartlarda `backdrop-filter` bulunmadı.
- Mevcut denetim çalışma ağacında `npm.cmd run build`, `cargo check` ve `cargo test` başarılı.

## Önerilen uygulama sırası

1. Epic/GOG account ID dosya yolu sınırlarını kapatın; QR saklama tercihini görünür ve tutarlı yapın; DPAPI açıklamasını gerçekle eşitleyin.
2. Download progress → `updateBadge` → sidebar zincirindeki kare başına tüm-kütüphane işini kaldırın.
3. Steam dosya tarama/base64 yollarını UI iş parçacığından çıkarın; Steam istemci hesabı seçimini tekleştirin.
4. PR CI ekleyin ve `cargo fmt --check` farklarını düzeltin.
5. README/agent/IPC/roadmap/GOG handoff dokümanlarını güncel durumla hizalayın.
6. Sonra büyük dosya bölünmeleri ve dinamik frontend chunk'larına, referans donanımda ölçerek devam edin.
