"""Sahte Tauri arka ucu için gerçek veriden fixture üretici.

Amaç: üretim paketini (dist/) tarayıcıda gerçek mağaza verisiyle koşturup
gerçek TypeScript mantığını sınamak. Rust serileştirme şeması birebir taklit
edilir (snake_case alanlar, SystemRequirement -> camelCase systemType).
"""
import json
import re
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
OUT = "tools/store-check/fixtures.json"


def get(u, t=25):
    return json.loads(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=t).read().decode())


def post(u, body, t=25):
    req = urllib.request.Request(u, data=json.dumps(body).encode(), headers={**UA, "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=t).read().decode())


def money(cents, cur="TRY"):
    v = cents / 100.0
    whole = f"{int(v):,}".replace(",", ".")
    return f"\u20ba{whole},{int(round((v % 1) * 100)):02d}"


def img(o, k):
    for i in o.get("keyImages") or []:
        t = (i.get("type") or "").lower()
        if k == "tall" and t in ("offerimagetall", "dieselstorefronttall"):
            return i.get("url")
        if k == "wide" and t in ("offerimagewide", "dieselstorefrontwide"):
            return i.get("url")
        if k == "shot" and t == "featuredmedia":
            return i.get("url")
    return None


def price_of(oid):
    try:
        p = get(f"https://api.egdata.app/offers/{oid}/price?country=TR")
        pr = p.get("price") or {}
        cur = pr.get("currencyCode", "TRY")
        orig = pr.get("originalPrice", 0)
        disc = pr.get("discountPrice", 0)
        rules = p.get("appliedRules") or []
        pct = (rules[0].get("discountSetting") or {}).get("discountPercentage") if rules else None
        return {
            "original_price": money(orig, cur) if orig else None,
            "discount_price": money(disc, cur) if disc else ("Ücretsiz" if orig else None),
            "discount_percentage": pct,
            "currency": cur,
        }
    except Exception:
        return {"original_price": None, "discount_price": None, "discount_percentage": None, "currency": "TRY"}


def offer_item(o):
    oid = o.get("id") or o.get("_id")
    tags = [t.get("name") for t in (o.get("tags") or []) if t.get("name")]
    p = price_of(oid)
    om = (o.get("offerMappings") or [{}])
    return {
        "id": oid,
        "namespace": o.get("namespace") or "",
        "title": o.get("title") or "",
        "description": (o.get("description") or "")[:400] or None,
        "cover": img(o, "tall") or "",
        "wide_art": img(o, "wide") or "",
        "seller": (o.get("seller") or {}).get("name") or o.get("developerDisplayName"),
        "original_price": p["original_price"],
        "discount_price": p["discount_price"],
        "discount_percentage": p["discount_percentage"],
        "currency": p["currency"],
        "product_slug": o.get("productSlug"),
        "url_slug": o.get("urlSlug"),
        "page_slug": (om[0] or {}).get("pageSlug") if om else None,
        "tags": tags,
    }


def free_item(el, is_free_now, start, end):
    return {
        "id": el.get("id"),
        "namespace": el.get("namespace") or "",
        "title": el.get("title") or "",
        "description": el.get("description") or "",
        "cover": img(el, "tall") or "",
        "wide_art": img(el, "wide") or "",
        "original_price": ((el.get("price") or {}).get("totalPrice") or {}).get("fmtPrice", {}).get("originalPrice"),
        "discount_price": "Ücretsiz" if is_free_now else "Yakında Ücretsiz",
        "is_free_now": is_free_now,
        "start_date": start,
        "end_date": end,
        "product_slug": el.get("productSlug"),
        "url_slug": el.get("urlSlug"),
        "page_slug": (el.get("offerMappings") or [{}])[0].get("pageSlug"),
    }


def build_hub():
    free = get("https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions"
               "?locale=tr-TR&country=TR&allowCountries=TR")
    els = (((free.get("data") or {}).get("Catalog") or {}).get("searchStore") or {}).get("elements") or []
    active, upcoming = [], []
    for el in els:
        promo = el.get("promotions") or {}
        po = promo.get("promotionalOffers") or []
        up = promo.get("upcomingPromotionalOffers") or []
        is_a, s, e = False, None, None
        for g in po:
            for o in (g.get("promotionalOffers") or []):
                pct = (o.get("discountSetting") or {}).get("discountPercentage", -1)
                dp = (el.get("price") or {}).get("totalPrice", {}).get("discountPrice", -1)
                if pct == 0 or dp == 0:
                    is_a, s, e = True, o.get("startDate"), o.get("endDate")
                    break
            if is_a:
                break
        if is_a:
            active.append(free_item(el, True, s, e))
            continue
        is_u, s2, e2 = False, None, None
        for g in up:
            for o in (g.get("promotionalOffers") or []):
                if (o.get("discountSetting") or {}).get("discountPercentage", -1) == 0:
                    is_u, s2, e2 = True, o.get("startDate"), o.get("endDate")
                    break
            if is_u:
                break
        if is_u:
            upcoming.append(free_item(el, False, s2, e2))

    tops = [offer_item(o) for o in (get("https://api.egdata.app/offers/top-sellers?limit=24&country=TR").get("elements") or [])]
    fd = get("https://api.egdata.app/offers/featured-discounts?country=TR")
    deals = [offer_item(o) for o in (fd if isinstance(fd, list) else fd.get("elements") or [])]
    soon = [offer_item(o) for o in (get("https://api.egdata.app/offers/upcoming?limit=24&country=TR").get("elements") or [])]

    tops = [t for t in tops if t["cover"] or t["wide_art"]]
    deals = [d for d in deals if d["cover"] or d["wide_art"]]

    return {
        "country": "TR",
        "free_games_active": active,
        "free_games_upcoming": upcoming,
        "top_sellers": tops,
        "featured_discounts": deals,
        "upcoming_offers": soon,
        "wishlist_offer_ids": [],
        "cart_offer_ids": [],
        "updated_at": 1758200000,
    }, active, upcoming, tops, deals, soon


def src_of(v):
    """CDN bazı alanları bazen nesne bazen düz URL döndürür; ikisini de kabul et."""
    if isinstance(v, dict):
        return v.get("src")
    if isinstance(v, str) and v.strip():
        return v
    return None


def as_dict(v):
    """CDN alanları beklenen nesne yerine dize/liste döndürebilir; güvenli erişim."""
    return v if isinstance(v, dict) else {}


def as_list(v):
    return v if isinstance(v, list) else []


def build_detail(slug, country="TR"):
    """Rust fetch_store_offer_detail'in ürettiği şemayı taklit eder."""
    cdn = get(f"https://store-content-ipv4.ak.epicgames.com/api/tr-TR/content/products/{slug}")
    pages = as_list(cdn.get("pages"))
    home = next((p for p in pages if as_dict(p).get("_slug") == "home"), None) or (pages[0] if pages else {})
    d = as_dict(as_dict(home).get("data"))
    about = as_dict(d.get("about"))
    meta = as_dict(d.get("meta"))
    hero = as_dict(d.get("hero"))
    reqs = as_dict(d.get("requirements"))

    media = []
    for it in as_list(as_dict(d.get("carousel")).get("items")):
        src = src_of(it.get("image"))
        if src:
            media.append({"kind": "image", "thumb": src, "full": src, "caption": None})
            continue
        rec = (it.get("video") or {}).get("recipes")
        if rec:
            try:
                parsed = json.loads(rec)
            except Exception:
                continue
            thumb = man = None
            # `recipes` JSON'u bazen beklenen iç içe diziler yerine düz değerler
            # içerir; her seviyede tip kontrolü yapılır.
            for _loc, arr in as_dict(parsed).items():
                for r in as_list(arr):
                    for o in as_list(as_dict(r).get("outputs")):
                        o = as_dict(o)
                        if o.get("key") == "thumbnail":
                            thumb = thumb or o.get("url")
                        if o.get("key") == "manifest":
                            man = man or o.get("url")
            if thumb:
                media.append({"kind": "trailer", "thumb": thumb, "full": man or "", "caption": None})

    reqs_out = []
    for s in as_list(reqs.get("systems")):
        details = []
        for x in as_list(as_dict(s).get("details")):
            t = (x.get("title") or "").strip()
            mn = (x.get("minimum") or "").strip() or None
            rc = (x.get("recommended") or "").strip() or None
            if not t or (not mn and not rc):
                continue
            details.append({"title": t, "minimum": mn, "recommended": rc})
        if details:
            reqs_out.append({"systemType": s.get("systemType") or "Windows", "details": details})

    links = []
    social = as_dict(d.get("socialLinks"))
    for k, lb in [("linkHomepage", "Resmi Site"), ("linkTwitter", "X / Twitter"),
                  ("linkFacebook", "Facebook"), ("linkYoutube", "YouTube"),
                  ("linkInstagram", "Instagram"), ("linkTwitch", "Twitch"), ("linkDiscord", "Discord")]:
        val = social.get(k)
        if isinstance(val, str) and val.strip():
            links.append({"label": lb, "url": val.strip()})

    return {
        "slug": slug,
        "media": media,
        "requirements": reqs_out,
        "languages": [x for x in as_list(reqs.get("languages")) if isinstance(x, str) and x.strip()],
        "platforms": [p for p in as_list(meta.get("platform")) if isinstance(p, str)],
        "genres": [],
        "features": [],
        "age_rating": None,
        "about_image": src_of(about.get("image")),
        "hero_logo": src_of(hero.get("logoImage")),
        "hero_wide": src_of(hero.get("backgroundImageUrl")),
        "about_short": str(about.get("shortDescription") or "").strip() or None,
        "links": links,
    }


def main():
    hub, active, upcoming, tops, deals, soon = build_hub()
    print("aktif:", [x["title"] for x in active])
    print("gelecek:", [x["title"] for x in upcoming])
    print("top:", len(tops), "deal:", len(deals), "soon:", len(soon))

    # Ürün detayları: CDN'i olan bir oyun + CDN'i OLMAYAN bir oyun (has_page_content=false)
    details = {}
    for slug in ["cyberpunk-2077", "grand-theft-auto-v", "satisfactory"]:
        try:
            details[slug] = build_detail(slug)
            print("detay ok:", slug, "medya:", len(details[slug]["media"]))
        except Exception as e:
            print("detay HATA:", slug, e)

    # Detay fixture'ı: egdata verisi + CDN içeriği birleşik (Rust'ın çıktısı gibi)
    def detail_for(item, slug=None):
        base = {
            "id": item["id"], "namespace": item["namespace"], "title": item["title"],
            "description": item["description"], "long_description": None,
            "cover": item["cover"], "wide_art": item["wide_art"],
            # StoreFreeGameItem'da `seller` alanı yoktur (Rust şeması)
            "screenshots": [], "developer": item.get("seller"), "publisher": item.get("seller"),
            "release_date": None,
            # StoreFreeGameItem'da bu alanların bir kısmı yoktur -> .get() kullan
            "original_price": item.get("original_price"), "discount_price": item.get("discount_price"),
            "discount_percentage": item.get("discount_percentage"), "currency": item.get("currency"),
            "product_slug": item.get("product_slug"), "url_slug": item.get("url_slug"), "page_slug": item.get("page_slug"),
            "tags": item.get("tags") or [], "is_in_wishlist": False, "is_in_cart": False,
            "genres": [], "features": [], "platforms": [], "age_rating": None,
            "about_image": None, "hero_logo": None, "media": [], "requirements": [],
            "languages": [], "links": [], "has_page_content": False, "resolved_slug": None,
        }
        if slug and slug in details:
            pg = details[slug]
            base.update({
                "screenshots": [m["full"] for m in pg["media"] if m["kind"] == "image"],
                "media": pg["media"], "requirements": pg["requirements"],
                "languages": pg["languages"], "platforms": pg["platforms"],
                "about_image": pg["about_image"], "hero_logo": pg["hero_logo"],
                "links": pg["links"], "has_page_content": bool(pg["media"] or pg["requirements"]),
                "resolved_slug": slug,
                "long_description": pg["about_short"],
            })
        return base

    detail_map = {}
    for it in tops + deals + soon + active:
        oid = it["id"]
        slug = None
        if "cyberpunk" in it["title"].lower():
            slug = "cyberpunk-2077"
        elif "grand theft" in it["title"].lower() or "gta" in it["title"].lower():
            slug = "grand-theft-auto-v"
        elif "satisfactory" in it["title"].lower():
            slug = "satisfactory"
        detail_map[oid] = detail_for(it, slug)

    # Kütüphane fixture'ı: "kütüphanede ama kurulu değil" rafını sınamak için.
    # Bu rafın kartları Epic offer kimliği DEĞİL, legendary appName taşır —
    # Efe'nin bildirdiği "sayfa açılmıyor" hatasının kaynağı buydu.
    lib_src = (tops + deals)[:14]
    library = []
    for i, it in enumerate(lib_src):
        library.append({
            "app_name": f"MockApp{i:02d}",
            "app_title": it["title"],
            "asset_infos": {},
            "base_urls": [],
            "metadata": {
                "description": it["description"] or "",
                "keyImages": [{"type": "DieselGameBoxTall", "url": it["cover"] or it["wide_art"]}],
            },
            "sidecar": None,
            "achievements": None,
        })

    fixtures = {
        "hub": hub,
        "details": detail_map,
        "library": library,
        "search": {q: [i for i in tops + deals if q.lower() in i["title"].lower()][:12] for q in ["cyberpunk", "grand", "satisf"]},
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(fixtures, f, ensure_ascii=False)

    # ÖNEMLİ: fixture'lar modül script'inden ÖNCE senkron yüklenmeli.
    # Aksi halde uygulama açılışı (bootEpic -> epic_cached_library) boş veriyle
    # çalışır ve mağaza/kütüphane boş çizilir — bu harness hatasıdır, uygulama hatası değil.
    with open("tools/store-check/fixtures.js", "w", encoding="utf-8") as f:
        f.write("window.__VERIFY_FIXTURES__ = ")
        json.dump(fixtures, f, ensure_ascii=False)
        f.write(";\n")

    print("yazildi:", OUT, len(json.dumps(fixtures)) // 1024, "KB")


if __name__ == "__main__":
    main()
