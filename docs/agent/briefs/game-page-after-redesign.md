# Brief: oyun sayfası — yeniden tasarım sonrası benimsenme turu

Sen bağımsız bir ürün ve deneyim incelemecisisin. Bir Windows oyun başlatıcısı
olan Efxlve Launcher'ın **oyun detay sayfası** hakkında görüşünü istiyorum.
SALT OKUNUR çalış: hiçbir dosyayı değiştirme, hiçbir komut çalıştırma, repoya
yazma. Cevabını sohbete yaz; istersen `%TEMP%\efxlve-game-page-round2.md`
dosyasına da yaz.

Bu, ilk incelemenin (`game-page-review.md`) **ardından uygulanan** tasarımın
ikinci turudur. İlk turda istediğin yerleşim yazıldı; şimdi soru "yeterli mi?".

## Ne değişti (ölçülmüş hâli)

- **Hero**: 340 px yüksek, altında tek künye satırı:
  "Çevrimiçi · Studio · 2016 · PEGI 18". Durum rozeti türetilmiş (Kurulu /
  Oynanıyor / Çevrimiçi / Tamamlandı) — elle seçilen bir durum değil.
- **Eylem satırı**: 5 öğe — Hemen Oyna / Yönet / favori kalbi / mağaza etiketi
  (tek mağazada sakin etiket, çok mağazada açılır sürüm seçici) / `⋯` menüsü
  (Koleksiyon, Mağazada Aç, Değiştir). Ayrı "mağaza sayfası" düğmesi kaldırıldı.
- **Kişisel içerik öne geldi**: "Son oturum" kartı (ör. "1.7 sa · 3 sa önce ·
  +2 kupa"), "Anların" (kendi ekran görüntülerin) şeridi, "Sıradaki kupalar", ve
  hiç kayıt yoksa "Kendi kaydın buradan başlıyor" davet kartı. Kurulu oyunlarda
  bu blok "Oyun Hakkında"nın **üstünde**, kurulu olmayanlarda altında.
- **Puan kartı tek kart, iki gövde**: kişisel tarafta **"Sen: 14 sa"** ve
  ortalamaya göre karşılaştırma çubuğu; altında Ana Hikaye / Ana + Ekstra /
  %100 Bitirme ve IGDB / OpenCritic / Metacritic rozetleri. Çok oyunculu
  oyunlarda karşılaştırma sessizce çizilmiyor.
- **Krediler** (Hakkında'nın altında): tür/tema etiketleri + topluluk çipleri
  (Resmî site, X, Reddit, Discord) + "Powered by IGDB". Çıkış tarihi, yayıncı ve
  yaş artık künye satırında. Toplam yükseklik 119 px.
- **Yeni**: mağazanın haber akışı kartı (Steam; "Yama notu" çipiyle) ve
  kütüphaneye duyarlı **"Benzer oyunlar"** — sende olan kopya işaretli ve
  tıklayınca tarayıcı yerine launcher'da açılıyor.
- **Yan panel** iki kart: Puanlar + "Oyun Özellikleri & Destek" (Kontrolcü,
  Çevrimdışı Oynanış, Oyun Modu, Çıkış Tarihi, kuruluysa boyut/sürüm…).
- Erişilebilirlik: klavyede Enter/Space odaklı `[data-act]` öğesini tetikliyor;
  Escape önce açık menüyü kapatıyor, sayfayı değil.
- Bilerek yapılmayanlar (ilk turdan): anti-cheat künyede kalıyor, başarım
  istatistiği hero'da kalıyor, kişisel satıra IGDB görseli konmuyor, kişisel
  1–10 puan yok.

## Hâlâ açık olan kararlar (bunlara cevap istiyorum)

1. "Koleksiyon Ekle" düğmesi eylem satırının altında ayrı bir satırda duruyor ve
   `⋯` menüsündeki "Koleksiyon" ile **aynı işi** yapıyor. Hangisi kalmalı?
2. "Benzer oyunlar" sayfanın **en altında** (Hakkında → Haberler → Benzer).
   Benimsenme için yukarı alınmalı mı, yoksa "sırada ne oynasam" sırası doğru mu?
3. Puanı ve süresi olmayan oyunda yan panel yine ince kalıyor (tek özellik
   kartı). Özellik kartı bir sekmeye mi insin, yoksa orada mı dursun?
4. Boş durum kartı ("Kendi kaydın buradan başlıyor") doğru hamle mi, yeri doğru
   mu? (Şu an yalnızca hiç ekran görüntüsü ve hiç başarım yoksa çiziliyor.)
5. "Geri dönme sebebi" olarak haber kartı + topluluk çipleri yeterli mi?
   "En son oynadığından beri ne değişti" gibi tek satırlık bir özet ister misin?
6. Akış kararı: mağazanın kendi haber servisi mi, oyunun X/Reddit'i mi (gömülü
   değil, link)? İlk turda gömülü akış reddedilmişti; bu hâlâ doğru mu?
7. Sayfada hâlâ "veritabanı" gibi okunan bir yer kaldı mı? (etiket satırı,
   özellik satırları, çıkış tarihi…)
8. İlk üç değişiklik: sırayla ne yapardın?

## Cevapla

Türkçe, madde madde, en fazla 10 madde, kod yazma. Her maddede önce somut durum,
sonra tek cümlelik gerekçe, sonra uygulanabilir karar. Emin olmadığın yerde "emin
değilim" de. Genel geçer tavsiye verme; bu sayfanın somut durumuna konuş.

İstersen `src/features/drawer/drawer-view.ts` ve `src/styles/game-page.css`
dosyalarına bakabilirsin (salt okunur). Sayfanın o anki hâlinin ekran görüntüsü:
`%TEMP%\efxlve-game-page-wide.png` — 1440 px genişlikte, iki sütunlu masaüstü
düzeni (örnek veriyle).
