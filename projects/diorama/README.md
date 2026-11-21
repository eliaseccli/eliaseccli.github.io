# Diorama stills

WebP stills are the product (PNG originals were removed from the repo on 21 Nov 2026; they stay in git history). 1:1 day/night clay pairs. No UI chrome on the images.

Drop files in `stills/` using this name scheme:

    stills/diorama-<slug>-day.webp
    stills/diorama-<slug>-night.webp

Then list them in `stills.json` (array of places; one carousel slot per slug):

    [
      {
        "slug": "ushi",
        "title": "Place name",
        "date": "",
        "day": "stills/diorama-ushi-day.webp",
        "night": "stills/diorama-ushi-night.webp"
      }
    ]

`date` is the source photo capture date (EXIF DateTimeOriginal), not the upload day.
Use `YYYY-MM-DD` or EXIF `YYYY:MM:DD HH:MM:SS`. Leave `""` if unknown — do not invent.
It shows next to the place name when present.
Swipe order is newest capture date first; stills with no date sit at the back. Do not invent dates to change order.

If `day` / `night` are omitted, paths are inferred from `slug` with the same WebP pattern.
PNG or JPEG paths listed explicitly still work.
Empty array ships as the v1 void. Do not invent a first scene.

First view follows the viewer's local clock (night 19:00–06:59). Tap the still to flip day/night; swipe still swipes. Clock does not lock after that.

Stills are cutouts with real alpha (WebP keeps it): keep the object (pod, lamps, signs, trees). Street, cobbles, sky, and distant buildings are transparent. Not a rectangle photo.
