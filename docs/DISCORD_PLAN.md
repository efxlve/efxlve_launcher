# Discord Entegrasyonu — Uygulama Planı

Tarih: 11.10.2026 · Revizyon: Social SDK bağımlılığı kaldırıldı; gömülü web istemcisi + yerel RPC ana yol oldu.
Güncelleme (11.10.2026): Social SDK başvurusu **onaylandı**, uygulama etkinleştirildi. SDK, Faz 4 (native arkadaş listesi) için kayıtlı opsiyondur; ana yol webview olarak kalır.

Fizibilite kaydı: `docs/ROADMAP.md` §8. Ana yolun gerekçesi:

- **DM/metin/ses** SDK'da **İletişim Erişimi** (Comms Access) adlı ayrı ve kapalı bir betaya bağlı; minimumlar oyun-içi (Account Linking + Rich Presence + Game Invites + Unified Friends) → launcher için belirsiz. Webview'da DM bugün sorunsuz çalışır.
- Onaysız çalışan tek tam yol: resmî web istemcisinin gömülmesi (`discord.com/app`) — Spotify sayfasının (`src-tauri/src/spotify_host.rs`) birebir aynı deseni.
- SDK yolu DLL + FFI + token kasası + paketleme getirir (~2-3 gün ek); ana kazanımı native arkadaş listesidir. İstenirse webview sonrası eklenir (Faz 4).
- Alternatif native yol: yerel RPC `GET_RELATIONSHIPS` + `RELATIONSHIP_UPDATE` — DLL'siz, ama `relationships.read` ayrıca Discord onayı ister; SDK erişimi varken tercih sırası SDK'dır.

Kaynak: Discord developer docs (RPC, OAuth2 scopes, Social SDK) ve `docs.discord.food` RPC referansı (11.10.2026).

## Revize kapsam

1. **Discord sayfası (webview):** `discord.com/app` gömülü; arkadaşlar, DM, sunucular Discord'un kendi arayüzünde — launcher içinde, onaysız.
2. **Sunucu daveti girişi:** Ayarlar + Discord sayfasından Efxlve daveti.
3. **Rich Presence zenginleştirme:** mevcut RPC worker'a başarım ilerlemesi vb. (bugünkü gibi onaysız).
4. **Overlay Discord sekmesi:** presence anahtarı + yerel RPC ile ses kanalı/konuşan göstergesi (tester slotu; partner onayı gelmezse salt okunur).
5. **(Park) Native arkadaş listesi:** SDK erişimi hazır; webview sonrası isteğe bağlı (bkz. Faz 4).

## İlerleme (12.10.2026)

- **Faz 0** — tamam: SDK başvurusu onaylandı (kayıtlı opsiyon).
- **Faz 1.1** — tamam (`4fb50e21`): Ayarlar > Entegrasyonlar > Sosyal'de Discord kartı ("Launcher'da Aç" + "Sunucuya katıl"); Discord sayfası başlığında davet düğmesi. Davet sabiti `core/constants.ts` → `DISCORD_INVITE_URL`.
- **Faz 1.2** — tamam (`f614a6e5`): oyundayken ikinci satırda kupa ilerlemesi (`presence.trophies`); `LAUNCHER_ICON` artık `@main` (commit sabitlemesi kaldırıldı).
- **Faz 2.1** — tamam (`85a662f`, `f969a7c`): child WebView2 host + spike. Sayfa açılıyor, giriş yapılabiliyor.
- **Faz 2.2/2.3** — büyük ölçüde tamam: yükleme notu + yenile düğmesi (`fbb6f58d`), web istemcisi boyayana kadar gizli + 45 sn emniyet (`dc1df706`), minimize "sliver" koruması (`c575823a`) ve görünürlük/odak yeniden senkronu, dış bağlantılar sistem tarayıcısında (`8a1d969f`), gömülü web'e mikrofon/kamera izni (`897b3ad4`) — **sesli sohbet web istemcisinde çalışıyor**.
- **Faz 2.4** — tamam (`4fb50e21`, 1.1 ile birlikte): Ayarlar kartı.
- **Faz 3.1** — tamam (`2402d4a3`): akış kanıtlandı — `AUTHORIZE` yalnız `pkce + response_type: "code"` ile kod veriyor, token takası 200, `GET_SELECTED_VOICE_CHANNEL` katılımcıları getiriyor, `SPEAKING_START/STOP` akıyor (log: `%APPDATA%\com.efxlve.launcher\logs\discord-rpc.log`).
- **Faz 3.2** — tamam (`2804005d`): kalıcı okuyucu worker; token'lar DPAPI ile `<appdata>/discord/token.bin`'de, süresi dolunca sessizce yenilenir; tek bağlantı, ≥30 sn backoff.
- **Faz 3.3** — tamam (`f9880d71`, `e16d22d2`, bu commit): overlay Discord sekmesi canlı kanal + katılımcılar + konuşma halkası gösteriyor; onay isteği panel kapanınca iptal olmuyor; panel kapanınca worker 90 sn sıcak kalıyor (hızlı Shift+Tab aynı bağlantıyı kullanır) ve (yeniden) bağlanırken son bilinen kanal soluk gösteriliyor.
- **Faz 4** — **tamam** (`48dcf57e`, `65d68275`, `120b793c`): F10 probu `relationships.read` kapsamını aldı; worker kapsam farkındalıklı token'la arkadaş listesini okuyor (`RELATIONSHIP_UPDATE` + 45 sn tazeleme); overlay Discord sekmesindeki Arkadaşlar kartı doğrulandı (7 çevrimiçi · 6 bekleyen istek · 12 satır + "+35 kişi daha"). Presence gerçek: log `presence [activity,status]`.
- **Masaüstüsüz Discord verisi** — tamam ve kullanıcı testiyle doğrulandı (`9e92ebcf` … `3527b589`): gömülü Discord sayfasından salt-okunur okuma; hook (`Function.prototype.m`) doğan her webpack runtime'ını hatırlar, prob **istemcinin kendi runtime'ını** seçer (`/assets/` + sabit olmayan chunk-adı fonksiyonu + en çok yüklü modül — yardımcı runtime'lar aynı `p`'ye sahip olabiliyor), Flux `Store.getAll()` + `getName()` ile store haritası kurulur; **derin getter okuma ve fabrika örnekleme yok** (yarıda kalan modül sayfayı bozuyor). **Ses:** `SelectedChannelStore`/`ChannelStore`/`GuildStore`/`VoiceStateStore` + `SpeakingStore` (konuşma halkası web modunda da çalışıyor). **Arkadaşlar:** `RelationshipStore` + `PresenceStore` (masaüstü kapalıyken de dolu). Sayfa aramadayken ekran dışında sıcak kalır, arama bitince ya da raporlar 90 sn kesilince kapanır; **sayfa kapatılmadan hemen önce bir kez daha okunur** (hızlı "aramaya gir-çık" yarışı yok). Kart kaynak sırası: masaüstü RPC → web → son bilinen (soluk). ToS notu: yalnız gösterim — dispatch/REST/aksiyon yok.
- **Kalan:** polisaj (hata metinlerinin yerelleştirilmesi), Faz 5 (yayın notu + duyuru) ve **oyun içi arayüz revizyonu** (Spotify/Discord in-game kullanılabilirlik + estetik; sıradaki büyük iş).

## Mevcut durum

| Parça | Yer | Not |
|---|---|---|
| Gömme deseni (kopyalanacak) | `src-tauri/src/spotify_host.rs`, `spotify_extension.js` | Child WebView2, frontend slot dikdörtgeni, çıkışta gizleme; `efxlve.local` sahte host'la navigasyon yakalama |
| Webview yaşam döngüsü + bellek bütçesi | `src-tauri/src/store_host.rs` | Park/hide/show/destroy; `MAX_WARM_STORES = 1` (her webview ayrı renderer, ~60-260 MB) |
| Rich Presence worker | `src-tauri/src/presence.rs` | Varsayılan kapalı; `rpc.local` sayesinde onaysız çalışıyor |
| Presence bağlamı | `src/features/presence/presence.ts` | `LAUNCHER_ICON` artık `@main` (commit sabitlemesi kaldırıldı) |
| Sidebar / görünürlük / ayar | `index.html`, `src/core/page-visibility.ts`, `settings-view.ts` | `data-act="coming-soon"`, `SHOW_DISCORD_KEY`, `toggle-discord-page` hazır |
| Overlay iskeleti | `src/features/overlay/overlay.ts` | `discord` sekmesi canlı ses kanalı kartıyla çalışıyor |
| View tipi | `src/core/types.ts` | `"discord"` eklendi |

## Uygulama kuralları

- **Bitti ölçütü:** TS → `npm.cmd run build`; Rust → ayrıca `cargo test --manifest-path src-tauri/Cargo.toml`; locale → ayrıca `npm.cmd run locales`. Bir görev = bir commit (`type: why`).
- **Child webview:** `additional_browser_args` asla; tek Discord webview; **sayfadan çıkınca destroy** (bellek bütçesi); komut paleti/modallerde `store_host` deseniyle park; yeniden açılışta gereksiz reload yok.
- **RPC:** istemci başına dakikada 2 yeni bağlantı limiti → yeniden bağlanma ≥30 sn backoff; RPC okuyucusu yalnız ilgili yüzey açıkken çalışır, kapanınca 90 sn sıcak kalır (hızlı aç/kapa yeni bağlantı harcamasın).
- **ToS disiplini:** Discord sayfası kazınmaz/enjekte edilmez; webview yalnız gösterir (en fazla minimal CSS ile promosyon gizleme).
- **i18n:** yeni metinler `src/locales/*.json` dosyalarının tamamına (16 dosya, aynı anahtarlar); sayaçlarda `tabular-nums`; renkler durum anlamı taşır.

## Faz 0 — Discord formu (TAMAM, 11.10.2026)

- Başvuru onaylandı; uygulama Social SDK için etkinleştirildi. SDK artık Faz 4 için hazır opsiyon.
- **İletişim Erişimi'ne başvurulmadı**; DM hâlâ webview'da planlanıyor (istenirse sonra denenir).

## Faz 1 — Bağımsız küçük işler

### 1.1 Sunucu daveti girişi (küçük)

- Ayarlar > Entegrasyonlar > Sosyal'e davet satırı; Discord sayfası gelince sayfaya da çip.
- Dosyalar: `src/features/settings/settings-view.ts`, `src/locales/*.json`.
- **Bitti:** build + locales. Commit: `feat: add a join-server entry for Discord`.

### 1.2 Rich Presence zenginleştirme

- Oyundayken başarım ilerlemesi satırı; `LAUNCHER_ICON` sabit commit'ten tag veya `main`'e alınır.
- Dosyalar: `src/features/presence/presence.ts`, `src/locales/*.json`.
- **Bitti:** build + locales; oyun / mağaza / müzik bağlamları bozulmamış. Commit: `feat: enrich Discord presence with achievement progress`.

## Faz 2 — Discord sayfası (webview)

### 2.1 Gömme + spike (yarım gün)

- `spotify_host.rs` desenini uyarlayan Rust modülü (`src-tauri/src/discord_host.rs`): show/resize/hide/destroy komutları, `discord.com/app` başlangıç URL'si, navigasyon yakalama (efxlve.local), popup politikası (yalnız discord.com).
- Spike aynı görevde: sayfa açılıyor mu, **giriş** yapılabiliyor mu (QR/e-posta; captcha riski), oturum yeniden açılışta kalıcı mı; ses/video çalışmıyor notu.
- **Bitti:** `cargo test` + build; manuel test notları. Commit: `feat: host the Discord web client in a child webview`.

### 2.2 Sayfa kabuğu

- `View` birleşimine `"discord"`; sidebar düğmesi `data-view="discord"` olur ve "Coming soon" kalkar; `src/features/discord/` sayfası (slot yönetimi, yükleniyor/hata/boş durum, "yenile" ve "masaüstü uygulamasında aç" aksiyonları); `SHOW_DISCORD_KEY` görünürlüğü korunur.
- **Bitti:** build. Commit: `feat: add the Discord social page`.

### 2.3 Yaşam döngüsü sağlamlaştırma

- Sayfadan çıkınca destroy; komut paleti/modal hold; pencere resize; bildirim katmanıyla uyum (`store_host` guard desenleri); mağaza sayfalarıyla aynı anda açık kalma senaryoları.
- **Bitti:** build; manuel senaryo listesi (palette, modal, resize, minimize). Commit: `fix: keep the Discord webview out of the renderer budget`.

### 2.4 Ayarlar kartı

- Entegrasyonlar > Sosyal'e Discord kartı: "Discord'u Launcher'da Aç" düğmesi + davet linki + kısa açıklama (giriş Discord sayfasında yapılır; launcher şifre görmez).
- Locale'ler + `npm.cmd run locales`.
- **Bitti:** build + locales. Commit: `feat: add the Discord integration card`.

## Faz 3 — Overlay Discord sekmesi (yerel RPC)

### 3.1 RPC spike (yarım gün)

- Tester slotuyla (`discord-ipc-0..9`) handshake + `AUTHORIZE` (`rpc`, `rpc.voice.read`) çalışıyor mu; `GET_SELECTED_VOICE_CHANNEL` ve `SPEAKING_START/STOP` geliyor mu?
- Onay/limit engeli çıkarsa plan B: overlay'de yalnız mevcut "Open Discord" kalır; webview fazı etkilenmez.
- **Bitti:** canlı test sonucu. Commit: `feat: prove the Discord local RPC flow`.

### 3.2 Rust okuyucu worker

- `src-tauri/src/discord_rpc.rs`: tek IPC bağlantısı, ≥30 sn backoff, yalnız overlay Discord sekmesi açıkken; presence worker'ından ayrı ama onunla çakışmayacak şekilde.
- **Bitti:** `cargo test`. Commit: `feat: read the Discord voice channel over local RPC`.

### 3.3 Overlay arayüzü

- `renderDiscord()` gerçek içerik: presence anahtarı + kanal/katılımcılar/konuşan göstergesi; mute/deafen partner-only → yok; "Open in Discord" kalır.
- **Bitti:** build; kanal yokken temiz boş durum. Commit: `feat: build the overlay Discord tab`.

## Faz 4 — Arkadaş listesi (12.10.2026: başlandı)

- Sıra: **(1) Yerel RPC `GET_RELATIONSHIPS`** — `relationships.read` kapsamı OAuth2 listesine göre Social SDK erişiminin parçası; SDK onayı verildiği için denenebilir. DLL/FFI yok, mevcut pipe + token altyapısı kullanılır. **(2) Social SDK** — (1) reddedilirse: portal → Social SDK → Downloads'tan C++ paketi (Windows: `discord_partner_sdk.dll` + `.lib`; C++20 header-only wrapper `discordpp.h`, Rust için C API'ye FFI), DLL paketleme + token kasası (~2-3 gün).
- Adım 1 (spike) — **tamam** (`48dcf57e`): F10 probu kapsamı aldı ve `GET_RELATIONSHIPS` 54 ilişki döndürdü; DLL'siz RPC yolu seçildi.
- Adım 2 — **tamam** (`65d68275`, `120b793c`): kapsam farkındalıklı token (`relationships.read` eksikse yeniden onay), `RELATIONSHIP_UPDATE` takibi ve 45 sn'de bir tazeleme; olay: `discord-friends-state`.
- Doğrulama (kullanıcı, 12.10.2026): kart "7 çevrimiçi · 6 bekleyen istek" + 12 satır + "+35 kişi daha"; log `relationships shape: [presence,type,user] presence [activity,status]` → presence gerçek, durum noktaları doğru.
- UI kararı: overlay Discord sekmesindeki Arkadaşlar kartı (çevrimiçi önce, durum noktası, "+N kişi daha"); launcher tarafında ayrı yüzey (Discord sayfası yanında panel/sidebar widget) isteğe bağlı sonraki adım.
- DM: İletişim Erişimi onaylanmadıkça SDK'dan gelmez; webview'da yaşamaya devam eder.

## Faz 5 — Yayın

- Sürüm notu/changelog girdisi (`src/features/changelog/changelog-view.ts` + release akışı).
- Paketlenen üçüncü parti bileşen yok; README kredi değişikliği gerekmez.

## Riskler

| Risk | Önlem |
|---|---|
| discord.com bu WebView2'de girişe izin vermez (captcha/UA) | 2.1 spike'ı bunu ilk yarım günde kesinleştirir; QR giriş yedeği; olmazsa masaüstü uygulamasına yönlendirme + davet köprüsü (plan B) |
| Renderer bellek bütçesi aşılır | Çıkışta destroy; mağaza ile aynı anda tutmama; `MAX_WARM_STORES` disiplini |
| Discord arayüzü değişir | Enjeksiyon yok → kırılmaz |
| ToS | "Sadece göster" modu: kazıma/otomasyon/token çıkarma yok |
| RPC onayı/limiti | Overlay salt okunur kalır ya da park edilir; webview yolu etkilenmez |

## Tahmin

| Faz | Süre | Kim |
|---|---|---|
| 0 — Form | Tamam (11.10.2026) | Kullanıcı |
| 1 — Davet + presence | ~0.5-1 gün | Geliştirme |
| 2 — Webview sayfası (spike dahil) | ~1.5-2 gün | Geliştirme |
| 3 — Overlay RPC (spike dahil) | ~1 gün (engel çıkarsa ~0.5 gün + park) | Geliştirme |

Toplam: **~3-4 geliştirme günü** (SDK yolu: 5-6 gün + onay riski + DLL paketleme).

## Açık kararlar

1. Faz 4 (native arkadaş listesi) webview sonrasında istenecek mi? SDK erişimi hazır; maliyet ~2-3 gün.
2. DM native panel yapılmayacak; DM webview'da (Discord onayı gelmedikçe).
3. Overlay'de ses yazma (mute/deafen) partner onayına bağlı; şimdilik yok.
