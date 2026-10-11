# Discord Entegrasyonu — Uygulama Planı

Tarih: 11.10.2026 · Revizyon: Social SDK bağımlılığı kaldırıldı; gömülü web istemcisi + yerel RPC'ye geçildi.

Fizibilite kaydı: `docs/ROADMAP.md` §8. Revizyonun nedeni:

- Discord Social SDK fiilen **oyun geliştiricileri** için konumlanmış: başvuru formu oyun bilgisi istiyor ("Bize oyunun hakkında bilgi ver"); DM dahil iletişim özellikleri ayrı bir **Comms Access kapalı betasına** bağlı (oyun-içi Account Linking + Rich Presence + Game Invites + Unified Friends şartları).
- Arkadaş verisine giden **tüm programatik yollar Discord onayına bağlı**: Social SDK, yerel RPC `relationships.read` ("requires Discord approval") ve Embedded (Activities) SDK.
- Onaysız çalışan tek tam yol: resmî web istemcisinin gömülmesi (`discord.com/app`) — Spotify sayfasının (`src-tauri/src/spotify_host.rs`) birebir aynı deseni.
- Discord onayı ileride gelirse, native arkadaş listesi **RPC `GET_RELATIONSHIPS` + `RELATIONSHIP_UPDATE`** ile (DLL/FFI olmadan) bonus olarak eklenebilir.

Kaynak: Discord developer docs (RPC, OAuth2 scopes, Social SDK) ve `docs.discord.food` RPC referansı (11.10.2026).

## Revize kapsam

1. **Discord sayfası (webview):** `discord.com/app` gömülü; arkadaşlar, DM, sunucular Discord'un kendi arayüzünde — launcher içinde, onaysız.
2. **Sunucu daveti girişi:** Ayarlar + Discord sayfasından Efxlve daveti.
3. **Rich Presence zenginleştirme:** mevcut RPC worker'a başarım ilerlemesi vb. (bugünkü gibi onaysız).
4. **Overlay Discord sekmesi:** presence anahtarı + yerel RPC ile ses kanalı/konuşan göstergesi (tester slotu; partner onayı gelmezse salt okunur).
5. **(Park) Native arkadaş listesi:** Discord onayı gelirse RPC üzerinden; gelmezse yok.

## Mevcut durum

| Parça | Yer | Not |
|---|---|---|
| Gömme deseni (kopyalanacak) | `src-tauri/src/spotify_host.rs`, `spotify_extension.js` | Child WebView2, frontend slot dikdörtgeni, çıkışta gizleme; `efxlve.local` sahte host'la navigasyon yakalama |
| Webview yaşam döngüsü + bellek bütçesi | `src-tauri/src/store_host.rs` | Park/hide/show/destroy; `MAX_WARM_STORES = 1` (her webview ayrı renderer, ~60-260 MB) |
| Rich Presence worker | `src-tauri/src/presence.rs` | Varsayılan kapalı; `rpc.local` sayesinde onaysız çalışıyor |
| Presence bağlamı | `src/features/presence/presence.ts` | `LAUNCHER_ICON` bir commit hash'ine sabit (`@b371b6b`) — düzeltilecek |
| Sidebar / görünürlük / ayar | `index.html`, `src/core/page-visibility.ts`, `settings-view.ts` | `data-act="coming-soon"`, `SHOW_DISCORD_KEY`, `toggle-discord-page` hazır |
| Overlay iskeleti | `src/features/overlay/overlay.ts` | `discord` sekmesi + `renderDiscord()` placeholder var |
| View tipi | `src/core/types.ts` | `"discord"` yok |

## Uygulama kuralları

- **Bitti ölçütü:** TS → `npm.cmd run build`; Rust → ayrıca `cargo test --manifest-path src-tauri/Cargo.toml`; locale → ayrıca `npm.cmd run locales`. Bir görev = bir commit (`type: why`).
- **Child webview:** `additional_browser_args` asla; tek Discord webview; **sayfadan çıkınca destroy** (bellek bütçesi); komut paleti/modallerde `store_host` deseniyle park; yeniden açılışta gereksiz reload yok.
- **RPC:** istemci başına dakikada 2 yeni bağlantı limiti → yeniden bağlanma ≥30 sn backoff; RPC okuyucusu yalnız ilgili yüzey açıkken çalışır.
- **ToS disiplini:** Discord sayfası kazınmaz/enjekte edilmez; webview yalnız gösterir (en fazla minimal CSS ile promosyon gizleme).
- **i18n:** yeni metinler `src/locales/*.json` dosyalarının tamamına (16 dosya, aynı anahtarlar); sayaçlarda `tabular-nums`; renkler durum anlamı taşır.

## Faz 0 — Discord formu (sen, ~15 dk, opsiyonel)

- Formu gönder; amaç yalnızca Faz 4 bonusu. **Onay gelmemesi hiçbir şeyi bloke etmez.**
- Öneri: "Tam Ad" alanına ürün adı değil **gerçek adın** yazılsın; launcher olduğunu açıklayabileceğin bir alan varsa dürüstçe yaz.
- Bitti: form gönderildi (veya bilinçli atlandı).

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

## Faz 4 — (Park) Native arkadaş listesi — Discord onayına bağlı

- Koşul: `relationships.read` onayı (Faz 0 formu ya da ayrı başvuru).
- Yol: RPC `GET_RELATIONSHIPS` + `RELATIONSHIP_UPDATE` (DLL/FFI yok). UI kararı o zaman verilir (Discord sayfasının yanında native panel ya da sidebar widget'ı).
- Onay yoksa bu faz yok; arkadaşlar ve DM webview'da yaşamaya devam eder.

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
| 0 — Form | ~15 dk | Kullanıcı (opsiyonel) |
| 1 — Davet + presence | ~0.5-1 gün | Geliştirme |
| 2 — Webview sayfası (spike dahil) | ~1.5-2 gün | Geliştirme |
| 3 — Overlay RPC (spike dahil) | ~1 gün (engel çıkarsa ~0.5 gün + park) | Geliştirme |

Toplam: **~3-4 geliştirme günü** (SDK yolu: 5-6 gün + onay riski + DLL paketleme).

## Açık kararlar

1. Form onayı gelirse Faz 4 (RPC ile native arkadaş listesi) eklenecek mi?
2. DM native panel yapılmayacak; DM webview'da (Discord onayı gelmedikçe).
3. Overlay'de ses yazma (mute/deafen) partner onayına bağlı; şimdilik yok.
