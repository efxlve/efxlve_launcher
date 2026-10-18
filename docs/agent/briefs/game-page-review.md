# Brief: oyun sayfası — benimsenme incelemesi (bağımsız görüş)

Sen bağımsız bir ürün ve deneyim incelemecisisin. Bir Windows oyun başlatıcısı
olan Efxlve Launcher'ın **oyun detay sayfası** hakkında görüşünü istiyorum.
SALT OKUNUR çalış: hiçbir dosyayı değiştirme, hiçbir komut çalıştırma, repoya
yazma. Cevabını sohbete yaz; istersen `%TEMP%\efxlve-game-page-review.md`
dosyasına da yaz.

## Bağlam

- Uygulama: Tauri + TypeScript; Epic, GOG, Steam ve Amazon kütüphanelerini bir
  arada yöneten bir Windows oyun başlatıcısı.
- Sayfa: bir oyuna tıklayınca açılan detay sayfası. Üstte büyük kapak görseli
  (hero, 1440p'de ~500 px), altında eylem düğmeleri (Hemen Oyna, Yönet, favori,
  dış link, mağaza seçici, "Online" durumu, koleksiyona ekle), sağda üç
  istatistik (SÜRE / KUPA / BULUT), altında sekmeler: Genel Bakış, Başarımlar,
  Eklentiler, Medya, Notlar, Sistem.
- Genel Bakış'ta: "Oyun Hakkında" metni; hemen altında veritabanı alanları
  (çıkış tarihi, USK 18, beş tür etiketi, "Powered by IGDB"); sonra "Anların"
  (kullanıcının kendi ekran görüntüleri şeridi), "Sıradaki kupalar", "Benzer
  oyunlar". Sağ yan panelde HowLongToBeat, eleştirmen puanları
  (IGDB / OpenCritic / Metacritic) ve "Oyun Özellikleri & Destek" kartları.
- Medya sekmesinde IGDB ekran görüntüleri ile kullanıcının kendi görüntüleri ve
  klipleri; Başarımlar sekmesinde ilerleme çubuğu, filtreler ve kupa listesi.
- İlgili dosyalar (istersen bak): `src/features/drawer/drawer-view.ts`,
  `src/styles/game-page.css`, `src/features/drawer/igdb-view.ts`,
  `docs/design-brief-game-page.md`, `docs/GAME_PAGE_REWORK.md`.

## Asıl soru

Kullanıcılardan gelen geri bildirim: **"oyunların detay sayfası çok karışık ve
karıştırıcı."** Sahibinin istediği şey **silip atmak değil**: sayfanın, oyuncunun
benimseyeceği, "benim oyunum" hissi veren bir yere dönüşmesi. Yani öncelik ve
yerleşim değişsin, **hiçbir bilgi kaybolmasın** — her öğe yeni yerini bulsun.

Sahibinin aklındaki bir fikir de şu: oyunun X (Twitter) hesabı veya Reddit
akışı eklemek (gömülü feed), ya da mağazanın kendi haber servisini kullanmak.

## Cevapla

Türkçe, madde madde, en fazla 10 madde, kod yazma. Her maddede önce somut durum,
sonra tek cümlelik gerekçe, sonra uygulanabilir karar.

1. Sayfa neden "veritabanı sayfası" gibi okunuyor da "benim oyunum" gibi
   okunmuyor? En çok rahatsız edenden başlayarak sırala.
2. Bir oyuncu bu sayfayı hangi işler için açar? İlk beşini önem sırasına koy.
3. Benimsenme için somut ne eklenmeli? (kişisel ilerleme, arkadaş etkinliği,
   geri dönme sebebi, hatırlatıcı, ödül…)
4. Yerleşim: ilk ekranda (katlamanın üstünde) ne olmalı, bir kaydırma aşağıda ne
   olmalı, ne sekmede kalmalı? **Hiçbir bilgiyi silme** — her öğe için yeni
   yerini söyle.
5. Akış: X/Reddit gömülü mü, link mi, mağazanın kendi haber servisi mi?
   Gerekçe ve riskler.
6. Eylem satırı: yedi öğe var. Hangileri birincil kalmalı, hangileri menüye
   girmeli? ("Online" bir durum, düğme değil.)
7. Yan panel: kalsın mı, tek karta mı insin, içeriği sekmelere mi dağılsın?
8. Oyuncunun bu sayfayı haftada birkaç kez açmasını sağlayacak şey ne olurdu?
9. Bizim gözden kaçırdığımız ne var?
10. İlk üç adım: hangi değişiklikle başlardın, neden?

Emin olmadığın yerde "emin değilim" de. Genel geçer tavsiye verme; bu sayfanın
somut durumuna konuş.
