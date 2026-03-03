<div align="center">

# 🧠 Modern Self-Manager

**Kişisel üretkenliğini tek bir yerden yönet.**

Görevler, finans takibi ve dosya yönetimini bir araya getiren, tamamen kişisel kullanımım için kendi ihtiyaçlarıma yönelik tasarlayıp geliştirdiğim modern bir web uygulaması.

> 🤖 **Vibe Coding ile Geliştirildi**: Bu projeyi kodlarken yapay zeka araçlarından (Antigravity, Claude 3.7 Sonnet / Opus, ChatGPT 4o ve Gemini) faydalandım ve **"vibe coding"** yaklaşımıyla geliştirdim.

![Made with](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript)
![Supabase](https://img.shields.io/badge/Supabase-Backend-3ECF8E?style=flat-square&logo=supabase)
![Vite](https://img.shields.io/badge/Vite-Build-646CFF?style=flat-square&logo=vite)

</div>

---

## 🌟 Nedir?

**Modern Self-Manager**, günlük hayatımı organize etmek için ihtiyaç duyduğum her şeyi tek bir arayüzde toplamak amacıyla geliştirdiğim kişisel yönetim sistemimdir.

Piyasadaki karmaşık proje yönetimi araçlarına ya da birbirinden kopuk uygulamalara mecbur kalmamak adına; kendi görevlerimi, harcamalarımı ve dosyalarımı sade, hızlı ve güçlü bir arayüzle takip edebileceğim bu özel platformu kodladım.

---

## 📸 Ekran Görüntüleri

### 📋 Görev Yönetimi
> Sonsuz hiyerarşiyle görev oluştur, öncelik ver, etiketle ve takip et.

![Görev Yönetimi](public/screenshot-todo.png)

---

### 💰 Finans Takibi
> Gelir ve giderlerini kategorilere ayırarak anlık finansal durumunu görüntüle.

![Finans Takibi](public/screenshot-finance.png)

---

### 🗂️ Dosya Yönetimi
> Görev ve finanslarına bağlı dosyalarını güvenli ve düzenli şekilde sakla.

![Dosya Yönetimi](public/screenshot-storage.png)

---

## ⚡ Özellikler

### 📋 Todo Modülü
- Çalışma alanları (Workspace) ile projelerini grupla
- Sonsuz derinlikte alt görev hiyerarşisi
- Özel durum akışları (Status workflow) tanımla
- Etiket sistemi ile hızlı filtreleme
- Dinamik ilerleme hesaplama (depolanan değer yok, her zaman gerçek zamanlı)
- Tekrarlayan görev şablonları

### 📅 Takvim & Google Entegrasyonu
- Google Takvim hesabımla sorunsuz bağlantı (OAuth2)
- Görevlerimi tek tıkla takvimime etkinlik olarak gönderebiliyorum
- Manuel senkronizasyon kontrolü sayesinde istemediğim hiçbir şey takvime eklenmiyor
- Tam gün (All-day) etkinlikleri ve saat hassasiyetli planlamaları kusursuz yönetiyor
- Token bileşenleri tamamen sunucu (server-side) tarafında saklanıp güvenliğim korunuyor

### 💰 Finans Modülü
- Nakit bazlı muhasebe (tahakkuk yok)
- Kategori ve etiket sistemi
- Borç / Alacak takibi (Obligation)
- Çoklu döviz desteği
- Tekrarlayan gelir/gider şablonları

### 🗂️ Depolama Modülü
- Görev ve finanslara bağlı dosya yönetimi
- Güvenli, özel bucket erişimi
- Polimorfik dosya tablosu

---

## 🏗️ Teknik Mimari

```
Client UI  →  Server Actions  →  Service Layer  →  Supabase (Postgres + Storage)
```

- **Frontend:** React 18 + TypeScript + Vite
- **Stil:** Tailwind CSS
- **Backend:** Supabase (Auth, Database, Storage)
- **Dağıtım:** Vercel
- **Mimari:** Domain-driven, server-first hybrid

### Temel Prensipler
- ✅ Tüm mutasyonlar server aksiyonları üzerinden geçer
- ✅ Her tablo Row Level Security (RLS) ile korunur
- ✅ Para birimleri integer (kuruş) olarak saklanır — float asla
- ✅ Hesaplanan değerler veritabanında saklanmaz
- ✅ Domain sınırları korunur (Finance ↔ Todo birbirini mutate etmez)

---

## 🗄️ Veritabanı Şeması

Tüm tablolar izole domain yapısıyla organize edilmiştir:

| Alan | Tablolar |
|------|---------|
| **Todo** | `workspaces`, `tasks`, `task_tags`, `todo_tags`, `recurring_templates` |
| **Finance** | `finance_transactions`, `finance_categories`, `finance_tags`, `finance_obligations` |
| **Storage** | `files` (polimorfik) |
| **Auth** | `user_integrations` |

Her tablo: `user_id + RLS + soft delete` ile güvence altındadır.

---

## 🚀 Kurulum

```bash
# Repoyu klonla
git clone https://github.com/[kullaniciadin]/modern-self-manager.git
cd modern-self-manager

# Bağımlılıkları yükle
npm install

# Ortam değişkenlerini ayarla
cp .env.example .env.local
# .env.local içine Supabase URL ve Anon Key'i ekle

# Geliştirme sunucusunu başlat
npm run dev
```

### Gerekli Ortam Değişkenleri

```
VITE_SUPABASE_URL=https://[proje-id].supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

---

## 📁 Proje Yapısı

```
src/
├── domains/          # Domain-driven iş mantığı
│   ├── finance/      # Finans servisleri ve tipleri
│   └── todo/         # Todo servisleri ve tipleri
├── contexts/         # Global React context'leri
├── components/       # UI bileşenleri
├── pages/            # Sayfa bileşenleri
├── lib/              # Yardımcı kütüphaneler (Supabase, vb.)
└── api/              # Server-side API route'ları
```

---

## 🔐 Güvenlik

- Tüm veriler `auth.uid()` bazlı RLS politikalarıyla korunur
- Hassas anahtarlar (API key'ler) asla client-side koda gömülmez
- Storage dosyaları yalnızca signed URL ile erişilebilir
- Token'lar yalnızca sunucu tarafında saklanır

---

<div align="center">

👨‍💻 Tamamen kişisel ihtiyaçlarım doğrultusunda, **Vibe Coding** (Antigravity, Claude, ChatGPT, Gemini) yaklaşımıyla benim tarafımdan geliştirilmiştir.

</div>
