# Portföy izleme (taslak)

Hisseler, fonlar, banka hesapları, kredi kartları, gelirler ve para piyasası tek ekranda.
Veriler bu klasördeki `data.json` dosyasında durur; bu dosya ve `.env` depoya girmez.
İlk açılışta uydurma örnek veriyle başlar.

Claude ile geliştirildi.

Fiyatlar Yahoo Finance ve TEFAS'ın resmî olarak belgelenmemiş adreslerinden alınır; kişisel kullanım
içindir, doğruluğu garanti edilmez ve yatırım tavsiyesi değildir.

## Çalıştırma

```bash
npm install
npm start
```

Sonra http://localhost:4173 adresini aç.

## Asistan

Fotoğraf ve yazıyla güncelleme için Claude API anahtarı gerekir. `.env.example` dosyasını
`.env` adıyla kopyalayıp `ANTHROPIC_API_KEY` değerini gir. Anahtar olmadan da her şey elle
düzenlenebilir.

Asistan hiçbir şeyi kendiliğinden değiştirmez: önerisini listeler, "Uygula" dersen işlenir.
Yüklediğin fotoğraflar ve mevcut kayıtların, yanıt üretilmesi için Anthropic'e gönderilir.

## Sayfalar

Sol üstteki menüden açılır: ana ekran, alım/satım, portföy geçmişi, ay sonu ve yedekleme.

## Nasıl çalışır

- **Yedekleme:** Bütün kayıtlar tek bir JSON dosyası olarak iner ve geri yüklenebilir. Geri yüklemeden
  önce mevcut kayıtlar `data.before-restore.json` olarak saklanır. Dosyada finansal bilgiler vardır.
- **Portföy geçmişi:** Uygulama açıkken her gün için son net varlık kaydedilir. Fiyatı alınamayan bir
  varlık varsa o an kayıt yapılmaz.
- **Alım/satım:** Alışlar adet ve ortalama maliyeti, satışlar gerçekleşen kâr/zararı günceller. Maliyet
  sıraya bağlı olduğu için yalnızca bir varlığın en son işlemi silinebilir.
- **Kart ödemesi:** Borç ile birlikte seçilen hesap ya da para piyasası ayırması ve fonu da düşer.
- **Ay sonu:** Banka toplamı, bu ay kalan gelir ve giderler ile kart borcunun para piyasasında
  karşılanmayan kısmından tahmin yapılır. Sabit giderler günü gelince hesaptan kendiliğinden düşer.
- **Altın:** Gram (TL) veya ons (dolar) olarak eklenir. Fiyat, Yahoo Finance'teki vadeli altın ve dolar
  kurundan hesaplanır; banka ve kuyumcu fiyatından farklı olabilir.
- **Gelirler:** Sunucu her veri okumasında vadesi gelen gelirleri hesaba ekler. Uygulama kapalıyken
  gelen tarihler, açıldığında tek tek işlenir ve aynı gelir iki kez yatmaz. Ayın 31'i gibi günler
  kısa aylarda ayın son gününe çekilir.
- **Fiyatlar:** BIST ve ABD hisseleri ile dolar kuru 30 saniyede bir Yahoo Finance'ten alınır ve
  gecikmeli olabilir. Yahoo'ya yalnızca hisse kodları gider.
- **Fonlar:** Değer, pay adedi × TEFAS fiyatıdır. Fiyat günde bir kez değişir, uygulama açıkken
  yeni fiyat 30 dakikada bir kontrol edilir. TEFAS adresi resmî olarak belgelenmemiştir, değişebilir.
  Pay adedi girilen değer ile o günkü fiyattan çıkarılır; TEFAS'ta olmayan satırlar elle güncellenir.
- **Para piyasası:** Toplam, para piyasası olarak işaretli fonların toplamıdır. Ayrılan tutarlar bu
  toplamı aşamaz. Fiyat güncellemesinden gelen getiri ayırmalara tutarlarıyla orantılı dağıtılır,
  ayrılmamış kısım değişmez; elle eklenen para ise ayrılmamış kısma gider. Bir ayırma karta bağlanırsa kart satırında borcun
  karşılanıp karşılanmadığı görünür.

## Test

```bash
npm test
```
