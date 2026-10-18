# Brief: oyun sayfası incelemesi (bağımsız görüş)

Sen bağımsız bir ürün/tasarım incelemecisisin. Bu brief'i Efxlve Launcher'ın
oyun sayfası için yazdım. **SALT OKUNUR çalış**: hiçbir dosyayı değiştirme,
hiçbir komut çalıştırma, repoya yazma. Cevabını ya sohbete yaz ya da
`%TEMP%\efxlve-game-page-review.md` dosyasına yaz.

## Bağlam

Efxlve Launcher: Windows için bir oyun başlatıcı (Tauri + TypeScript). Kullanıcı
bir oyuna tıklayınca bir "oyun sayfası" açılıyor: üstte kapak görseli (hero),
altında sekmeler (Genel Bakış, Başarımlar, DLC, Ekran Görüntüleri, Notlar,
Sistem Gereksinimleri) ve Genel Bakış'ta bir "Hakkında" kutusu, "Anların"
şeridi (kendi ekran görüntüleri), sonraki başarımlar, benzer oyunlar ve sağda
bir yan panel (HowLongToBeat, eleştirmen puanları, özellikler).

Sahibi bu sayfanın son hâlinden memnun değil: "daha da kötüleşiyor gibi"
demiş. Önceki dış incelemede üç medya şeridi ikiye indirildi, yan panel on iki
satırdan üçe düştü, puanlar tek karta birleşti, IGDB bilgileri açıklamanın
altına taşındı. İki öneri bilerek uygulanmadı: anti-cheat bilgisi hero'da
kalıyor, başarım istatistiği hero'da kalıyor.

## Oku

- `docs/design-brief-game-page.md` — önceki dış inceleme ve uygulanmayan maddeler.
- `docs/GAME_PAGE_REWORK.md` — aşama planı ve önbellek denetimi (§9).
- `src/features/drawer/drawer-view.ts` — Genel Bakış'ın üretildiği yer
  (`renderDrawerOverview`, `renderAboutSection`).
- `src/styles/game-page.css` — sayfanın stilleri.
- `src/features/drawer/igdb-view.ts` — benzer oyunlar ve IGDB medyası.

## Cevapla

Türkçe, madde madde, en fazla 8 madde. Her madde için:

1. **Ne**: sayfadaki somut sorun (hangi blok, hangi durumda).
2. **Neden önemli**: kullanıcıya ne kaybettiriyor (bir cümle).
3. **Öneri**: tek satırlık, uygulanabilir düzeltme (kod değil, karar).

Sonunda iki ayrı liste:

- **Hâlâ açık**: önceki incelemeden uygulanmamış veya yarım kalmış ne var?
- **Daha kötü**: sayfada "normal bir başlatıcıdan kötü" duran şeyler var mı?

Uydurma: emin olmadığın bir şeyi yazma; "emin değilim" demek serbest.
