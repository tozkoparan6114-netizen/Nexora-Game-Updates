# Nexora — Lignum Vitae güncelleme deposu

Bu depo, Nexora başlatıcısının GitHub üzerinden dağıtım/güncelleme altyapısı için hazırlanmıştır.

## Önemli

- Oyun dosyaları henüz bu depoda bulunmuyor. Bu nedenle şu an indirilebilir bir oyun sürümü yayımlanmış değildir.
- Gerçek oyun dosyalarını `game/` klasörüne ekleyin. Büyük dosyalar için GitHub Releases veya Git LFS kullanın; GitHub normal depo dosyalarında dosya boyutu sınırları uygular.
- Bir sürümü yayımlamak için `v1.0.0` gibi bir etiket oluşturup gönderin. GitHub Actions, `game/` klasörünü ZIP yapıp Release varlığı olarak ekler.
- Nexora uygulamasının bu sürümleri otomatik algılaması için uygulamanın Electron tarafında ayrıca bir güncelleme istemcisi yapılandırılmalı ve bir Windows EXE/MSI kurulum paketi hazırlanmalıdır. Bu depo tek başına yüklü uygulamayı güncellemez.

## Sürüm etiketi örneği

```bash
git tag v1.0.0
git push origin v1.0.0
```
