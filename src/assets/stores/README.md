# Store logos

One 64×64 PNG per embedded storefront, shown **only** next to the store name on the
Accounts and Integrations cards so the player can identify the store at a glance.
They are never used in the app chrome (the header storefront tabs stay text only)
and never as decoration.

Every mark is the property of its owner, downloaded from the owner's own service or
from Wikimedia Commons, and used here for identification only (nominative use). The
project claims no rights to them and is not affiliated with, endorsed by or
sponsored by any of these companies. See the Legal Notice in Settings → About.

| Store | Source | File |
| --- | --- | --- |
| Epic Games | Wikimedia Commons, `File:Epic Games logo.svg` (official mark) | `epic.png` |
| GOG | `store-static-modular.gog-statics.com/en/assets/favicons/apple-touch-icon-152x152.png` | `gog.png` |
| Steam | `store.steampowered.com/apple-touch-icon.png` | `steam.png` |
| Xbox | `www.xbox.com/favicon-512.png` | `xbox.png` |
| Battle.net | `shop.battle.net/static/favicon-192x192.png` | `battlenet.png` |
| Ubisoft | `store.ubisoft.com/.../images/favicon-96x96.png` (whitened, see below) | `ubisoft.png` |
| EA | Wikimedia Commons, `File:Electronic-Arts-Logo.svg` (official mark) | `ea.png` |

Epic Games and EA block direct asset downloads (403 / 404 to anything that is not a
browser), so their marks come from Wikimedia Commons' copies of the official files;
the Wikimedia API was queried for the thumbnail URL instead of guessing a path. All
seven were normalised to 64×64 (aspect ratio kept, transparent padding) so the cards
line up, then verified visually on a black contact sheet before being committed.

**Ubisoft is the one recoloured file.** Ubisoft publishes its mark as pure black
(measured brightness 0 on every favicon size), which is invisible on our black cards.
The official alpha silhouette is therefore filled white — the same variant the brand
uses on its own dark theme — with anti-aliasing preserved and the shape untouched.
Every other mark is used exactly as published, in its own colours, and each was
checked for readability on black. The Xbox mark looks "dark" in a naive brightness
average only because its official green is saturated, not dim; it reads clearly on
the card.

Trademark owners are named in `docs/DESIGN_SYSTEM.md` (brand-mark exception) and in
the Legal Notice shown in Settings → About.
