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

## Nasıl çalışır

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
