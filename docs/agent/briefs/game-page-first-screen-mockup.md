# Brief: ilk ekranın görsel tasarımı (mockup)

Sen deneyimli bir arayüz tasarımcısısın. Efxlve Launcher'ın oyun detay sayfasının
**ilk ekranı** için somut bir yerleşim tasarımı istiyorum. SALT OKUNUR çalış:
repoya yazma, komut çalıştırma. İstersen kendi tarayıcında statik bir HTML/CSS
mockup yapıp ekran görüntüsü alabilirsin; asıl istediğim o görsel ve onun
gerekçesi. Cevabı sohbete yaz (mockup yaptıysan görselini de ekle).

## Tasarım sistemi (uyulması zorunlu)

- Monokrom: `#000` / `#0a0a0a` zemin, tek tip yüzey tonları; **renk yalnızca durum
  bildirir** (yeşil çevrimiçi, amber güncelleniyor, kırmızı hata). Gradyan,
  parlama, renkli vurgu yok.
- Tipografi: mevcut ölçek (başlık / bölüm başlığı / gövde / küçük meta).
  Sayısal alanlar `tabular-nums`.
- Köşe yarıçapları ve boşluklar mevcut tokenlardan; yeni bir görsel dil
  uydurma. İlgili dosyalar: `src/styles/game-page.css`, `src/styles/tokens.css`,
  `src/styles/components.css`.
- Ekran: 1440×900 ve 1920×1080 hedef; pencere içi (sol menü ~220 px var).

## İlk ekranda olması gerekenler (hiçbiri silinmiyor)

**Hero (şu an 440 px, hedef ~350 px):**
- Kapak görseli; sol üstte Geri; sağ üstte kapak özelleştirme.
- Oyun başlığı + **tek satır künye**: geliştirici · yayıncı (farklıysa) · çıkış
  yılı · yaş sınırı (USK/PEGI) · DRM-Free/Aile Paylaşımı · **durum** (Çevrimiçi /
  Kurulu / Güncelleniyor).
- Oyunun dahil olduğu **koleksiyon rozetleri** (şu an eylem satırında sıkışıyor).

**Eylem satırı (şu an 7 öğe):**
- Birincil: **Oyna / Güncelle / Kur / Durdur** (indirme sırasında İptal).
- İkincil: **Yönet**.
- Görünür kalan: **favori kalbi**, çok mağazalıysa **sürüm seçici** (tek
  mağazaysa sakin bir kaynak rozetine dönüşmeli).
- `⋯` menüsüne girenler: mağaza sayfası, harici istemciyi aç, koleksiyona ekle.

**İstatistik şeridi:** SÜRE (ipucunda son oynama tarihi), KUPA, BULUT.

**Kişisel üçlü (kaydırma yapmadan görünmeli):** Sıradaki kupalar (2-3 satır),
Anların (kendi ekran görüntüleri şeridi), varsa sabitlenmiş not.

**Sağ yan panel (300 px):** tek kompakt kart — eleştirmen puanları (IGDB /
OpenCritic / Metacritic) + HowLongToBeat süreleri, ve HLTB satırlarında oyuncunun
kendi süresiyle kıyas ("Sen: 14 sa / Ana Hikâye: 20 sa"). İkinci kart: oyun
özellikleri (desteklenmeyen satırlar gizli).

## Cevapla

1. **Yerleşim**: yukarıdakilerin ilk ekranda tam konumu (kutu kutu, yükseklik
   tahminleriyle). Hangi öğe kaç piksel yer alıyor?
2. **Hero yüksekliği 350 px'e inince**: başlık + künye + koleksiyon rozetleri
   nasıl sığar? Scrim (karartma) nereye kadar iner ki beyaz metin okunur kalsın?
3. **Eylem satırı**: birincil/ikincil/`⋯` ayrımı görsel olarak nasıl belli olur?
   `⋯` menüsü hangi genişlikte, hangi öğeleri içerir?
4. **Kişisel üçlü**: üç blok (kupalar, anların, not) yan yana mı, alt alta mı?
   Biri boşsa yerleşim nasıl davranır?
5. **Sağ panel**: birleşik kartın iç düzeni (puan rozetleri + HLTB satırları).
6. **Boş durumlar**: oyuncunun hiç kupa/ekran görüntüsü/notu yoksa ilk ekran ne
   gösterir? (Katalog içeriği üste çıkmasın, ama boşluk da kalmasın.)
7. **Ölçüm**: ilk ekranın yüzde kaçı oyuncuya ait veri olur; bunu nasıl
   doğrularız?
8. Nerede hâlâ "mağaza sayfası" hissi kalıyor? (varsa)

Somut ol: "şu blok şurada, şu yükseklikte, şu yüzden" de. Genel tavsiye verme.
