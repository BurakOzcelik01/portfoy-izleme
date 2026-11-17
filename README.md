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

Sol üstteki menüden açılır: ana ekran, emirler, ısı haritası, alım/satım, portföy geçmişi, ay sonu ve yedekleme.

## Telefonda kullanma

Veriler bu bilgisayardaki `data.json` dosyasında durur ve kimlik doğrulama yoktur. Bu yüzden uygulama
internete ya da ev Wi-Fi'ına açılmaz; telefon bilgisayara yalnızca senin cihazlarının bulunduğu özel bir
ağ üzerinden, [Tailscale](https://tailscale.com) ile bağlanır. Bilgisayar açık ve `npm start` çalışıyor olmalı.

1. Tailscale'i bilgisayara ve telefona kur, ikisinde de aynı hesapla giriş yap.
2. Bilgisayarda uygulamayı Tailscale ağına HTTPS ile aç (yalnızca senin cihazların görür, internete açılmaz):
   ```bash
   tailscale serve --bg 4173
   ```
   Komut `https://<bilgisayar-adı>.<ağ-adı>.ts.net` biçiminde bir adres yazar.
3. Bu adresin alan adını `.env` dosyasına ekle ve uygulamayı yeniden başlat:
   ```
   ALLOWED_HOSTS=bilgisayar-adi.ag-adi.ts.net
   ```
4. Telefonda adresi aç. Ana ekrana eklersen ayrı bir uygulama gibi tam ekran açılır:
   iPhone'da Safari → Paylaş → Ana Ekrana Ekle; Android'de Chrome → ⋮ → Ana ekrana ekle.

Kapatmak için: `tailscale serve --https=443 off`.

## Emirler

Aracı kurumda verdiğin emirler buraya girilir; bekleyen emir portföyü değiştirmez, yanında güncel fiyat
ve emir fiyatına uzaklığı görünür. "Gerçekleşti" dendiğinde emir, alım/satım işlemiyle aynı yoldan
portföye işlenir: adet, ortalama maliyet ve seçilen hesap güncellenir, işlem Alım/satım sayfasına düşer.
Kısmi gerçekleşmede yalnızca gerçekleşen adet girilir, kalan beklemeye devam eder; "Kalanı iptal et"
gerçekleşen kısmı portföyde bırakır. Gerçekleşmiş bir işlem Alım/satım sayfasından geri alınırsa emir
yeniden bekler. Tüm emirler durumlarına göre (bekleyen, gerçekleşen, iptal) tek listede süzülür.

## Isı haritası

Hisseler (BIST ve ABD) portföydeki TL ağırlıklarıyla kutulara bölünür; renk bugünkü değişimdir, ±%3 ve
üstü en koyu tondur. Fiyatı alınamayan hisse haritada yer almaz ve altta sayısı yazar.

## Nasıl çalışır

- **Sıralama:** Hisse, fon, altın, hesap, kart, gelir, gider ve ayırma satırları sürüklenerek sıralanır.
- **Günlük değişim:** Yalnızca seansı bugün olan hisse, fon ve altının değişimidir; dünkü ABD seansı ve
  hafta sonu önceki günün değişimi sayılmaz. Yüzde bu yatırımların toplamına göre hesaplanır, banka
  bakiyesi ve kart borcu dahil edilmez.
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
