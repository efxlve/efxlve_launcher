# Known issues

Open bugs with enough evidence to pick up cold. Fix one, delete its entry here.

## Epic update never applies (Dead by Daylight) — 12.10.2026

**Symptom (kullanıcı raporu):** DBD (Epic) güncellemesi hiç uygulanmıyor; oyun her seferinde "güncelleme bekliyor" olarak görünüyor.

**Kanıt:**
- Updates satırı: `DBD_Udori_WF2_EGS_Shipping_6.3797605_10.1.2.4 → DBD_Vanilla_REL_EGS_Shipping_9.3871532_10.2.0.7`.
- Update'e basınca kuyruk **60,7 GB toplam** gösteriyor (yama değil, tüm oyun boyutu) ve **0 B/s / %0**'da takılı kalıyor.
- Completed listesine iki kayıt düştü (01:03 ve 01:21, ikincisi 60,7 GB) ama yerel sürüm hâlâ 10.1.2.4; yani "tamamlandı" işaretlenen transfer `installed.json` sürümünü değiştirmiyor.
- Completed satırındaki düğme "Downloading %0..." gösteriyor (S.downloads kaydı `done` olmadan kalmış olabilir).

**Şüpheliler (yarın bakılacak):**
1. `legendary` güncelleme akışı: DBD'nin Epic artefaktları farklı (kurulu `Udori_WF2` ↔ hedef `Vanilla_REL`); legendary tam indirmeyi seçip sonunda sürümü yazmıyor olabilir.
2. `src-tauri/src/legendary/commands/ops.rs` → `epic_check_updates`: `installed.json.version` ile metadata `asset_infos.Windows.build_version` karşılaştırılıyor; metadata'da birden fazla Windows artefaktı olabilir (tek giriş varsayımı).
3. `src-tauri/src/legendary/transfers/queue.rs` (~940-1000) Success yolu: `sync_egl_manifest_version` çağrılıyor ama `installed.json` sürümü legendary'nin yazmasına bağlı; bu akışta güncellenmiyorsa launcher tarafında ele alınmalı.
4. 0 B/s takılma: ağ/Warp kaynaklı mı, legendary stall mı? `download-failed`/`download-cancelled` yerine "completed" düşmesi ayrı bir hata olabilir (düğme metniyle birlikte).

**Bakılacak yerel dosyalar:**
- `%USERPROFILE%\.config\legendary\installed.json` (DBD kaydı)
- `%USERPROFILE%\.config\legendary\metadata\<appName>.json` (`asset_infos`)
- `%APPDATA%\com.efxlve.launcher\logs\legendary-error.log`
- Mümkünse update akışında legendary'nin kendi çıktısı

**Not:** Güncelleme akışının hiçbir yerinde oyun başlatılmıyor (12.10 incelemesi). Aynı gece çalışan bir DBD penceresi görüldü; kaynağı (Play/kısayol) doğrulanmadı — tekrarlarsa ayrıca bakılacak.
