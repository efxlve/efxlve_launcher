# Discord Entegrasyonu — Uygulama Planı

Tarih: 11.10.2026 · Durum: kapsam onaylandı, uygulama bekliyor.
Fizibilite kaydı: `docs/ROADMAP.md` §8 ("Discord Social SDK Entegrasyonu"). Bu dosya o kaydı görev görev uygulanabilir hâle getirir.

## Onaylanan kapsam

1. **Arkadaş listesi + canlı durumlar** — Discord Social SDK; hesap bağlama (Public Client + PKCE, sunucu yok).
2. **DM / sohbet paneli** — arkadaşa tıkla → mesaj geçmişi + gönderme.
3. **Sunucu daveti girişi** — Ayarlar ve Discord sayfasından Efxlve Discord daveti.
4. **Overlay Discord sekmesi** — presence anahtarı + yerel RPC ile ses kanalı okuma.
5. **Rich Presence zenginleştirme** — mevcut RPC üzerinden başarım ilerlemesi gibi ek bağlamlar.

## Mevcut durum (planın zemini)

| Parça | Yer | Not |
|---|---|---|
| Rich Presence worker | `src-tauri/src/presence.rs` | Varsayılan kapalı; `discord-rich-presence` crate |
| Presence bağlamı | `src/features/presence/presence.ts` | Aktivite metni üretimi; `LAUNCHER_ICON` bir commit hash'ine sabit (`@b371b6b`) — kırılgan |
| Presence komutları | `epic_presence_configure/update/clear` | `src-tauri/src/main.rs` handler listesi; TS sarmalayıcı `src/epic-commands.ts` |
| Ayarlar | `src/features/settings/settings-view.ts` | `toggle-presence` ve `toggle-discord-page` anahtarları zaten var; "Sosyal" grubu (`settings.secSocial`) mevcut |
| Sidebar | `index.html` | Discord düğmesi `data-act="coming-soon"`; gerçek sayfa yok |
| Overlay sekmesi | `src/features/overlay/overlay.ts` | İskelet var: `TabId`/`TABS` girişi + `renderDiscord()` (presence bilgi kartı, "Open Discord", ses placeholder'ı) |
| Görünürlük | `src/core/page-visibility.ts` | `SHOW_DISCORD_KEY` ve `discordPageVisible()` hazır |
| View tipi | `src/core/types.ts` | `View` birleşiminde `"discord"` yok |
| Vendor | `src-tauri/vendor/` | Zaten `.gitignore`'da (EOS SDK deseni) |

## Uygulama kuralları (her görev için)

- **Bitti ölçütü:** TypeScript ise `npm.cmd run build`; Rust'a dokunulduysa ayrıca `cargo test --manifest-path src-tauri/Cargo.toml`; locale'e dokunulduysa ayrıca `npm.cmd run locales`.
- **Bir görev, bir commit** (`type: why`, İngilizce, imperatif); görev bitmeden sonrakine geçilmez.
- **Çevik bozulma:** SDK DLL'i yoksa, Discord kapalıysa veya bağlantı düşerse özellik boş durum gösterir; uygulama çökmez ve bugünkü gibi çalışır.
- **Boşta sıfır maliyet:** SDK tick'i yalnız bağlıyken ve Discord sayfası görünürken (~4 Hz); sayfa kapanınca `RunCallbacks` durur. Overlay RPC okuyucusu yalnız overlay'in Discord sekmesi açıkken çalışır.
- **Token güvenliği:** Token'lar `<appdata>/discord/` altında, DPAPI deseniyle (`src-tauri/src/steam_auth/vault.rs` örneği); repoya asla girmez.
- **IPC sözleşmesi:** JS camelCase, Rust snake_case; yeni komutlar `src-tauri/src/main.rs` handler listesine ve bir TS sarmalayıcıya eklenir.
- **i18n:** Her yeni metin `src/locales/*.json` dosyalarının tamamına (16 dosya, aynı anahtarlar); kodda `t("key")` karşılığı `en.json`'da bulunur.
- **Görsel dil:** Durum renkleri anlam taşır (yeşil çevrimiçi, amber boşta, kırmızı rahatsız etme, gri çevrimdışı); sayaçlarda `font-variant-numeric: tabular-nums`; ikonlar `icon("name", size)`.

---

## Faz 0 — Portal hazırlığı (kullanıcıda, ~30 dk)

1. Discord Developer Portal'da **Team + Application** oluştur (ad: `Efxlve Launcher`).
2. OAuth2 sekmesi: redirect `http://127.0.0.1/callback`, **Public Client** açık.
3. Sol menü → **Discord Social SDK → Getting Started** formunu doldur ve **Submit**; formda DM/communication scope ihtiyacını da belirt (Faz 3.3 buna bağlı).
4. **Downloads** sekmesinden C++ SDK zip'ini indir → `src-tauri/vendor/discord-sdk/` altına çıkar (gitignore'da kalır).
5. **Application ID**'yi ve SDK sürümünü geliştiriciye ilet.

**Bitti:** ID elde, DLL + header yerinde.

## Faz 1 — Bağımsız küçük işler (SDK'yı beklemeden yapılabilir)

### 1.1 Sunucu daveti girişi

- Ayarlar > Entegrasyonlar > Sosyal grubuna "Discord sunucusuna katıl" satırı; mevcut dış bağlantı deseni kullanılır (`data-act="open-external-url"`).
- Discord sayfası gelince (Faz 3.1) sayfaya da davet çipi eklenir.
- Dosyalar: `src/features/settings/settings-view.ts`, `src/locales/*.json`.
- **Bitti:** `npm.cmd run build` + `npm.cmd run locales` — commit: `feat: add a join-server entry for Discord`.

### 1.2 Rich Presence zenginleştirme (mevcut RPC)

- Oyundayken başarım ilerlemesi satırı (ör. `presence.achievements` → "12/40 başarım"); crate'in düğme desteği doğrulanırsa isteğe bağlı URL düğmesi.
- `LAUNCHER_ICON` sabit commit'ten (`@b371b6b`) tag veya `main`'e alınır (kırılganlık düzeltmesi).
- Dosyalar: `src/features/presence/presence.ts`, `src/locales/*.json`.
- **Bitti:** build + locales; oyun / mağaza / müzik bağlamları bozulmamış. Commit: `feat: enrich Discord presence with achievement progress`.

## Faz 2 — Social SDK çekirdeği

### 2.1 Kanıt (spike, yarım gün)

- DLL yüklenir (`libloading` veya doğrudan link), `AddLogCallback` + `SetStatusChangedCallback` ile durum izlenir, `Authorize` + `GetToken` akışı çalıştırılır, **arkadaş sayısı** okunur.
- İzole canlı test; kalıcı yüzey yok. İlk dosya: `src-tauri/src/discord/`.
- **Bitti:** aday listesi canlı testte geliyor. Commit: `feat: prove the Discord Social SDK loads and authorizes`.
- Fallback doğrulanır: DLL silinince uygulama normal açılır.

### 2.2 FFI köprüsü + hesap kasası

- `src-tauri/src/discord/` modülü: FFI köprüsü (C API varsa doğrudan, yoksa `cc` ile derlenen ince C++ shim), auth durumu ve yenileme (`RefreshToken`).
- Token saklama: `<appdata>/discord/` — DPAPI deseni; yol birleştirme öncesi id doğrulaması (vault kuralı).
- Komutlar: `discord_status`, `discord_connect`, `discord_disconnect`; `main.rs` handler listesi; `src/discord-commands.ts` sarmalayıcı.
- Tick yalnız bağlı + görünüm açıkken (~4 Hz).
- **Bitti:** `cargo test` + build; token diske şifreli yazılıyor; Discord kapalıyken backoff, çökme yok. Commit: `feat: add the Discord SDK bridge and account vault`.

### 2.3 Arkadaş listesi + presence olayları

- `src-tauri/src/discord/friends.rs`: arkadaşlar + avatarlar + durumlar (çevrimiçi/boşta/rahatsız etme/çevrimdışı) + "şu an X oynuyor" + Unified Friends kimlikleri.
- Olaylar Tauri event'i olarak yayınlanır (polling yok); `discord_friends` komutu tam listeyi döndürür.
- **Bitti:** `cargo test` + build. Commit: `feat: stream Discord friends and presence events`.

## Faz 3 — Launcher arayüzü

### 3.1 Discord sayfası

- `View` birleşimine `"discord"`; sidebar düğmesi `data-view="discord"` olur ve "Coming soon" kalkar (`index.html`); `nav.ts` yönlendirmesi; görünürlük `discordPageVisible()` ile çalışmaya devam eder.
- Yeni ekran: `src/features/discord/` — arkadaş listesi, durum noktaları, "şu an oynuyor", arama, boş durumlar (bağlı değil / DLL yok / Discord kapalı), davet çipi.
- **Bitti:** build; sayaçlarda `tabular-nums`, durum renkleri kurala uygun. Commit: `feat: add the Discord social page`.

### 3.2 Ayarlar kartı

- Entegrasyonlar > Sosyal grubuna Discord kartı: **Bağlan / Bağlantıyı Kes / durum** + davet linki (1.1 ile birleşir). Mevcut `toggle-discord-page` anahtarı korunur.
- Dosyalar: `src/features/settings/settings-view.ts`, `src/locales/*.json`.
- **Bitti:** build + locales. Commit: `feat: add the Discord integration card`.

### 3.3 DM paneli

- Discord sayfasında sağ panel: kanal listesi + mesaj geçmişi + gönderme; yalnız sayfa görünürken tick.
- Communication scope onayına bağlı (Faz 0/3); onay yoksa bu görev atlanır, sayfa arkadaş listesiyle kalır.
- **Bitti:** build; hata ve boş durumlar temiz. Commit: `feat: add Discord direct messages`.

## Faz 4 — Overlay Discord sekmesi (yerel RPC; Social SDK'dan bağımsız)

### 4.1 Rust RPC okuyucu

- Yerel Discord IPC'ye `rpc` (+ `rpc.voice.read`) scope'u ile bağlanan ayrı worker (ör. `src-tauri/src/discord_rpc.rs`); `GET_SELECTED_VOICE_CHANNEL` + konuşma olayları.
- Kural: yalnız overlay'in Discord sekmesi açıkken bağlan/oku; sekme kapanınca bağlantı sessizce durur.
- **Bitti:** `cargo test`; Discord kapalıyken sessiz bekleme. Commit: `feat: read the Discord voice channel over local RPC`.

### 4.2 Overlay arayüzü

- `renderDiscord()` gerçek içerik: presence anahtarı (launcher ayarıyla aynı değeri gösterir), ses kanalı + katılımcılar + konuşan göstergesi, mevcut "Open in Discord".
- Yazma işlemleri (mute/deafen) partner onayı gerektirir; onay yoksa gizli/disabled kalır.
- Dosyalar: `src/features/overlay/overlay.ts`, `overlay.css`, `src/locales/*.json`.
- **Bitti:** build; kanal yokken temiz boş durum. Commit: `feat: build the overlay Discord tab`.

## Faz 5 — Paketleme + yayın

- DLL'in kurulum paketine girişi (`src-tauri/tauri.conf.json` → `bundle.resources`) ve dev/prod yol çözümü; dosya yoksa özellik kapalı davranır.
- SDK lisansı: entegre dağıtım serbest, tek başına dağıtım yasak — `README.md` kredilerine Discord Social SDK eklenir.
- Sürüm notu girdisi `src/features/changelog/changelog-view.ts` üzerinden (release akışı).
- **Bitti:** build + paketleme denemesi. Commit: `chore: ship the Discord SDK with the installer`.

## Riskler ve önlemler

| Risk | Önlem |
|---|---|
| Portal formu / entegrasyon incelemesi reddedilebilir | Doğru form + gerektiğinde Discord ile iletişim; SDK yoksa uygulama bugünkü gibi çalışır |
| SDK kaldırılır/limitlenirse | Özellik tamamen opsiyonel; DLL yoksa boş durum, çökme yok |
| Tick döngüsü performans kuralını ihlal ederse | Yalnız görünür sayfa/sekme + ~4 Hz; kapanınca durur |
| Token sızıntısı | DPAPI kasası, `<appdata>/discord/`, repoya asla; path id doğrulaması |
| SDK DLL boyutu kurulumu şişirirse | Faz 5'te ölçülür; gerekiyorsa ayrı indirme adımı (boşta kalırken çalışmamazlık yok) |
| Ses yazma partner onayı gelmezse | Salt okunur widget (konuşan göstergesi); yazma düğmeleri gösterilmez |

## Tahmin

| Faz | Süre | Kim |
|---|---|---|
| 0 — Portal | ~30 dk | Kullanıcı |
| 1 — Davet + presence | ~0.5-1 gün | Geliştirme |
| 2 — SDK çekirdeği | ~1.5-2 gün | Geliştirme |
| 3 — Arayüz (DM dahil) | ~1.5 gün | Geliştirme |
| 4 — Overlay sekmesi | ~1 gün | Geliştirme |
| 5 — Paketleme | ~0.5 gün | Geliştirme |

Toplam: **kullanıcı ~30 dk + ~5-6 geliştirme günü.**

## Açık kararlar

1. **DLL dağıtımı:** SDK dosyaları repoda mı tutulacak yoksa CI'a artefakt olarak mı verilecek? (Dev aşamasında `vendor/` gitignore'lu kalır; kesin karar Faz 5'te.)
2. **DM scope:** communication scope onayı Discord formunda istenir; onay gelmezse Faz 3.3 atlanır.
3. **Voice write:** `rpc.voice.write` partner-only; onay gelmezse overlay salt okunur.
4. **Presence birleştirmesi:** mevcut RPC presence ile Social SDK presence şimdilik yan yana yaşar; birleştirme ayrı bir karar (önce SDK çalışsın).
