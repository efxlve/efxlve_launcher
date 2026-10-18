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
- **Kişisel puan (1-10)**: Argon "ölü özellik" dedi, düşürdüm; durum rozeti
  (Oynanıyor/Bitti/%100/Bırakıldı) kalıyor. Geri alması kolay.
- **Benzer oyunlarda IGDB görselleri Genel Bakış'a düşmeyecek**: Argon'un
  gerekçesi (sayfayı daha çok mağaza gibi gösterir + görsel takas olur) kabul.
- **Bekleyen kartlar yer tutar** (sağ panel + kişisel bloklar): uygulandı.
- **Yönet paneli Sistem sekmesinde yaşar**, "Yönet" düğmesi sekme durumuna
  dokunmaz: uygulandı.
- **hidaaan'ın iki raporu** düzeltildi: süre toplamı tüm mağaza kopyalarını
  topluyor (`a790525d`), ekran görüntüsü başlıkları kartın içinde kısaltılıyor
  (`189e128e`, `5bcf55a8`).

## Sırada (yokluğunda devam edenler)

- **Aşama C2 — yapıldı**: sağ paneldeki iki kart tek çerçeveye alındı
  (`gp-scores-card`): başlık ve sıra kartın, puanlar ve süreler **kendi alt
  kutularında** (iki asenkron boyayıcı birbirini silmiyor). Puanlar artık 3'lü
  kompakt ızgarada. Oynanmış oyunda **önce süre, sonra dış puanlar** (Argon
  §8.1). Ayırıcı çizgi yalnızca iki blok da doluyken görünüyor.
- **"Desteklenmiyor" satırlarını gizleme — ertelendi**: Argon'un uyarısı haklı,
  `.muted` sınıfı "Klavye & Fare" gibi *desteklenen* değerlerde de kullanılıyor;
  gizlemek için satır başına açık bir bayrak gerekiyor. Bilgi gizleme riski
  kozmetik kazançtan büyük, o yüzden dokunulmadı.
- **Aşama B**: eylem satırı + `⋯` menüsü. Menü durumu `S`'te tutulacak (yoksa
  arka planda veri gelince menü kapanır), `#drawer-col-chips-container` korunacak.
  Etkileşim içerdiği için sahibinin bir tur açıp bakması iyi olur.
