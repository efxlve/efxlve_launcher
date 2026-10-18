# Brief: oyun sayfası plan denetimi (uygulamadan önce)

Sen deneyimli bir ürün ve mühendislik gözden geçiricisisin. Aşağıdaki **uygulama
planını**, kod yazılmadan önce denetlemeni istiyorum. SALT OKUNUR çalış: hiçbir
dosyayı değiştirme, hiçbir komut çalıştırma. Cevabı sohbete yaz.

## Nereden geliyoruz

Efxlve Launcher (Windows oyun başlatıcısı, Tauri + TypeScript) — oyun detay
sayfası için kullanıcılardan "çok karışık ve karıştırıcı" geri bildirimi geldi.
Sahibinin istediği: **hiçbir bilgi silinmesin**, ama sayfa "veritabanı sayfası"
gibi değil, "benim oyunum" gibi okunsun.

Önceki bağımsız incelemeden çıkan ve kabul edilen yön:
- Kişisel içerik (kendi ekran görüntüleri, sıradaki kupalar, notlar) üstte;
  katalog içeriği (açıklama, künye, benzer oyunlar) bir kaydırma aşağıda.
- Oyun **kurulu/oynanmışsa** kişisel içerik üstte; hiç oynanmamışsa açıklama
  üstte kalabilir.
- Künye üç yere saçılmayacak (hero altı, açıklama altı, özellikler kartı) —
  tekilleşecek.
- Yan paneldeki HowLongToBeat + eleştirmen puanları tek karta inecek; HLTB
  satırları oyuncunun kendi süresiyle kıyaslanacak.
- Gömülü X/Reddit akışı **yok**; mağazanın kendi haber servisi (Steam
  `ISteamNews/GetNewsForApp`, Epic'in haber akışı) + topluluk linkleri var.
- "Yönet" artık sekme durumuna dokunmuyor ve paneli Sistem sekmesinde yaşıyor.
- Bekleyen kartlar iskeletle yer tutuyor (sayfa veri gelince zıplamıyor).

Uygulanmış olanlar (bu planın dışında, bitmiş): yukarıdaki son iki madde.

## Denetlemeni istediğim plan

**Aşama 1 — Sıra ve künye (düzen, yeni veri yok)**
- Genel Bakış'ın sol sütunu: `Sıradaki kupalar` + `Anların` + (varsa sabitlenmiş
  not) en üste; `Hakkında` + tür etiketleri + "Kaynak: IGDB" onun altına.
- Künye tek satıra iner (geliştirici · yayıncı · yıl · yaş sınırı) ve hero
  başlığının altında durur; anti-cheat ve harici başlatıcı hero'dan çıkıp
  Özellikler kartına iner; açıklama altındaki yayıncı/yaş sınırı hero'ya çıkar.
- Hero yüksekliği ~440 px → ~350 px.

**Aşama 2 — Eylem satırı**
- Birincil: Oyna/Güncelle/Kur. İkincil: Yönet. Kalanı (mağaza sayfası, harici
  istemciyi aç, koleksiyona ekle, mağaza sürüm seçici tek mağazaysa) `⋯`
  menüsüne.
- Favori ikonu görünür kalır. "Online" bir durumdur, düğme olmaktan çıkar ve
  hero'daki künye satırına taşınır.

**Aşama 3 — Yan panel ve ölçüm**
- HLTB + eleştirmen puanları tek kompakt kart; HLTB satırında "Sen: 14 sa /
  Ana Hikâye: 20 sa".
- "Oyun Özellikleri & Destek" kartında "Desteklenmiyor / Yok" satırları gizlenir
  (anti-cheat ve çevrimdışı istisna).

**Aşama 4 — Yeni değer (benimsenme)**
- Oturum sonu özeti kartı ("Son oturum: +2 kupa, 4 ekran görüntüsü, bulut
  senkron") — oturum bitişi zaten yakalanıyor.
- Kişisel durum rozeti ("Oynanıyor / Bitti / %100 / Bırakıldı") + kendi puanın
  (1-10).
- Mağaza haberleri (3 madde) + topluluk linkleri (X, Reddit, Discord, site,
  wiki).
- Benzer oyunlar: kütüphanede varsa uygulama içindeki oyuna gitsin.
- Oyuncunun kendi ekran görüntüsü yoksa Genel Bakış'a IGDB görselleri düşsün.

## Cevapla (Türkçe, en fazla 10 madde, kod yazma)

1. Sıralama doğru mu? En yüksek etki/en düşük risk hangisinde, önce o mu?
2. Her aşamada **neyi bozabilirim**? Somut teknik riskler (hangi parça, hangi
   yan etki).
3. Hangi maddeyi hiç yapmamalıyım? (gereksiz, ters teper, bakım yükü)
4. Planda **eksik** olan ne var?
5. "Benimsenme" hedefi için en yüksek etkili üç madde hangisi?
6. Bu değişikliğin işe yaradığını nasıl anlarız? Somut, ölçülebilir işaretler.
7. Aşama 1'i tek commit'te mi, parça parça mı yapmalıyım? Neden?

Emin olmadığın yerde "emin değilim" de. Genel tavsiye değil, bu plandan somut
şeyler söyle.
