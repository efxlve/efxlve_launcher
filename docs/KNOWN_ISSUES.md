# Known issues

Open bugs with enough evidence to pick up cold. Fix one, delete its entry here.

## Epic update never applies (Dead by Daylight) — 12.10.2026

**Symptom:** DBD (Epic) güncellemesi uygulanmıyor; oyun her seferinde "güncelleme bekliyor" görünüyor, launcher ise "Completed" kaydı düşürüyor.

**12.10 sabah incelemesi (dosya kanıtlarıyla):**
- Elle `legendary -y install Brill --base-path "C:\Program Files\Epic Games" --skip-dlcs --skip-sdl` **çalışıyor**: oturum geçerli, indirme başlıyor (3-5 MiB/s, 38.642 parça). Boy 60,7 GB çünkü Epic artefaktı değişmiş:
  kurulu `DBD_Udon_HF2_EGS_Shipping_6_3797605_10.1.2.4` → hedef `DBD_Vanilla_REL_EGS_Shipping_9_3871532_10.2.0.7`.
- `installed.json` hâlâ 10.1.2.4; dünkü iki "Completed" kaydı gerçek tamamlanma değil.
- `legendary-error.log` dünü içermiyor (7 Ekim'den kalma DPoP hatası; güncel değil).
- Denemeler sırasında oyun açık olabilir (01:11'de çalışan "Dead by Daylight" penceresi) → kilitli dosyalar.

**Bulunan ve düzeltilen iki bug:**
1. `9435e40c` — hız satırı `+ Download\t- 3.00 MiB/s` biçimi parse edilemiyordu; UI sürekli **0 B/s** gösteriyordu ("takıldı" izlenimi buradan).
2. `2c3d074a` — legendary hata basıp **0 koduyla** çıkınca "tamamlandı" sayılıyordu; artık günlükteki sert hata yakalanıp başarısızlık olarak raporlanıyor.

**Sıradaki adım:** Oyun tamamen kapalıyken dev build'de Update → gerçek ilerleme/hata mesajını izle. Tamamlanırsa bu maddeyi kapat; hata dönerse mesaj elimizde olacak.

**Bakılacak yerel dosyalar (gerekirse):**
- `%USERPROFILE%\.config\legendary\installed.json` / `metadata\<appName>.json`
- `%USERPROFILE%\.config\legendary\tmp\<appName>.resume`
- `%APPDATA%\com.efxlve.launcher\logs\legendary-error.log`
